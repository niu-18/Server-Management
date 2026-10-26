/**
 * 显卡与 profile：每台宿主机自己那份 nvidia-smi、谁在用哪张卡、profile 配置体检。
 *
 * 全部非 root。有一个绕不开的坑：这 9 台的**宿主驱动不同版本**（实测 580.126.09 /
 * 580.142 / 550.100 三套并存），而 default profile 里的 gpu 设备是"透传全部卡"，
 * 所以容器不绑定具体某张卡 —— 想把"谁在用哪张卡"讲清楚，只能拿宿主上有 GPU 上下文的
 * 进程 PID，去读它 /proc/<pid>/cgroup 里的 lxc.payload.<容器名>。
 * 同理，判断容器驱动对不对也必须和**它所在成员**比，见 checks.mjs。
 */

const PAYLOAD_RE = /\/lxc\.payload\.([^/]+)/
const MONITOR_RE = /\/lxc\.monitor\.([^/]+)/

function num(v) {
  const cleaned = String(v == null ? '' : v).replace(/[^0-9.+-]/g, '')
  if (cleaned === '' ) return null // "N/A" 之类的不能变成 0
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function toBytes(v, unit) {
  const n = num(v)
  if (n == null) return null
  const u = String(unit || 'MiB').toLowerCase()
  const mult = u === 'kib' || u === 'kb' ? 1024 : u === 'gib' || u === 'gb' ? 1024 ** 3 : 1024 * 1024
  return Math.round(n * mult)
}

/** nvidia-smi --query-gpu=index,uuid,name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw */
export function parseGpuDevices(lines = []) {
  const gpus = []
  for (const line of lines) {
    const f = line.split(',').map((s) => s.trim())
    if (f.length < 6) continue
    const idx = num(f[0])
    if (idx == null) continue // 报错行（"Unable to determine..."）走不到这里
    gpus.push({
      index: idx,
      uuid: f[1] || '',
      name: f[2] || '',
      driverVersion: f[3] || '',
      memoryTotalBytes: toBytes(f[4], f[4]?.split(/\s+/)[1]),
      memoryUsedBytes: toBytes(f[5], f[5]?.split(/\s+/)[1]),
      utilPercent: num(f[6]),
      temperatureC: num(f[7]),
      powerWatts: num(f[8]),
    })
  }
  return gpus
}

/** "@@A <pid>|<gpu_uuid>|<used_memory>|<cgroup 路径>" */
export function parseComputeApps(lines = []) {
  const out = []
  for (const line of lines) {
    if (!line.startsWith('@@A ')) continue
    const [pid, gpuUuid, mem, cgroup] = line.slice(4).split('|').map((s) => (s || '').trim())
    if (!pid) continue
    const payload = String(cgroup || '').match(PAYLOAD_RE) || String(cgroup || '').match(MONITOR_RE)
    out.push({
      pid: Number(pid) || 0,
      gpuUuid: gpuUuid || '',
      usedBytes: toBytes(mem, String(mem || '').split(/\s+/)[1]),
      container: payload ? payload[1] : null,
      cgroup: cgroup || '',
    })
  }
  return out
}

/** HOSTUVM 段：`508 nvidia-uvm` + `/dev/nvidia-uvm 1fc` */
export function parseHostUvm(lines = []) {
  let procMajor = null
  let nodeMajor = null
  for (const rawLine of lines) {
    // /proc/devices 的主编号是 %3d，1–2 位数字前面有空格，必须先 trim
    const line = String(rawLine || '').trim()
    const proc = line.match(/^(\d+)\s+nvidia-uvm$/)
    if (proc) { procMajor = Number(proc[1]); continue }
    const node = line.match(/^\/dev\/(\S+)\s+([0-9a-fA-F]+)$/)
    if (node) nodeMajor = parseInt(node[2], 16)
  }
  return { procMajor, nodeMajor }
}

/** PROFSRC 段："@@S <路径>\tOK|MISS" */
export function parseProfileSources(lines = []) {
  const out = []
  for (const line of lines) {
    if (!line.startsWith('@@S ')) continue
    const [path, state] = line.slice(4).split('\t')
    out.push({ path: (path || '').trim(), exists: (state || '').trim() === 'OK' })
  }
  return out
}

export function parseProfiles(rawJson) {
  let arr
  try {
    arr = JSON.parse(String(rawJson || '').trim())
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  return arr.map((p) => ({
    name: p.name || '',
    description: p.description || '',
    config: p.config || {},
    devices: p.devices || {},
    usedBy: Array.isArray(p.used_by) ? p.used_by.length : 0,
  }))
}

/** profile 体检：拼写、来源路径、资源限制，以及"所有容器共享全部卡"这个事实 */
export function buildProfileAudit(profiles = [], sources = []) {
  const issues = []
  const missingSources = sources.filter((s) => !s.exists).map((s) => s.path)
  const info = []

  for (const p of profiles) {
    for (const [devName, d] of Object.entries(p.devices)) {
      if (!d || d.type !== 'gpu') continue
      const want = 'physical'
      const got = d.gputype || d['gpu.type'] || ''
      if (got && got !== want) {
        issues.push({
          level: 'warn',
          title: `profile ${p.name} 的 ${devName} 写的是 gputype: ${got}`,
          detail: `LXD 认的值是 ${want}。现在还能透传是因为未知属性被忽略、退化成"全部卡"，但这是配置错误，改法应显式写清。`,
          commands: [`# ${p.name} profile：\n#   gputype: ${got}   →   gputype: ${want}`, 'lxc profile edit default'],
        })
      }
      if (!got) {
        info.push({ title: `profile ${p.name} 的 ${devName} 没写 gputype`, detail: '默认是 physical，行为不变。' })
      }
    }
    const allowance = p.config?.['limits.cpu.allowance']
    if (allowance) info.push({ title: `profile ${p.name} 限了 CPU：limits.cpu.allowance=${allowance}`, detail: '每个容器都吃这条，不是每台机器单独的配额。' })
  }

  if (missingSources.length) {
    issues.push({
      level: 'critical',
      title: `profile 里的挂载源在这台上有 ${missingSources.length} 个不存在`,
      detail: `${missingSources.join('、')} —— 容器里对应目录会是空的，跑 CUDA/共享盘的代码直接报错。通常是 NAS 没挂上或者路径改了。`,
      commands: ['mount | grep nas', 'cat /etc/fstab | grep nas', 'sudo systemctl restart autostart.service'],
    })
  }

  return { issues, info, missingSources }
}

/**
 * 一台机器的显卡视图。
 * hostBroken 用于避免"宿主坏了一台、冤枉它上面所有容器"。
 */
export function buildGpuView(sections) {
  const gpus = parseGpuDevices(sections.GPUDEV)
  const compute = parseComputeApps(sections.GPUCOMPUTE)
  const uvm = parseHostUvm(sections.HOSTUVM)
  const firstLine = (sections.GPUDEV || [])[0] || ''
  const hostBroken = gpus.length === 0 && /Failed to initialize NVML|Unable to determine|No devices|command not found/i.test(firstLine)

  const byUuid = new Map(gpus.map((g) => [g.uuid, g]))
  for (const c of compute) {
    const g = byUuid.get(c.gpuUuid)
    if (g) c.gpuIndex = g.index
  }

  const byContainer = new Map()
  for (const c of compute) {
    const key = c.container || '(宿主机进程)'
    if (!byContainer.has(key)) byContainer.set(key, { container: c.container, pids: [], bytes: 0, gpus: new Set() })
    const row = byContainer.get(key)
    row.pids.push(c.pid)
    row.bytes += c.usedBytes || 0
    if (c.gpuIndex != null) row.gpus.add(c.gpuIndex)
  }
  const users = [...byContainer.values()]
    .map((r) => ({ container: r.container, pids: r.pids, usedBytes: r.bytes, gpuIndexes: [...r.gpus].sort((a, b) => a - b) }))
    .sort((a, b) => b.usedBytes - a.usedBytes)

  return {
    gpus,
    driverVersion: gpus[0]?.driverVersion || '',
    totalMemoryBytes: gpus.reduce((s, g) => s + (g.memoryTotalBytes || 0), 0),
    usedMemoryBytes: gpus.reduce((s, g) => s + (g.memoryUsedBytes || 0), 0),
    maxUtilPercent: gpus.reduce((m, g) => Math.max(m, g.utilPercent ?? 0), 0),
    maxTempC: gpus.reduce((m, g) => Math.max(m, g.temperatureC ?? 0), 0),
    compute,
    users,
    hostBroken,
    hostError: hostBroken ? firstLine : '',
    uvmProcMajor: uvm.procMajor,
    uvmNodeMajor: uvm.nodeMajor,
    // 开机久了 nvidia-uvm 主编号会变，容器里那个 unix-char 节点可能是上次的
    uvmConsistent: uvm.procMajor == null || uvm.nodeMajor == null ? null : uvm.procMajor === uvm.nodeMajor,
  }
}

/** 跨机器聚一张驱动版本矩阵 */
export function buildDriverMatrix(records = []) {
  const rows = records.map((r) => ({
    id: r.id,
    online: r.status === 'ok',
    driverVersion: r.gpu?.driverVersion || '',
    gpuCount: r.gpu?.gpus?.length ?? 0,
    gpuNames: [...new Set((r.gpu?.gpus || []).map((g) => g.name))],
    totalMemoryBytes: r.gpu?.totalMemoryBytes ?? 0,
    usedMemoryBytes: r.gpu?.usedMemoryBytes ?? 0,
    busyContainers: (r.gpu?.users || []).filter((u) => u.container).length,
    uvmProcMajor: r.gpu?.uvmProcMajor ?? null,
    uvmConsistent: r.gpu?.uvmConsistent ?? null,
    hostBroken: Boolean(r.gpu?.hostBroken),
    cluster: r.lxd?.clusterKey || '',
  }))
  const versions = [...new Set(rows.map((r) => r.driverVersion).filter(Boolean))]
  return {
    rows,
    versions,
    consistent: versions.length <= 1,
    // 同一个集群里版本不一致最要命：容器一迁就坏
    perCluster: versions.length > 1
      ? rows.reduce((acc, r) => {
          const key = r.cluster || 'solo'
          acc[key] = acc[key] || new Set()
          if (r.driverVersion) acc[key].add(r.driverVersion)
          return acc
        }, Object.create(null))
      : {},
  }
}
