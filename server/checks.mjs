/**
 * 账户体检（一键检查）。
 *
 * 设计要点，和手册逐条对应：
 *   · 每一项检查独立成段，各自带退出码 —— 坏了能明确指出来是哪条命令报的什么错，
 *     而不是给一个笼统的“异常”。
 *   · 全部命令都不需要 root：`lxc exec` 在成员上以 lxd 组身份就能进容器。
 *   · 判定 GPU 时必须和**容器所在成员**的驱动比，不能和发起 SSH 的那台比。
 *     （2026-10-18 实测：s0=580.126.09、s3/s4/s6/s7/s8=580.142、s1/s2/s5=550.100，
 *     `teacher-demo` 在 s8，uvm 主编号 510 恰好等于 s8 的 510 —— 和 s0 比就会误报。）
 *   · 失败项只生成修复命令，绝不代执行；驱动安装文件按容器里实际存在的 .run 来选。
 */

import { splitSections } from './collect.mjs'
import { parseInstances } from './lxd.mjs'
import { exec, withConnection } from './ssh.mjs'

const NAME_RE = /^[A-Za-z0-9._-]+$/

/** POSIX sh 单引号转义。检查命令里允许出现单引号，靠这个兜住。 */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/* ------------------------------------------------------------------ *
 * 检查项注册表
 * ------------------------------------------------------------------ */

export const CHECKS = [
  {
    id: 'gpu',
    title: '显卡驱动一致性',
    run: 'container',
    group: 'GPU',
    timeout: 30,
    manual: '手册「安装显卡驱动」：容器里必须带 --no-kernel-module，且版本要和宿主机一致',
    cmd: 'nvidia-smi --query-gpu=driver_version --format=csv,noheader',
  },
  {
    id: 'nodes',
    title: 'GPU 设备节点主编号',
    run: 'container',
    group: 'GPU',
    timeout: 20,
    manual: '手册「nvidia-uvm 修复三步」；2026.1.3 那次 torch.cuda.is_available() 为 False 就是这里',
    cmd: "stat -c '%n %t' /dev/nvidia0 /dev/nvidiactl /dev/nvidia-uvm",
  },
  {
    id: 'cuda',
    title: 'CUDA 挂载是否可用',
    run: 'container',
    group: 'GPU',
    timeout: 25,
    manual: 'default profile 把 /mnt/nas/CUDA/cuda-* 只读挂进容器，NAS 一掉这些目录就空',
    cmd: 'for d in /usr/local/cuda-*; do [ -d "$d" ] || continue; if [ -z "$(ls -A "$d" 2>/dev/null)" ]; then echo "EMPTY $d"; else echo "OK $d"; fi; done',
  },
  {
    id: 'disk',
    title: '根盘用量 vs 配额',
    run: 'container',
    group: '空间',
    timeout: 20,
    manual: '手册里有一次事故根因就是 500GB 配额写满了',
    cmd: 'df -kP /',
  },
  {
    id: 'ssh',
    title: '容器内 SSH 服务',
    run: 'container',
    group: '服务',
    timeout: 25,
    manual: '手册「设置SSH连接」：改完 sshd_config 有时不生效，连本地回环都被拒',
    cmd: 'echo RUN=$(pgrep -x sshd | wc -l); sshd -T 2>/dev/null | grep -i "^passwordauthentication" || echo PASSAUTH=unknown',
  },
  {
    id: 'tmux',
    title: 'tmux 是否可用',
    run: 'container',
    group: '服务',
    timeout: 15,
    manual: '手册「账户迁移」硬要求：迁移必须在 tmux 里跑，断线会中断迁移',
    cmd: 'command -v tmux || echo MISSING',
  },
  {
    id: 'net',
    title: '出网与 DNS',
    run: 'container',
    group: '网络',
    timeout: 30,
    manual: '手册 2025.10.28：conda/pip 报 SSL 无法访问，可在终端临时挂代理',
    cmd: 'getent hosts mirrors.tuna.tsinghua.edu.cn >/dev/null 2>&1 && echo DNS=ok || echo DNS=fail; curl -m 8 -sS -o /dev/null -w "HTTP=%{http_code}\\n" https://pypi.org 2>&1 || echo HTTP=fail',
  },
  {
    id: 'proc',
    title: '僵尸与残留进程',
    run: 'container',
    group: '进程',
    timeout: 20,
    manual: '手册「杀进程」：ps aux|grep python 找僵尸进程再 kill -9',
    cmd: 'echo ZOMBIE=$(ps --no-headers -eo stat 2>/dev/null | grep -c "^Z"); echo PYTHON=$(ps --no-headers -eo comm 2>/dev/null | grep -c "^python"); echo TOTAL=$(ps --no-headers -e 2>/dev/null | wc -l)',
  },
  {
    id: 'torch',
    title: 'torch 能否看到 GPU（慢，默认不跑）',
    run: 'container',
    group: 'GPU',
    timeout: 120,
    optIn: true,
    manual: '最终判据；前面几项一致而这里 False，一般是环境变量或 CUDA 版本问题',
    cmd: "python3 -c 'import torch; print(\"CUDA=\" + str(torch.cuda.is_available()))' 2>&1 || echo TORCH_FAIL",
  },
]

