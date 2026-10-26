/**
 * LXD 层采集。
 *
 * 这 9 台机器是 LXD 宿主机：真正的容量在 LXD 的存储池上（zfs 驱动，专用大盘，
 * LXD 用 legacy 挂载所以 df 看不见），而"账户"是 local/containers/<姓名-学号>
 * 这些容器数据集。所以整机容量走 LXD API，账户用量走 zfs 数据集属性。
 *
 * 权限阶梯：
 *   1. zfs list            —— 需要能读 /dev/zfs（多数机器上是 root-only）
 *   2. sudo -n zfs list    —— 装了 setup-root 的受限 sudoers 后可用
 *   3. lxc exec <c> df -k  —— 不需要 root，但只对运行中的容器有效
 */

import { parseClusterMembers } from './cluster.mjs'

export function buildLxdScript({ allowExecFallback = false } = {}) {
  const fallback = allowExecFallback
    ? String.raw`
echo "$S:CDF"
if [ "$ZFS_OK" != "1" ]; then
  lxc list --format=csv -c n 2>/dev/null | while IFS= read -r n; do
    [ -n "$n" ] || continue
    printf '@@C %s\t' "$n"
    lxc exec "$n" -- df -kP / </dev/null 2>/dev/null | tail -1
    echo ""
  done
else
  echo "SKIPPED:zfs-available"
fi
`
    : ''

  return String.raw`
export LC_ALL=C
S=@@SEC

pick_bin() {
  for c in "/usr/local/sbin/srvman-$1" "/sbin/$1" "/usr/sbin/$1" "/usr/bin/$1"; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  ls -d /snap/lxd/*/zfs-*/bin/$1 2>/dev/null | sort | tail -1
}

ZFS=$(pick_bin zfs)
ZPOOL=$(pick_bin zpool)

run_priv() {
  if [ "$(id -u 2>/dev/null)" = "0" ]; then "$@" 2>/dev/null; return $?; fi
  # /dev/zfs 可能全局可读（s7 就是），先直接试
  if "$@" 2>/dev/null; then return 0; fi
  command -v sudo >/dev/null 2>&1 || return 1
  # 注意：不能用 "sudo -n true" 做前置判断 —— 我们只放行了 zfs/zpool 的
  # 只读子命令，"sudo -n true" 必然被拒，那样会误以为没有任何 sudo 可用。
  sudo -n "$@" 2>/dev/null; return $?
}

ZFS_OK=0
if [ -n "$ZFS" ] && run_priv "$ZFS" list -H -o name >/dev/null 2>&1; then ZFS_OK=1; fi

echo "$S:LXDMETA"
echo "member=$(hostname)"
echo "zfs_bin=$ZFS"
echo "zfs_ok=$ZFS_OK"
# 注意：lxc version --format=json 在 5.0 上不出 JSON（要按文本解析），
# 而且截断到固定长度会把版本号切没，所以这里直接取 "server version:" 那一行。
LV=$(lxc version 2>/dev/null | sed -n 's/^[Ss]erver version:[[:space:]]*//p' | head -1)
[ -n "$LV" ] || LV=$(lxd --version 2>/dev/null | head -1)
echo "lxc_version=$LV"
CL=$(lxc query /1.0/cluster 2>/dev/null | tr -d '\n\t')
echo "cluster=$CL"

echo "$S:POOLNAMES"
lxc query /1.0/storage-pools 2>/dev/null | tr ',' '\n' | sed -n 's#.*/1.0/storage-pools/##p' | tr -d '["] '

echo "$S:POOLRES"
MEMBER=$(hostname)
for p in $(lxc query /1.0/storage-pools 2>/dev/null | tr ',' '\n' | sed -n 's#.*/1.0/storage-pools/##p' | tr -d '["] '); do
  for t in "$MEMBER" ""; do
    if [ -n "$t" ]; then
      OUT=$(lxc query "/1.0/storage-pools/$p/resources?target=$t" 2>/dev/null)
    else
      OUT=$(lxc query "/1.0/storage-pools/$p/resources" 2>/dev/null)
    fi
    if [ -n "$OUT" ]; then
      printf '@@P %s %s\t' "$p" "$t"
      printf '%s' "$OUT" | tr -d '\n\t '
      printf '\n'
      break
    fi
  done
done

echo "$S:INSTANCES"
lxc list --format=json 2>/dev/null | tr -d '\n'
echo ""

echo "$S:ZPOOL"
if [ -n "$ZPOOL" ]; then run_priv "$ZPOOL" list -p -H -o name,size,alloc,free,cap,health; fi

echo "$S:ZFS"
if [ "$ZFS_OK" = "1" ]; then
  run_priv "$ZFS" list -H -p -o name,type,used,available,refer,quota,mountpoint
fi

echo "$S:CLUSTERMEM"
lxc query /1.0/cluster/members?recursion=1 2>/dev/null | tr -d '\n\t'
echo ""

echo "$S:PROFILES"
lxc query /1.0/profiles?recursion=1 2>/dev/null | tr -d '\n\t'
echo ""

echo "$S:PROFSRC"
for p in $(lxc query /1.0/profiles/default 2>/dev/null | grep -o '"source": "[^"]*"' | cut -d'"' -f4); do
  case "$p" in
    /*) ;;
    *) continue ;;
  esac
  if [ -e "$p" ]; then printf '@@S %s\tOK\n' "$p"; else printf '@@S %s\tMISS\n' "$p"; fi
done

echo "$S:SNAP"
if command -v snap >/dev/null 2>&1; then
  snap list --all 2>/dev/null | grep -E '^lxd '
fi

echo "$S:TIME"
echo "epoch=$(date +%s 2>/dev/null)"
echo "tz=$(date +%Z 2>/dev/null)"
echo "ntp=$(timedatectl show -p NTPSynchronized --value 2>/dev/null)"
echo "boot=$(uptime -s 2>/dev/null)"

echo "$S:HOSTUVM"
grep -w nvidia-uvm /proc/devices 2>/dev/null
stat -c "%n %t" /dev/nvidia-uvm 2>/dev/null

echo "$S:GPUDEV"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,uuid,name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader 2>&1
fi

echo "$S:GPUCOMPUTE"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory --format=csv,noheader 2>/dev/null | while IFS=, read -r P U M; do
    [ -n "$P" ] || continue
    CG=$(cut -d: -f3 /proc/$P/cgroup 2>/dev/null | head -1)
    printf '@@A %s|%s|%s|%s\n' "$P" "$U" "$M" "$CG"
  done
fi
` + fallback + String.raw`
echo "$S:END"
`
}

