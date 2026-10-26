#!/usr/bin/env node
/**
 * 给采集器开一条**只读**的 zfs 通道。
 *
 * 刻意不做的事：不配 NOPASSWD ALL，不把密码写进任何文件，不改 /dev/zfs 权限。
 * 做的事（每台一次 sudo，密码只经 SSH 通道喂给 sudo -S，不上命令行）：
 *   1. 找到这台机器可用的 zfs/zpool（系统包，或 LXD snap 自带那份）
 *   2. 建固定软链 /usr/local/sbin/srvman-{zfs,zpool}
 *   3. 写 /etc/sudoers.d/srvman-readonly，只放行 `... list*` 这类只读子命令
 *   4. 先 visudo -cf 校验，通过了才 mv 成正式文件名
 *
 *   npm run setup-root -- --check      只看现状，不改任何东西
 *   npm run setup-root                 交互输入密码并安装
 *   npm run setup-root -- --only s0    只处理部分机器
 */
import fs from 'node:fs'
import { CONFIG, loadServers } from '../server/config.mjs'
import { askHidden, sshRun } from './prompt.mjs'

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',').map((s) => s.trim()) : null
const checkOnly = args.includes('--check')
const uninstall = args.includes('--uninstall')
const installPkg = args.includes('--install-pkg')
const privateKey = CONFIG.apiKey && fs.existsSync(CONFIG.apiKey) ? fs.readFileSync(CONFIG.apiKey) : undefined

/**
 * 判断 zfs 二进制本身是否完好。
 *
 * 关键教训：不能用 `zfs version` 当探针 —— zfs 的**任何**子命令都要打开
 * /dev/zfs，非 root 下统一失败（"must be run as root"），那会被误判成程序损坏，
 * 从而在只差“授权”这一步时提前放弃。所以这里只看“存在 + 共享库齐不齐”，
 * “要不要 root”交给 CHECK_PRIV 去区分。
 */
const DISCOVER = String.raw`
zfs_intact() {
  [ -x "$1" ] || return 1
  ldd "$1" 2>/dev/null | grep -q "not found" && return 1
  return 0
}
find_zfs() {
  for c in /sbin/zfs /usr/sbin/zfs /usr/bin/zfs /usr/local/sbin/srvman-zfs; do
    zfs_intact "$c" && { echo "$c"; return; }
  done
  # 都不完整时，报一个“存在但缺库”的路径，便于诊断
  for c in /sbin/zfs /usr/local/sbin/srvman-zfs $(ls -d /snap/lxd/*/zfs-*/bin/zfs 2>/dev/null | sort -r); do
    [ -x "$c" ] && { echo "$c"; return; }
  done
}
ZFS=$(find_zfs)
BROKEN=1
[ -n "$ZFS" ] && zfs_intact "$ZFS" && BROKEN=0
`

const FIND_BINS = DISCOVER + String.raw`
echo "ZFS_RUNNABLE=$([ "$BROKEN" = 0 ] && echo 1 || echo 0)"
echo "USER=$(id -nu)"
echo "DEVZFS=$(stat -c '%A' /dev/zfs 2>/dev/null || echo missing)"
echo "ZFS_PATH=$ZFS"
echo "HAS_APT=$(command -v apt-get >/dev/null && echo yes || echo no)"
`

/**
 * 状态含义：
 *   PLAIN_OK     不用 root 就能读（/dev/zfs 权限放开过）
 *   SUDO_OK      通过只读 sudoers 授权后能读 —— 这是我们想要的终态
 *   NEED_SUDOERS 二进制完好，但还没授权；跑 setup-root 就能补上
 *   BIN_BROKEN   二进制缺共享库（例如 snap 里那份缺 libcrypto.so.1.1）
 *   NO_ZFS_BIN   机器上没有 zfs 命令行程序
 */