const BY_ID = new Map(CHECKS.map((c) => [c.id, c]))

/** 修驱动用的安装器（容器里能看到的那份），不当作检查项，只当事实。 */
const INSTALLER_CMD = 'ls -1 /home/ubuntu/shared/NVIDIA-Linux-x86_64*.run /mnt/nas/shared/NVIDIA-Linux-x86_64*.run 2>/dev/null'

const FACT_LINES = [
  'echo "member=$(hostname)"',
  'echo "kernel=$(uname -r)"',
  'echo "driver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)"',
  'echo "gpu_count=$(nvidia-smi -L 2>/dev/null | wc -l)"',
  'echo "gpu_names=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | tr "\\n" ";")"',
  'echo "uvm_major=$(grep -w nvidia-uvm /proc/devices 2>/dev/null | head -1 | cut -d\' \' -f1)"',
  'echo "uvm_node=$(stat -c "%t" /dev/nvidia-uvm 2>/dev/null)"',
  'echo "nvml_error=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>&1 | head -1)"',
  'echo "lxd=$(lxc version 2>/dev/null | grep -i "^server version" | tr -s " " | cut -d" " -f3)"',
]

/* ------------------------------------------------------------------ *
 * 生成远端脚本
 * ------------------------------------------------------------------ */

export function resolveCheckIds({ ids, includeSlow = false } = {}) {
  if (Array.isArray(ids) && ids.length) {
    return ids.map((id) => BY_ID.get(id)).filter(Boolean)
  }
  return CHECKS.filter((c) => includeSlow || !c.optIn)
}

export function unknownCheckIds(ids) {
  if (!Array.isArray(ids)) return []
  return ids.filter((id) => !BY_ID.has(id))
}

export function buildCheckScript(container, opts = {}) {
  const name = String(container || '')
  if (!NAME_RE.test(name)) throw new Error(`非法容器名: ${name}`)
  const checks = resolveCheckIds(opts)

  const lines = ['export LC_ALL=C', `C=${shQuote(name)}`, 'echo "@@SEC:FACTS"', ...FACT_LINES]

  lines.push('echo "@@SEC:INSTALLERS"')
  lines.push(`timeout 20 lxc exec "$C" -- sh -c ${shQuote(INSTALLER_CMD)} </dev/null 2>&1 | head -12`)

  for (const c of checks) {
    lines.push(`echo "@@SEC:${c.id}"`)
    const inner =
      c.run === 'container'
        ? `timeout ${c.timeout} lxc exec "$C" -- sh -c ${shQuote(c.cmd)} </dev/null 2>&1`
        : `timeout ${c.timeout} sh -c ${shQuote(c.cmd)} 2>&1`
    lines.push(inner)
    lines.push('echo "@@RC=$?"')
  }
  lines.push('echo "@@SEC:END"')
  return `${lines.join('\n')}\n`
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

export function parseCheckOutput(stdout) {
  const raw = splitSections(stdout || '')
  const out = {}
  for (const [id, lines] of Object.entries(raw)) {
    const body = lines.slice()
    let rc = null
    while (body.length && body[body.length - 1].startsWith('@@RC=')) {
      rc = Number(body[body.length - 1].slice(5))
      body.pop()
    }
    out[id] = { rc, out: body.join('\n'), lines: body }
  }
  return out
}

export function parseFacts(lines = []) {
  const f = {}
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq === -1) continue
    f[line.slice(0, eq)] = line.slice(eq + 1).trim()
  }
  f.driver = f.driver || ''
  f.uvmMajor = Number(f.uvm_major) || null
  f.uvmNodeMajor = f.uvm_node ? parseInt(f.uvm_node, 16) : null
  f.gpuCount = Number(f.gpu_count) || 0
  return f
}