/**
 * 第二阶段：zfs 拿不到时，只对“这台机器上的”容器补一次 df。
 * 名字由 Node 侧按 location 过滤后传进来，所以不会像一次性遍历那样把全集群
 * 43 个容器都 exec 一遍。
 */
export function buildContainerDfScript(names) {
  const safe = (names || []).filter((n) => /^[A-Za-z0-9._-]+$/.test(n))
  if (safe.length === 0) return 'true'
  return `export LC_ALL=C
echo '@@SEC:CDF'
for n in ${safe.join(' ')}; do
  printf '@@C %s\\t' "$n"
  lxc exec "$n" -- df -kP / </dev/null 2>/dev/null | tail -1
  echo ""
done
echo '@@SEC:END'
`
}

/** 把第二阶段的 df 结果补回容器视图（只填还没拿到数据的）。 */
export function applyContainerDf(lxdView, cdfLines) {
  if (!lxdView) return lxdView
  const dfs = parseContainerDf(cdfLines)
  for (const c of lxdView.containers) {
    if (c.source !== 'none') continue
    const df = dfs.get(c.name)
    if (!df) continue
    c.usedBytes = df.usedBytes
    c.quotaBytes = df.totalBytes
    c.availBytes = df.availBytes
    c.usedPercent = df.usedPercent
    c.source = 'df'
  }
  lxdView.containers.sort((a, b) => (b.usedBytes ?? 0) - (a.usedBytes ?? 0))
  const sum = lxdView.containers.reduce((s, c) => s + (c.usedBytes || 0), 0)
  lxdView.totals.containerSumBytes = sum
  lxdView.totals.accountCount = lxdView.containers.filter((c) => c.usedBytes > 0).length
  if (lxdView.pool) {
    lxdView.totals.unattributedBytes = Math.max(0, lxdView.pool.usedBytes - sum)
  }
  return lxdView
}