const CHECK_PRIV = DISCOVER + String.raw`
if [ -z "$ZFS" ]; then echo "NO_ZFS_BIN"; exit 0; fi
if [ "$BROKEN" = 1 ]; then echo "BIN_BROKEN"; exit 0; fi
if [ "$(id -u)" = "0" ]; then echo "IS_ROOT"; exit 0; fi
if "$ZFS" list -H -o name >/dev/null 2>&1; then echo "PLAIN_OK"; exit 0; fi
if sudo -n "$ZFS" list -H -o name >/dev/null 2>&1; then echo "SUDO_OK"; exit 0; fi
ERR=$(sudo -n "$ZFS" list -H -o name 2>&1 || true)
if echo "$ERR" | grep -qiE "a password is required|not in the sudoers file|must be run as root"; then
  echo "NEED_SUDOERS"; exit 0
fi
echo "OTHER: $(echo "$ERR" | head -1 | cut -c1-70)"
`

/**
 * 需要 root 的部分，只调用一次 sudo。
 * 注意：不要对指向 snap squashfs 的软链做 chmod —— 那必定是只读文件系统，
 * 在 set -e 下会把已经成功的安装整个中断掉（上一版就是这么坏的）。
 */
function rootPayload(zfsPath, zpoolPath, user) {
  const link = (target, name) =>
    target === name ? `# 已指向 ${name}，跳过` : `ln -sf '${target}' '${name}'`
  const allowed = [...new Set([
    '/usr/local/sbin/srvman-zfs list*',
    '/usr/local/sbin/srvman-zpool list*',
    zfsPath && `${zfsPath} list*`,
    zpoolPath && `${zpoolPath} list*`,
  ].filter(Boolean))]
  const rule = `${user} ALL=(root) NOPASSWD: ${allowed.join(', ')}`

  return [
    'set -e',
    'T=/etc/sudoers.d/.srvman-readonly.new',
    `cat > "$T" << 'EOFSUDO'`,
    '# server-manager 只读磁盘用量采集用；删除本文件即撤销授权。',
    rule,
    'EOFSUDO',
    'chmod 0440 "$T"',
    'chown root:root "$T"',
    'visudo -cf "$T"',
    'mv -f "$T" /etc/sudoers.d/srvman-readonly',
    link(zfsPath, '/usr/local/sbin/srvman-zfs'),
    link(zpoolPath, '/usr/local/sbin/srvman-zpool'),
    'echo ROOT_DONE',
  ].join('\n')
}

const UNINSTALL = String.raw`
set -e
S=$(mktemp)
trap 'rm -f "$S"' EXIT INT TERM
cat > "$S" << 'EOFPAYLOAD'
rm -f /etc/sudoers.d/srvman-readonly /etc/sudoers.d/.srvman-readonly.new
rm -f /usr/local/sbin/srvman-zfs /usr/local/sbin/srvman-zpool
echo CLEANED
EOFPAYLOAD
chmod 600 "$S"
sudo -S -p '' /bin/sh "$S"
echo UNINSTALLED
`

function installCommand(zfsPath, zpoolPath, user) {
  const payload = rootPayload(zfsPath, zpoolPath, user)
  // 载荷先落到临时文件（普通用户权限），再交给一次 sudo 执行；密码走 stdin。
  // 用 trap 保证 sudo 失败时临时文件也会被清掉（set -e 会直接跳出，后面的行不执行）。
  return [
    'set -e',
    'S=$(mktemp)',
    `trap 'rm -f "$S"' EXIT INT TERM`,
    `cat > "$S" << 'EOFPAYLOAD'`,
    payload,
    'EOFPAYLOAD',
    'chmod 600 "$S"',
    "sudo -S -p '' /bin/sh \"$S\"",
    'echo INSTALLED',
  ].join('\n')
}

/**
 * 装 zfsutils-linux（纯用户态命令行工具）。
 * 先模拟一遍并设卡：只要有“升级/卸载/内核相关包”，就拒绝真装 —— 避免哪天
 * apt 顺手把 kernel 或 zfs-dkms 带上来。
 */