/** 驱动主编号：容器里 stat 出来的是十六进制 %t */
function hexMajor(s) {
  const n = parseInt(String(s || '').trim(), 16)
  return Number.isFinite(n) ? n : null
}

/* ------------------------------------------------------------------ *
 * 修复命令生成（只生成，不执行）
 * ------------------------------------------------------------------ */

const DRIVER_FILES = {
  s0: 'NVIDIA-Linux-x86_64-V100.run',
}

/**
 * 按容器里实际存在的 .run 选安装器。
 * 优先级：成员专用（s0=V100）→ 文件名里带宿主驱动版本 → CUDA 13.0 那份 -2.run → 任意一份。
 */
export function pickInstaller({ member, hostDriver, installers = [] }) {
  // 只认 NVIDIA-Linux-x86_64*.run；同目录里还有 cuda_*.run 那种工具包安装器，
  // 拿它修驱动是错的（文件名里也带版本号，按系列模糊匹配会撞上）。
  // 共享目录里的文件名是不可信输入：只接受规整的驱动安装器名，
  // 免得 `xxx.run; evil` 这种被当成命令粘进终端
  const files = installers.filter((p) => /^\/[A-Za-z0-9._/-]*NVIDIA-Linux-x86_64[A-Za-z0-9._-]*\.run$/.test(String(p)))
  if (files.length === 0) return null
  const wanted = DRIVER_FILES[member]
  if (wanted) {
    const hit = files.find((p) => p.includes(wanted))
    if (hit) return hit
  }
  if (hostDriver) {
    const exact = files.find((p) => p.includes(hostDriver))
    if (exact) return exact
    const series = files.find((p) => p.includes(hostDriver.split('.')[0]))
    if (series) return series
  }
  return files.find((p) => p.endsWith('NVIDIA-Linux-x86_64-2.run')) || files[0]
}

export function gpuFixCommands(ctx) {
  const target = pickInstaller(ctx)
  const cmds = []
  if (target) {
    cmds.push(`bash ${target} --no-kernel-module --silent`)
    cmds.push('nvidia-smi -L')
  } else {
    cmds.push('# 容器里没找到任何 .run 安装器，先确认共享盘已挂上：ls /home/ubuntu/shared/*.run')
    cmds.push('# 宿主机侧备份：scp -C -r -P 2222 s0@10.0.0.10:/mnt/nas/shared/NVIDIA-Linux-x86_64.run ./')
  }
  return cmds
}

export function nodeFixCommands(ctx) {
  const major = ctx.hostUvmMajor
  return [
    `# 宿主机（${ctx.member}）上确认模块与主编号`,
    'sudo modprobe nvidia-uvm',
    'grep -w nvidia-uvm /proc/devices',
    major ? `sudo mknod -m 666 /dev/nvidia-uvm c ${major} 0` : 'sudo mknod -m 666 /dev/nvidia-uvm c <上面的主编号> 0',
    `# 再让容器重新拿到这个节点（${ctx.container}）`,
    `lxc device remove ${ctx.container} nvidia-uvm && lxc device add ${ctx.container} nvidia-uvm unix-char path=/dev/nvidia-uvm`,
  ]
}

/* ------------------------------------------------------------------ *
 * 判定
 * ------------------------------------------------------------------ */

const NVML_MISMATCH = /Failed to initialize NVML: Driver\/library version mismatch/
const NVML_LIB = /NVML library version:\s*([0-9.]+)/
const DEVICE_HANDLE = /Unable to determine the device handle for GPU/