/* ------------------------------------------------------------------ *
 * Parsers
 * ------------------------------------------------------------------ */

function toInt(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function parseLxdMeta(lines = []) {
  const out = {}
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq === -1) continue
    out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return {
    member: out.member || '',
    zfsBin: out.zfs_bin || '',
    zfsOk: out.zfs_ok === '1',
    lxcVersion: (out.lxc_version || '').trim().slice(0, 32),
    clusterEnabled: /"enabled":true/.test(out.cluster || ''),
  }
}

export function parsePoolNames(lines = []) {
  return lines.map((l) => l.trim()).filter(Boolean)
}

/** "@@P <pool> <target|->\t{json}" */
export function parsePoolResources(lines = []) {
  const out = new Map()
  for (const line of lines) {
    if (!line.startsWith('@@P ')) continue
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const head = line.slice(4, tab).trim().split(/\s+/)
    const pool = head[0]
    const target = head[1] === '' ? null : head[1]
    let json
    try {
      json = JSON.parse(line.slice(tab + 1))
    } catch {
      continue
    }
    const space = json?.space || {}
    const total = toInt(space.total)
    const used = toInt(space.used)
    if (!total || total <= 0) continue
    out.set(pool, {
      pool,
      target: target && target !== '-' ? target : null,
      totalBytes: total,
      usedBytes: used ?? 0,
      usedPercent: Math.round((used / total) * 1000) / 10,
    })
  }
  return out
}

/** "tcp:192.168.1.18:1018"、"tcp:[::1]:8080" → {host, port} */
export function parseProtoAddr(v) {
  const s = String(v || '').trim()
  const m = s.match(/^(?:udp|tcp)s?:\[([^\]]+)\]:(\d+)$/) || s.match(/^(?:udp|tcp)s?:([^[\]:]+):(\d+)$/)
  if (!m) return null
  return { host: m[1], port: Number(m[2]) }
}

/** 实例上的 proxy 设备 → 外部端口台账用的结构 */
export function proxyPortsOf(devices = {}) {
  const out = []
  for (const [name, d] of Object.entries(devices || {})) {
    if (!d || d.type !== 'proxy') continue
    const listen = parseProtoAddr(d.listen)
    const connect = parseProtoAddr(d.connect)
    out.push({
      device: name,
      bind: d.bind || 'auto',
      listenHost: listen?.host || '',
      listenPort: listen?.port ?? null,
      connectHost: connect?.host || '',
      connectPort: connect?.port ?? null,
    })
  }
  return out
}