function aptInstallCommand() {
  return String.raw`
set -e
PLAN=$(apt-get -s install --no-install-recommends zfsutils-linux 2>&1 || true)
LINE=$(echo "$PLAN" | grep -oE "[0-9]+ upgraded, [0-9]+ newly installed, [0-9]+ to remove" | head -1)
echo "PLAN: $LINE"
if echo "$PLAN" | grep -qE "^Inst (linux-|zfs-dkms|spl-dkms|initramfs)"; then
  echo "ABORT_KERNEL"; exit 0
fi
UP=$(echo "$LINE" | sed -E 's/^([0-9]+) upgraded.*/\1/')
RM=$(echo "$LINE" | sed -E 's/.*, ([0-9]+) to remove.*/\1/')
NEW=$(echo "$LINE" | sed -E 's/.*, ([0-9]+) newly installed.*/\1/')
echo "CHURN up=$UP new=$NEW rm=$RM"
if [ "$UP" != "0" ] || [ "$RM" != "0" ] || [ "$NEW" = "0" ]; then
  echo "ABORT_CHURN"; exit 0
fi
S=$(mktemp)
trap 'rm -f "$S"' EXIT INT TERM
printf 'export DEBIAN_FRONTEND=noninteractive\napt-get install -y --no-install-recommends zfsutils-linux\necho PKG_DONE\n' > "$S"
chmod 600 "$S"
sudo -S -p '' /bin/sh "$S"
echo PKG_INSTALLED
`
}

async function handle(server, password) {
  const r = { id: server.id, target: `${server.user}@${server.host}:${server.port}` }
  try {
    const bins = await sshRun(server, FIND_BINS, { privateKey, stdin: '' })
    const kv = Object.fromEntries(
      bins.out.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    )
    r.zfs = kv.ZFS_PATH || ''
    r.runnable = kv.ZFS_RUNNABLE === '1'
    r.devZfs = kv.DEVZFS || ''
    r.user = kv.USER || server.user

    const before = await sshRun(server, CHECK_PRIV, { privateKey, stdin: '' })
    r.before = before.out

    if (uninstall) {
      const un = await sshRun(server, UNINSTALL, { privateKey, stdin: `${password}\n` })
      const c = `${un.out}\n${un.err}`
      r.result = c.includes('UNINSTALLED') ? '已卸载' : (c.match(/sudo: [^\n]*|Sorry, try again[^\n]*/g) || [c.slice(-100)])[0]
      const chk = await sshRun(server, CHECK_PRIV, { privateKey, stdin: '' })
      r.after = chk.out
      return r
    }

    if (checkOnly) return r
    if (['SUDO_OK', 'PLAIN_OK', 'IS_ROOT'].includes(r.before)) return r

    // 没有可执行的 zfs 时，先装纯用户态的 zfsutils-linux，再继续授权
    if (!r.runnable) {
      if (!installPkg) {
        r.result = '这台没有能执行的 zfs（加 --install-pkg 可自动装 zfsutils-linux）'
        return r
      }
      const apt = await sshRun(server, aptInstallCommand(), { privateKey, stdin: `${password}\n` })
      const ac = `${apt.out}\n${apt.err}`
      if (ac.includes('ABORT_KERNEL')) { r.result = '拒绝安装：apt 计划要动内核相关包'; return r }
      if (ac.includes('ABORT_CHURN')) { r.result = `拒绝安装：apt 计划含升级/卸载 (${(ac.match(/PLAN: .*/)||[''])[0]})`; return r }
      r.pkg = ac.includes('PKG_INSTALLED') ? '已装 zfsutils-linux' : (ac.match(/E:[^\n]*|sudo: [^\n]*|Sorry, try again[^\n]*/g) || [ac.slice(-90)])[0]
      const again = await sshRun(server, FIND_BINS, { privateKey, stdin: '' })
      const kv2 = Object.fromEntries(
        again.out.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      )
      r.zfs = kv2.ZFS_PATH || ''
      r.runnable = kv2.ZFS_RUNNABLE === '1'
      if (!r.runnable) { r.result = '装完仍然跑不起来'; return r }
    }

    const zpoolPath = r.zfs.replace(/zfs$/, 'zpool')
    const inst = await sshRun(server, installCommand(r.zfs, zpoolPath, r.user), { privateKey, stdin: `${password}\n` })
    const combined = `${inst.out}\n${inst.err}`
    if (combined.includes('INSTALLED')) r.result = 'installed'
    else if (/sudo:.*incorrect password|Sorry, try again/i.test(combined)) r.result = '密码不对'
    else if (/visudo: parsed/i.test(combined)) r.result = 'installed(visudo ok)'
    else r.result = (combined.match(/sudo: [^\n]*|visudo: [^\n]*|Permission denied|No such file[^\n]*/g) || [combined.slice(-120)])[0]

    const after = await sshRun(server, CHECK_PRIV, { privateKey, stdin: '' })
    r.after = after.out
    return r
  } catch (err) {
    r.error = err.message || String(err)
    return r
  }
}