export function judgeCheck(check, section, ctx) {
  const out = (section?.out ?? '').toString()
  const lines = (section?.lines ?? []).filter((l) => l !== '')
  const rc = section?.rc ?? null

  // 容器没在跑：lxc exec 一定失败，这不是故障
  if (ctx.containerStatus && ctx.containerStatus !== 'Running') {
    return {
      status: 'skip',
      detail: `容器状态是 ${ctx.containerStatus}，lxc exec 进不去；要先 lxc start ${ctx.container}`,
      commands: [`lxc start ${ctx.container}`],
    }
  }

  if (rc === 124) {
    return { status: 'error', detail: `这条命令跑了 ${check.timeout}s 还没结束（被 timeout 掐掉）`, commands: [] }
  }

  switch (check.id) {
    case 'gpu': {
      if (ctx.hostDriverBroken) {
        return {
          status: 'fail',
          detail: `${ctx.member} 宿主机自己的 nvidia-smi 就报错（${ctx.hostNvmlError}），这台上的容器怎么装驱动都没用`,
          commands: [`# ${ctx.member} 上先确认：nvidia-smi`, '# 手册 2025.9.19 的处理：先 reboot，不行就断电强制关机再开'],
        }
      }
      if (DEVICE_HANDLE.test(out)) {
        return {
          status: 'fail',
          detail: '宿主侧报 "Unable to determine the device handle"，是卡本身或 PCIe 的问题（手册 2025.9.19）',
          commands: [`# ${ctx.member} 上：nvidia-smi 看一下；不行就只能强制关机重启`],
        }
      }
      const m = out.match(NVML_LIB)
      if (NVML_MISMATCH.test(out)) {
        const lib = m ? m[1] : '未知'
        return {
          status: 'fail',
          detail: `容器内 NVML 库 ${lib}，${ctx.member} 宿主驱动 ${ctx.hostDriver || '未知'} —— 版本不一致，nvidia-smi / torch 全用不了`,
          commands: gpuFixCommands({ ...ctx, library: lib }),
        }
      }
      const containerDriver = lines[0] || ''
      if (!containerDriver) {
        return { status: 'fail', detail: `nvidia-smi 没输出（rc=${rc}）${out ? `：${out.slice(0, 160)}` : ''}`, commands: gpuFixCommands(ctx) }
      }
      if (ctx.hostDriver && containerDriver !== ctx.hostDriver) {
        return {
          status: 'fail',
          detail: `容器内看到 ${containerDriver}，${ctx.member} 宿主是 ${ctx.hostDriver}`,
          commands: gpuFixCommands(ctx),
        }
      }
      return {
        status: 'pass',
        detail: `驱动 ${containerDriver} 与 ${ctx.member} 宿主一致${ctx.gpuCount ? `，可见 ${lines.length}/${ctx.gpuCount} 张卡` : ''}`,
        commands: [],
      }
    }

    case 'nodes': {
      const map = new Map()
      for (const l of lines) {
        const [p, major] = l.trim().split(/\s+/)
        if (p && major) map.set(p, hexMajor(major))
      }
      const uvm = map.get('/dev/nvidia-uvm')
      if (!map.size) {
        return { status: 'fail', detail: '容器里一个 /dev/nvidia* 节点都没有', commands: nodeFixCommands(ctx) }
      }
      if (uvm == null) {
        return { status: 'fail', detail: '容器里没有 /dev/nvidia-uvm，torch 一定拿不到卡', commands: nodeFixCommands(ctx) }
      }
      if (ctx.hostUvmMajor == null) {
        return { status: 'warn', detail: `容器里 uvm 主编号是 ${uvm}，但宿主 /proc/devices 读不到 nvidia-uvm，没法判断是否一致`, commands: [`# ${ctx.member} 上确认：grep -w nvidia-uvm /proc/devices`, 'lsmod | grep nvidia_uvm'] }
      }
      if (uvm !== ctx.hostUvmMajor) {
        return {
          status: 'fail',
          detail: `容器内 /dev/nvidia-uvm 主编号 ${uvm}，${ctx.member} 宿主是 ${ctx.hostUvmMajor} —— 这个节点是从上一次开机带过来的（手册 2026.1.3）`,
          commands: nodeFixCommands(ctx),
        }
      }
      if (!map.has('/dev/nvidia0') && ctx.gpuCount > 0) {
        return { status: 'warn', detail: '没有 /dev/nvidia0，只有控制节点；单卡直通时正常，多卡机器上要注意', commands: [] }
      }
      return { status: 'pass', detail: `nvidia0/nvidiactl/nvidia-uvm 都在，uvm=${uvm} 与宿主一致`, commands: [] }
    }

    case 'cuda': {
      if (rc !== 0) {
        return { status: 'error', detail: `检查命令没跑成（rc=${rc}）：${out.slice(0, 140) || '无输出'}`, commands: [] }
      }
      const empty = lines.filter((l) => l.startsWith('EMPTY'))
      const ok = lines.filter((l) => l.startsWith('OK'))
      if (lines.length === 0) {
        return { status: 'warn', detail: '容器里没有 /usr/local/cuda-* 目录', commands: [`lxc profile show default  # 看 cuda* 设备`] }
      }
      if (empty.length) {
        return {
          status: 'fail',
          detail: `${empty.length} 个 CUDA 挂载是空目录：${empty.map((l) => l.slice(6)).join(', ')} —— ${ctx.member} 的 /mnt/nas 没挂上或 profile source 路径变了`,
          commands: [`# ${ctx.member} 上：mount | grep nas; ls /mnt/nas/CUDA`, `sudo systemctl restart autostart.service  # 手册：auto_boot.sh 负责挂 NAS`],
        }
      }
      return { status: 'pass', detail: `${ok.length} 个 CUDA 目录都有内容`, commands: [] }
    }

    case 'disk': {
      const last = lines[lines.length - 1] || ''
      const nums = last.trim().split(/\s+/).filter((n) => /^\d+$/.test(n))
      if (nums.length < 3) return { status: 'error', detail: `df 输出读不懂：${last}`, commands: [] }
      const [total, used] = nums.map((n) => Number(n) * 1024)
      const pct = total > 0 ? Math.round((used / total) * 1000) / 10 : null
      const quotaPct = ctx.quotaPercent ?? pct
      const shown = `已用 ${(used / 1024 ** 3).toFixed(1)} GiB / ${(total / 1024 ** 3).toFixed(1)} GiB（${pct}%）`
      if (quotaPct != null && quotaPct >= 90) {
        return {
          status: 'fail',
          detail: `${shown} —— 配额快满了，手册里那次事故就是这么来的`,
          commands: [`lxc config device set ${ctx.container} root size=${Math.ceil(((ctx.quotaBytes || total) / 1024 ** 3) * 1.25)}GiB`],
        }
      }
      if (quotaPct != null && quotaPct >= 80) return { status: 'warn', detail: shown, commands: [] }
      return { status: 'pass', detail: shown, commands: [] }
    }

    case 'ssh': {
      const run = Number((lines.find((l) => l.startsWith('RUN=')) || '').slice(4)) || 0
      const auth = (lines.find((l) => l.startsWith('passwordauthentication')) || '').split(/\s+/)[1] || ''
      if (!run) {
        return {
          status: 'fail',
          detail: '容器里没有 sshd 进程，外面 ssh 不进来',
          commands: ['service ssh restart', 'pkill -f sshd; /usr/sbin/sshd -f /etc/ssh/sshd_config'],
        }
      }
      if (auth !== 'yes') {
        return {
          status: 'warn',
          detail: `sshd 在跑但 PasswordAuthentication=${auth || '读不到'}，配了密钥之外的登录方式可能用不了`,
          commands: ['grep -i passwordauthentication /etc/ssh/sshd_config'],
        }
      }
      return { status: 'pass', detail: `sshd 在跑（${run} 个进程），PasswordAuthentication=yes`, commands: [] }
    }

    case 'tmux': {
      if (lines.some((l) => l === 'MISSING') || !lines.length) {
        return {
          status: 'warn',
          detail: '没有 tmux —— 迁移账户前必须装（手册：迁移中断会丢数据）',
          commands: ['apt-get update && apt-get install -y tmux'],
        }
      }
      return { status: 'pass', detail: lines[0], commands: [] }
    }

    case 'net': {
      const dns = lines.find((l) => l.startsWith('DNS=')) || 'DNS=?'
      const http = lines.find((l) => l.startsWith('HTTP=')) || ''
      const code = (http.match(/HTTP=(\d+)/) || [])[1]
      if (dns === 'DNS=fail') {
        return { status: 'fail', detail: `域名解析失败（${dns}），https 探测：${http || '无结果'}`, commands: proxyCommands(ctx) }
      }
      if (!code) {
        return {
          status: 'fail',
          detail: `DNS 正常但 https://pypi.org 连不上：${out.replace(/\n/g, ' ').slice(0, 160)}`,
          commands: proxyCommands(ctx),
        }
      }
      return { status: 'pass', detail: `DNS ok，https://pypi.org → ${code}`, commands: [] }
    }

    case 'proc': {
      const get = (k) => Number((lines.find((l) => l.startsWith(`${k}=`)) || '').split('=')[1]) || 0
      const z = get('ZOMBIE')
      const py = get('PYTHON')
      const total = get('TOTAL')
      if (z > 3) {
        return {
          status: 'warn',
          detail: `僵尸进程 ${z} 个（共 ${total} 个进程，python ${py} 个）`,
          commands: ['ps -eo stat,pid,etime,cmd --no-headers | grep "^Z"', 'kill -9 <PID>'],
        }
      }
      return { status: 'pass', detail: `进程 ${total} 个，python ${py} 个，僵尸 ${z} 个`, commands: [] }
    }

    case 'torch': {
      if (/CUDA=True/.test(out)) return { status: 'pass', detail: 'torch.cuda.is_available() = True', commands: [] }
      if (/CUDA=False/.test(out)) {
        return {
          status: 'fail',
          detail: 'torch 起来了但看不到卡。上面 GPU 两项都 pass 的话，多半是容器里 CUDA 版本和 torch 编译版本不匹配',
          commands: ['python3 -c "import torch;print(torch.version.cuda, torch.__version__)"', 'nvcc --version 2>/dev/null || ls /usr/local/cuda*'],
        }
      }
      return { status: 'skip', detail: `没跑成：${out.slice(0, 120) || '容器里可能没有 python3/torch'}`, commands: [] }
    }

    default:
      return { status: rc === 0 ? 'pass' : 'error', detail: out.slice(0, 200), commands: [] }
  }
}