/** lxc list --format=json —— 只保留我们真正要用的字段 */
export function parseInstances(rawJson) {
  let arr
  try {
    arr = JSON.parse(rawJson)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  return arr.map((it) => ({
    name: it.name,
    location: it.location || '',
    status: it.status || '',
    state: it.state?.status ?? '',
    pid: it.state?.pid ?? null,
    ipv4:
      it.state?.network?.eth0?.addresses?.find((a) => a.family === 'IPv4' && a.scope === 'global')
        ?.address || '',
    project: it.project || 'default',
    type: it.type || '',
    os: it.config?.['image.description'] || '',
    createdAt: it.created_at || '',
    lastUsedAt: it.last_used_at || '',
    // profile 继承下来的设备也在 expanded_devices 里；devices 只有实例自己加的
    devices: it.devices || {},
    expandedDevices: it.expanded_devices || {},
    limits: {
      cpu: it.config?.['limits.cpu'] || '',
      cpuAllowance: it.expanded_config?.['limits.cpu.allowance'] || '',
      memory: it.config?.['limits.memory'] || it.expanded_config?.['limits.memory'] || '',
    },
  })).filter((it) => it.name)
}

/** zpool list -p -H */
export function parseZpool(lines = []) {
  const out = []
  for (const line of lines) {
    const f = line.split(/\t+/).filter((x) => x !== '')
    if (f.length < 5) continue
    const [name, size, alloc, free, cap, health] = f
    const total = toInt(size)
    if (!total) continue
    out.push({
      name,
      totalBytes: total,
      allocBytes: toInt(alloc) ?? 0,
      freeBytes: toInt(free) ?? 0,
      capPercent: toInt(String(cap).replace('%', '')) ?? null,
      health: health || '',
    })
  }
  return out
}

/** zfs list -H -p -o name,type,used,available,refer,quota,mountpoint */
export function parseZfs(lines = []) {
  const out = new Map()
  for (const line of lines) {
    const f = line.split('\t')
    if (f.length < 6) continue
    const [name, type, used, available, refer, quota, mountpoint] = f
    if (type === 'snapshot') continue // 快照不单列，避免噪声
    const usedBytes = toInt(used)
    if (usedBytes == null) continue
    const quotaBytes = toInt(quota)
    out.set(name, {
      dataset: name,
      type: type || '',
      usedBytes,
      availableBytes: toInt(available) ?? 0,
      referBytes: toInt(refer) ?? 0,
      quotaBytes: quotaBytes && quotaBytes > 0 ? quotaBytes : null,
      mountpoint: mountpoint && mountpoint !== '-' ? mountpoint : '',
    })
  }
  return out
}

/** "@@C <name>\t<df -kP 行>" */
export function parseContainerDf(lines = []) {
  const out = new Map()
  for (const line of lines) {
    if (!line.startsWith('@@C ')) continue
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const name = line.slice(4, tab).trim()
    const f = line.slice(tab + 1).trim().split(/\s+/)
    if (f.length < 6) continue
    const nums = f.slice(1, f.length - 2).filter((n) => /^\d+$/.test(n))
    if (nums.length < 3) continue
    const [total, used, avail] = nums.map((n) => Number(n) * 1024)
    if (!total) continue
    out.set(name, {
      totalBytes: total,
      usedBytes: used,
      availBytes: avail,
      usedPercent: Math.round((used / total) * 1000) / 10,
    })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Build the LXD view for one host
 * ------------------------------------------------------------------ */
export function buildLxdView(sections, memberName) {
  const meta = parseLxdMeta(sections.LXDMETA)
  const pools = parsePoolNames(sections.POOLNAMES)
  const poolRes = parsePoolResources(sections.POOLRES)
  const zpools = parseZpool(sections.ZPOOL)
  const zfs = parseZfs(sections.ZFS)
  const dfs = parseContainerDf(sections.CDF)

  const allInstances = parseInstances((sections.INSTANCES || []).join(''))
  const member = memberName || meta.member
  const clusterMembers = parseClusterMembers((sections.CLUSTERMEM || []).join(''))
  const clusterKey = clusterMembers.length ? [...clusterMembers.map((m) => m.name)].sort().join(',') : ''
  // 集群里 lxc list 会返回全部成员的实例，只留这台自己的
  const mine = member ? allInstances.filter((i) => !i.location || i.location === member) : allInstances

  // 主存储池：优先 LXD 报的那个，其次和 zpool 同名
  const poolName = pools[0] || zpools[0]?.name || 'local'
  const res = poolRes.get(poolName)
  const zp = zpools.find((z) => z.name === poolName) || zpools[0]

  const poolTotalBytes = res?.totalBytes || zp?.totalBytes || null
  const poolUsedBytes = res?.usedBytes ?? zp?.allocBytes ?? null
  const pool = poolTotalBytes
    ? {
        name: poolName,
        driver: 'zfs',
        totalBytes: poolTotalBytes,
        usedBytes: poolUsedBytes ?? 0,
        availBytes: Math.max(0, poolTotalBytes - (poolUsedBytes ?? 0)),
        usedPercent: Math.round(((poolUsedBytes ?? 0) / poolTotalBytes) * 1000) / 10,
        source: res ? 'lxd-api' : 'zpool',
      }
    : null

  const containers = mine.map((inst) => {
    const dsName = `${poolName}/containers/${inst.name}`
    const ds = zfs.get(dsName) || zfs.get(`${dsName}/rootfs`)
    const df = dfs.get(inst.name)
    const usedBytes = ds?.usedBytes ?? df?.usedBytes ?? null
    const quotaBytes = ds?.quotaBytes ?? df?.totalBytes ?? null
    return {
      name: inst.name,
      owner: inst.name.replace(/-[^-]*$/, ''),
      suffix: inst.name.includes('-') ? inst.name.split('-').slice(1).join('-') : '',
      location: inst.location || member || '',
      status: inst.status,
      ipv4: inst.ipv4,
      project: inst.project,
      dataset: ds?.dataset || dsName,
      usedBytes,
      quotaBytes,
      availBytes: ds ? ds.availableBytes : df?.availBytes ?? null,
      usedPercent:
        quotaBytes && usedBytes != null ? Math.round((usedBytes / quotaBytes) * 1000) / 10 : null,
      source: ds ? 'zfs' : df ? 'df' : 'none',
      lastUsedAt: inst.lastUsedAt || '',
      devices: inst.devices || {},
      expandedDevices: inst.expandedDevices || {},
      limits: inst.limits || {},
      proxyPorts: proxyPortsOf(inst.expandedDevices || inst.devices || {}),
    }
  })
  containers.sort((a, b) => (b.usedBytes ?? 0) - (a.usedBytes ?? 0))

  // 迁移残留：这台上有 <pool>/containers/<name> 数据集，但没有实例落在这台。
  // 它们真实占盘，却不在任何账户的容器列表里 —— 不单独列出来就会被“残差”吞掉。
  const containerPrefix = `${poolName}/containers/`
  const known = new Set(mine.map((i) => i.name))
  const orphanDatasets = [...zfs.values()]
    .filter((d) => d.dataset.startsWith(containerPrefix))
    .map((d) => ({ ...d, name: d.dataset.slice(containerPrefix.length) }))
    .filter((d) => !known.has(d.name))
    .sort((a, b) => b.usedBytes - a.usedBytes)

  // 池里还没被任何容器认领的占用（镜像、快照、宿主自己的数据集）
  const containerSum = containers.reduce((s, c) => s + (c.usedBytes || 0), 0)
  const orphanSumBytes = orphanDatasets.reduce((s, d) => s + (d.usedBytes || 0), 0)

  return {
    member: memberName || meta.member,
    pool,
    pools,
    zpools,
    zfsAvailable: meta.zfsOk,
    zfsBin: meta.zfsBin,
    lxcVersion: meta.lxcVersion,
    clusterEnabled: meta.clusterEnabled,
    clusterMembers,
    clusterKey,
    containers,
    orphanDatasets,
    totals: {
      containerCount: containers.length,
      runningCount: containers.filter((c) => c.status === 'Running').length,
      containerSumBytes: containerSum,
      orphanCount: orphanDatasets.length,
      orphanSumBytes: orphanSumBytes,
      unattributedBytes: pool ? Math.max(0, pool.usedBytes - containerSum) : null,
      // 扣掉迁移残留之后仍未解释的部分，才是镜像/元数据
      poolOverheadBytes: pool ? Math.max(0, pool.usedBytes - containerSum - orphanSumBytes) : null,
      quotaBacked: containers.filter((c) => c.quotaBytes).length,
    },
    // 完整数据集表留给 UI 做“非容器占用”分析
    datasets: [...zfs.values()],
  }
}