async function main() {
  const servers = loadServers().filter((s) => !only || only.includes(s.id))
  if (servers.length === 0) { console.error('没有匹配的主机'); process.exit(1) }

  console.log(
    uninstall
      ? '将删除本工具装的 sudoers 与软链（不动其它任何 sudo 配置）'
      : checkOnly
        ? '只检查模式，不改动任何机器'
        : installPkg
          ? '将装 zfsutils-linux（纯用户态，先模拟并拒绝任何涉及内核的变更），再配只读 sudoers'
          : '将安装只读 sudoers（只放行 zfs/zpool 的 list 子命令）',
  )
  console.log(`目标: ${servers.map((s) => s.id).join(' ')}\n`)

  let password = process.env.SUDO_PASSWORD || ''
  if (!password && !checkOnly) {
    password = await askHidden('sudo 密码（输入不回显）: ')
    if (!password) { console.error('密码为空'); process.exit(1) }
  }

  const results = []
  for (const s of servers) {
    const r = await handle(s, password)
    results.push(r)
    const bits = [
      `zfs=${r.zfs || '无'}`,
      `/dev/zfs=${r.devZfs}`,
      `改前=${r.before}`,
      r.pkg ? `包=${r.pkg}` : '',
      r.after ? `改后=${r.after}` : '',
      r.result ? `结果=${r.result}` : '',
      r.error ? `✗ ${r.error}` : '',
    ]
    console.log(`  ${r.id.padEnd(3)} ${bits.filter(Boolean).join('  ')}`)
  }

  const stateOf = (r) => r.after || r.before
  const ok = results.filter((r) => ['SUDO_OK', 'PLAIN_OK', 'IS_ROOT'].includes(stateOf(r)))
  const broken = results.filter((r) => stateOf(r) === 'BIN_BROKEN')
  console.log('')
  if (uninstall) {
    console.log('已删除 /etc/sudoers.d/srvman-readonly 和两个软链。采集会自动回到 lxc exec + df。')
  } else if (checkOnly) {
    console.log(`可读到 zfs 的机器: ${ok.map((r) => r.id).join(', ') || '无'}`)
    if (broken.length) console.log(`sudo 已放行但程序跑不起来: ${broken.map((r) => r.id).join(', ')}`)
    console.log('其余机器走 lxc exec + df 降级（只对运行中的容器有效）。')
  } else if (ok.length === results.length) {
    console.log(`全部 ${ok.length} 台都能读 zfs 数据集了，停着的容器也能拿到用量。`)
  } else {
    const bad = results.filter((r) => !['SUDO_OK', 'PLAIN_OK', 'IS_ROOT'].includes(stateOf(r)))
    if (ok.length) console.log(`已可用: ${ok.map((r) => r.id).join(', ')}`)
    if (bad.length) {
      console.log(`\n这些台上没有能执行的 zfs：${bad.map((r) => r.id).join(', ')}`)
      console.log('LXD snap 自带的那份依赖 OpenSSL 1.1（libcrypto.so.1.1），宿主机只有 3.x，在 snap 外跑不起来。')
      console.log('一条命令搞定（先模拟、拒绝任何涉及内核的变更，再装包并配 sudoers）：')
      console.log('    npm run setup-root -- --install-pkg')
      console.log('实测该包只新增 5 个用户态包、0 升级 0 卸载，且与已加载的内核模块同为 2.1.5-1ubuntu6~22.04.7。')
    }
    console.log('\n不装也不影响现在的使用：全部容器都在运行的话，lxc exec + df 已经能拿到已用和配额。')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