function proxyCommands(_ctx) {
  return [
    '# 手册 2025.10.28：临时挂代理（宿主 s8 上 clash 在跑时才有效）',
    'export http_proxy="http://192.168.1.18:7899"',
    'export https_proxy="http://192.168.1.18:7899"',
    '# 关掉：unset http_proxy https_proxy',
  ]
}

/* ------------------------------------------------------------------ *
 * 跑一个容器的体检
 * ------------------------------------------------------------------ */

export async function checkContainer({ server, container, ids, includeSlow = false, facts, installers, quotaBytes, quotaPercent, hostDriverOverride }) {
  const script = buildCheckScript(container.name, { ids, includeSlow })
  const run = await withConnection(server, (conn) => exec(conn, script, 180000))
  const parsed = parseCheckOutput(run.stdout)
  const hostFacts = facts || parseFacts(parsed.FACTS?.lines || [])
  const installersList = (parsed.INSTALLERS?.lines || installers || []).filter((p) => p.endsWith('.run'))
  const hostDriver = hostDriverOverride ?? hostFacts.driver ?? ''
  // 宿主自己读不到卡时（2025.9.19 s0 那次），driver 为空而 nvml_error 是段报错文字。
  // 这种情况要归因到宿主，不能挨个冤枉容器。
  const hostNvmlError = (hostFacts.nvml_error || '').trim()
  const hostDriverBroken = !hostDriver && hostNvmlError !== '' && !/^[\d.]+$/.test(hostNvmlError)
  const ctx = {
    container: container.name,
    containerStatus: container.status,
    member: hostFacts.member || server.id,
    hostDriver,
    hostNvmlError,
    hostDriverBroken,
    hostUvmMajor: hostFacts.uvmMajor ?? null,
    gpuCount: hostFacts.gpuCount || 0,
    installers: installersList,
    quotaBytes: quotaBytes ?? null,
    quotaPercent: quotaPercent ?? null,
  }
  const selected = resolveCheckIds({ ids, includeSlow })
  const results = selected.map((check) => {
    const section = parsed[check.id] || { rc: null, out: '', lines: [] }
    const judged = judgeCheck(check, section, { ...ctx, library: null })
    return {
      id: check.id,
      title: check.title,
      group: check.group,
      manual: check.manual,
      command: check.cmd,
      rc: section.rc,
      output: section.out.slice(0, 800),
      ...judged,
    }
  })
  return {
    container: container.name,
    server: server.id,
    member: ctx.member,
    status: container.status,
    facts: hostFacts,
    hostDriver,
    hostDriverBroken,
    installers: installersList,
    ranAt: new Date().toISOString(),
    exitCode: run.code,
    stderr: (run.stderr || '').split(/\r?\n/).filter(Boolean).slice(0, 3).join(' | '),
    results,
    verdict: rollUp(results),
  }
}

export function rollUp(results) {
  // 一项都没跑（比如传了不存在的检查 id）时不能算"通过"
  if (!results.length) return 'skip'
  if (results.some((r) => r.status === 'fail')) return 'fail'
  if (results.some((r) => r.status === 'error')) return 'error'
  if (results.some((r) => r.status === 'warn')) return 'warn'
  if (results.length && results.every((r) => r.status === 'skip')) return 'skip'
  return 'pass'
}

/* ------------------------------------------------------------------ *
 * 找容器落在哪台成员上
 *
 * 任一成员上的 lxc list 都会返回**整个集群**，所以必须按 location 过滤；
 * 两台集群（s0+s3–s8 / s1+s2）互不见面，得分别问。
 * ------------------------------------------------------------------ */

export async function discoverContainers(server) {
  const { stdout } = await withConnection(server, (conn) =>
    exec(conn, 'lxc list --format=json 2>/dev/null | tr -d "\\n"', 40000),
  )
  return parseInstances(stdout).filter((i) => !i.location || i.location === server.id)
}

export async function fleetInventory(servers) {
  const perHost = await Promise.all(
    servers.map(async (s) => {
      try {
        return await discoverContainers(s)
      } catch (err) {
        return [{ name: '', location: s.id, status: '', error: err.message }]
      }
    }),
  )
  const out = []
  perHost.forEach((list, idx) => {
    for (const inst of list) {
      if (inst.error) {
        out.push({ name: null, server: servers[idx].id, status: 'unreachable', error: inst.error })
        continue
      }
      out.push({ ...inst, server: servers[idx].id, location: inst.location || servers[idx].id })
    }
  })
  return out
}

/**
 * 按范围跑体检。每个成员一条连接，成员之间并行、成员内部串行
 * （同一条连接上并发 43 个 lxc exec 会把远端 sshd 打满）。
 */
export async function runChecks({ servers, container, server: serverId, scope = 'container', ids, includeSlow = false, enrich = new Map(), onProgress = () => {} }) {
  const byId = new Map(servers.map((s) => [s.id, s]))
  let targets = []
  const errors = []

  if (scope === 'container' || container) {
    const want = String(container || '')
    if (!NAME_RE.test(want)) throw new Error(`非法容器名: ${want}`)
    const hint = serverId ? byId.get(serverId) : null
    const hosts = hint ? [hint] : servers
    const found = await Promise.all(hosts.map((s) => discoverContainers(s).catch(() => [])))
    for (const list of found) {
      for (const inst of list) if (inst.name === want) targets.push(inst)
    }
    if (!targets.length) throw new Error(`没找到容器 ${want}（问遍了 ${hosts.map((h) => h.id).join('、')}）`)
  } else {
    const hosts = scope === 'server' ? [byId.get(serverId)].filter(Boolean) : servers
    if (hosts.length === 0) throw new Error(`未知服务器 ${serverId}`)
    const lists = await Promise.all(
      hosts.map(async (s) => {
        try {
          return await discoverContainers(s)
        } catch (err) {
          errors.push({ server: s.id, error: err.message || String(err) })
          return []
        }
      }),
    )
    targets = lists.flat()
  }

  const groups = new Map()
  for (const t of targets) {
    const s = byId.get(t.location) || byId.get(t.server) || servers[0]
    if (!groups.has(s.id)) groups.set(s.id, { server: s, items: [] })
    groups.get(s.id).items.push(t)
  }

  const total = targets.length
  let done = 0
  const items = []

  await Promise.all(
    [...groups.values()].map(async ({ server, items: list }) => {
      for (const inst of list) {
        const extra = enrich.get(inst.name) || {}
        try {
          const res = await checkContainer({
            server,
            container: inst,
            ids,
            includeSlow,
            quotaBytes: extra.quotaBytes,
            quotaPercent: extra.usedPercent,
          })
          items.push(res)
        } catch (err) {
          items.push({
            container: inst.name,
            server: server.id,
            member: inst.location || server.id,
            status: inst.status,
            results: [],
            verdict: 'error',
            error: err.message || String(err),
            ranAt: new Date().toISOString(),
          })
        }
        done += 1
        onProgress({ done, total, last: items[items.length - 1] })
      }
    }),
  )

  items.sort((a, b) => String(a.container).localeCompare(String(b.container)))
  return { items, errors, total, done }
}
