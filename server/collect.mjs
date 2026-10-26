import path from 'node:path'
import { CONFIG } from './config.mjs'
import { openConnection, exec } from './ssh.mjs'
import { buildRemoteScript } from './remoteScript.mjs'
import { buildLxdView, buildContainerDfScript, applyContainerDf } from './lxd.mjs'
import { buildGpuView, buildProfileAudit, parseProfileSources, parseProfiles } from './gpu.mjs'
import { parseSnap, parseTimeFacts } from './cluster.mjs'

const KB = 1024

const PSEUDO_FS = new Set([
  'tmpfs', 'devtmpfs', 'ramfs', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'pstore',
  'securityfs', 'debugfs', 'tracefs', 'configfs', 'mqueue', 'hugetlbfs',
  'binfmt_misc', 'fusectl', 'efivarfs', 'autofs', 'devpts', 'squashfs',
  'iso9660', 'nfsd', 'rpc_pipefs', 'fuse.lxcfs', 'overlayfs',
])

const NETWORK_FS = /^(cifs|smb|smb2|smb3|nfs|nfs4|fuse\.sshfs|sshfs|webdav|davfs)$/i

export function isNetworkFs(type) {
  return NETWORK_FS.test(type || '')
}

/* ------------------------------------------------------------------ *
 * Section splitting
 * ------------------------------------------------------------------ */
export function splitSections(stdout) {
  const sections = {}
  let current = null
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('@@SEC:')) {
      current = line.slice(6).trim()
      if (!(current in sections)) sections[current] = []
      continue
    }
    if (!current) continue
    if (line !== '') sections[current].push(line)
  }
  return sections
}

/* ------------------------------------------------------------------ *
 * df -PT -k   (falls back to df -P -k when Type is unsupported)
 * ------------------------------------------------------------------ */
export function parseDf(lines = []) {
  if (lines.length === 0) return []
  const first = lines[0] || ''
  const typed = /\btype\b/i.test(first)
  const hasHeader = /^(file\s?system|none|tmpfs)/i.test(first.trim()) || /mounted on/i.test(first)
  const body = hasHeader ? lines.slice(1) : lines

  const mounts = []
  for (const line of body) {
    const f = line.trim().split(/\s+/)
    if (f.length < 6) continue
    const source = f[0]
    const type = typed ? f[1] : ''
    const mount = f[f.length - 1]
    const pctLabel = f[f.length - 2]
    const nums = f.slice(typed ? 2 : 1, f.length - 2).filter((n) => /^\d+$/.test(n))
    if (nums.length < 3) continue
    const [blocks, used, avail] = nums.slice(0, 3).map((n) => Number(n) * KB)
    if (blocks <= 0) continue
    const looksPseudo = !typed && PSEUDO_FS.has(source)
    mounts.push({
      source,
      type,
      mount,
      totalBytes: blocks,
      usedBytes: used,
      availBytes: avail,
      usedPercent: Math.round((used / blocks) * 1000) / 10,
      kernelPct: pctLabel,
      pseudo: PSEUDO_FS.has(type) || looksPseudo || source.startsWith('/dev/loop'),
      network: isNetworkFs(type),
    })
  }
  return dedupeMounts(mounts)
}

function dedupeMounts(mounts) {
  const seen = new Map()
  for (const m of mounts) {
    const key = `${m.source}|${m.mount}`
    if (!seen.has(key)) seen.set(key, m)
  }
  return [...seen.values()].sort((a, b) => a.mount.localeCompare(b.mount))
}

/* ------------------------------------------------------------------ *
 * /etc/passwd projection: name \t uid \t home \t shell
 * ------------------------------------------------------------------ */
export function parseUsers(lines = []) {
  const users = []
  for (const line of lines) {
    const [name, uid, home, shell] = line.split('\t')
    if (!name) continue
    users.push({ name, uid: Number(uid) || 0, home: home || '', shell: shell || '' })
  }
  return users
}

/* ------------------------------------------------------------------ *
 * repquota -a
 * ------------------------------------------------------------------ */
export function parseRepquota(lines = []) {
  const result = new Map()
  let device = ''
  let mode = 'user'

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    if (line.startsWith('***')) {
      const report = line.match(/^\*+\s*Report for (user|group) quotas on device (\S+)/i)
      if (report) {
        mode = report[1].toLowerCase()
        device = report[2]
      } else if (/group quotas/i.test(line)) {
        mode = 'group'
      }
      continue
    }
    if (/^(user|group)\s+used/i.test(line)) continue
    if (/^(block|inode|space)\s+grace/i.test(line)) continue
    if (/grace time/i.test(line)) continue
    if (/space limits|file limits/i.test(line)) continue
    if (mode !== 'user') continue

    const f = line.split(/\s+/)
    const name = f[0]
    if (!/^[a-z_.][a-z0-9_.-]*$/i.test(name)) continue
    const nums = f.slice(1).filter((t) => /^\d+$/.test(t))
    if (nums.length < 3) continue

    const [used, soft, hard] = nums.slice(0, 3).map((n) => Number(n) * KB)
    const prev = result.get(name)
    if (!prev || used > prev.usedBytes) {
      result.set(name, { usedBytes: used, softBytes: soft, hardBytes: hard, device })
    }
  }
  return result
}

/* ------------------------------------------------------------------ *
 * du --max-depth=1 blocks
 *
 * A depth-one scan of DIR emits one line whose path is DIR itself (the total)
 * plus one line per immediate child. Children may be nested further in the
 * output when the scanner fell back to a plain recursive du, so we keep only
 * immediate children and let the total come from the DIR line.
 * ------------------------------------------------------------------ */
function splitKbLine(line) {
  const tab = line.indexOf('\t')
  if (tab === -1) {
    const m = line.match(/^(\d+)\s+(.*)$/)
    if (!m) return null
    return { kb: Number(m[1]), p: m[2].trim() }
  }
  const kb = Number(line.slice(0, tab))
  if (!Number.isFinite(kb)) return null
  return { kb, p: line.slice(tab + 1).trim() }
}

function normaliseDir(p) {
  const stripped = p.replace(/\/+$/, '')
  return stripped || '/'
}

export function parseDepthOneScan(lines, root) {
  const rootN = normaliseDir(root)
  const entries = new Map()
  let totalBytes = null

  for (const line of lines) {
    const parsed = splitKbLine(line)
    if (!parsed) continue
    const p = normaliseDir(parsed.p)
    const bytes = parsed.kb * KB
    if (p === rootN) {
      totalBytes = bytes
      continue
    }
    if (!p.startsWith(`${rootN}/`)) continue
    const rel = p.slice(rootN.length + 1)
    if (!rel || rel.includes('/')) continue // 只留直属子项
    entries.set(p, { name: rel, path: p, bytes })
  }

  const children = [...entries.values()].sort((a, b) => b.bytes - a.bytes)
  if (totalBytes == null) totalBytes = children.reduce((s, c) => s + c.bytes, 0)
  return { totalBytes, children }
}

/* ------------------------------------------------------------------ *
 * DU section: "@@HOME<path>" markers followed by that home's scan
 * ------------------------------------------------------------------ */
export function parseHomes(lines = []) {
  const homes = new Map()
  let current = null
  let bucket = []

  const flush = () => {
    if (current) homes.set(current, parseDepthOneScan(bucket, current))
    bucket = []
  }

  for (const line of lines) {
    if (line.startsWith('@@HOME')) {
      flush()
      current = normaliseDir(line.slice(6))
      continue
    }
    if (current) bucket.push(line)
  }
  flush()
  return homes
}

/* ------------------------------------------------------------------ *
 * NASDU section: depth-one scans of each network mount
 * ------------------------------------------------------------------ */
export function parseNasScans(lines = [], mounts = []) {
  if (lines.length === 1 && lines[0].startsWith('SKIPPED')) return []
  const targets = mounts.filter((m) => m.network)
  const details = []
  for (const m of targets) {
    const relevant = lines.filter((line) => {
      const parsed = splitKbLine(line)
      if (!parsed) return false
      const p = normaliseDir(parsed.p)
      return p === normaliseDir(m.mount) || p.startsWith(`${normaliseDir(m.mount)}/`)
    })
    if (relevant.length === 0) continue
    const scan = parseDepthOneScan(relevant, m.mount)
    details.push({ mount: m.mount, source: m.source, ...scan })
  }
  return details
}

/* ------------------------------------------------------------------ *
 * Merge one server
 * ------------------------------------------------------------------ */
function accountLabel(home) {
  const parts = home.split('/').filter(Boolean)
  if (parts[0] === 'home' && parts.length >= 2) return parts[1]
  if (parts[0] === 'root' && parts.length === 1) return 'root'
  return null
}

export function buildServerRecord(server, sections, meta = {}) {
  const mounts = parseDf(sections.DF)
  const users = parseUsers(sections.USERS)
  const quota = parseRepquota(sections.QUOTA)
  const homes = parseHomes(sections.DU)
  const nasScans = parseNasScans(sections.NASDU, mounts)

  const localMounts = mounts.filter((m) => !m.pseudo && !m.network)
  const networkMounts = mounts.filter((m) => m.network)
  const primary = pickPrimary(localMounts, mounts)

  const byName = new Map()
  const touch = (name) => {
    if (!byName.has(name)) {
      byName.set(name, { name, home: '', uid: null, duBytes: null, children: [] })
    }
    return byName.get(name)
  }

  for (const u of users) {
    const row = touch(u.name)
    row.home = u.home
    row.uid = u.uid
    row.shell = u.shell
  }
  for (const [home, scan] of homes) {
    const name = accountLabel(home) || path.basename(home)
    const row = touch(name)
    if (!row.home) row.home = home
    row.duBytes = scan.totalBytes
    row.children = scan.children
    row.home = row.home || home
  }

  const accounts = []
  for (const row of byName.values()) {
    const q = quota.get(row.name) || null
    const usedBytes = q ? q.usedBytes : row.duBytes ?? 0
    const childSum = row.children.reduce((s, c) => s + c.bytes, 0)
    accounts.push({
      name: row.name,
      uid: row.uid,
      home: row.home,
      usedBytes,
      duBytes: row.duBytes ?? null,
      // 直属子项之和小于账户总量时，差额是直接放在 home 根下的文件
      looseBytes: row.duBytes != null ? Math.max(0, row.duBytes - childSum) : null,
      children: row.children,
      quotaUsedBytes: q ? q.usedBytes : null,
      softBytes: q ? q.softBytes : null,
      hardBytes: q && q.hardBytes > 0 ? q.hardBytes : null,
      source: q ? 'quota' : row.duBytes != null ? 'du' : 'none',
      percentOfQuota:
        q && q.hardBytes > 0 ? Math.round((q.usedBytes / q.hardBytes) * 1000) / 10 : null,
    })
  }
  accounts.sort((a, b) => b.usedBytes - a.usedBytes)

  const uidLine = (sections.IDENTITY || [])[0]
  // 时钟偏差要"和同一时刻比"：本机在 exec 那一刻的 epoch 由 meta 传进来，
  // 直接拿各台自报的 epoch 相减是没意义的 —— 采集本身就横跨十几秒。
  const hostEpoch = Number((sections.DATE || [])[1]) || null
  const clockSkewSeconds = hostEpoch != null && meta.localEpoch ? hostEpoch - meta.localEpoch : null
  const lxd = sections.LXDMETA ? buildLxdView(sections, null) : null
  const gpu = buildGpuView(sections)
  const profiles = parseProfiles((sections.PROFILES || []).join(''))
  const profileAudit = buildProfileAudit(profiles, parseProfileSources(sections.PROFSRC))

  return {
    ...server,
    status: meta.status || 'ok',
    error: meta.error || null,
    hostname: (sections.HOST || [])[0] || '',
    kernel: (sections.KERNEL || [])[0] || '',
    probedAt: (sections.DATE || [])[0] || meta.probedAt || null,
    uptimeSeconds: Number((sections.UPTIME || [])[0]) || null,
    hostEpoch,
    clockSkewSeconds,
    isRoot: uidLine === '0',
    scannedNas: Boolean(meta.scanNas),
    // 真实容量 = LXD 存储池；系统盘降级到 hostDisk 折叠区
    capacity: lxd?.pool || primary,
    capacityKind: lxd?.pool ? 'lxd-pool' : 'local-disk',
    primary,
    lxd,
    gpu,
    profiles,
    profileAudit,
    snap: parseSnap(sections.SNAP),
    time: parseTimeFacts(sections.TIME),
    mounts: localMounts,
    localMounts,
    networkMounts,
    nasScans,
    allMounts: mounts,
    accounts: lxd ? lxd.containers : accounts,
    homeAccounts: accounts,
    totals: {
      accountCount: (lxd ? lxd.containers : accounts).filter((a) => a.usedBytes > 0).length,
      accountSumBytes: (lxd ? lxd.containers : accounts).reduce((s, a) => s + (a.usedBytes || 0), 0),
      containerCount: lxd?.totals.containerCount ?? 0,
      runningCount: lxd?.totals.runningCount ?? 0,
      homeSumBytes: [...homes.values()].reduce((s, h) => s + h.totalBytes, 0),
      quotaSourceCount: quota.size,
      homeDirCount: homes.size,
      zfsAvailable: lxd?.zfsAvailable ?? false,
    },
  }
}

function pickPrimary(localMounts, allMounts) {
  if (localMounts.length > 0) {
    const root = localMounts.find((m) => m.mount === '/')
    const home = localMounts.find((m) => m.mount === '/home')
    if (home) return home
    if (root) return root
    return localMounts.reduce((a, b) => (b.totalBytes > a.totalBytes ? b : a))
  }
  const real = allMounts.filter((m) => !m.pseudo)
  return real.length ? real.reduce((a, b) => (b.totalBytes > a.totalBytes ? b : a)) : null
}

/* ------------------------------------------------------------------ *
 * Cross-server shared storage
 *
 * Every machine mounts the same NAS, so df numbers repeat nine times. Group by
 * share source, keep one copy, and attach the depth-one breakdown from whoever
 * actually scanned it.
 * ------------------------------------------------------------------ */
export function buildSharedStorage(records) {
  const bySource = new Map()

  for (const r of records) {
    if (r.status !== 'ok') continue
    for (const m of r.networkMounts) {
      const key = m.source || m.mount
      if (!bySource.has(key)) {
        bySource.set(key, {
          source: m.source,
          type: m.type,
          mounts: [],
          seenOn: [],
          totalBytes: m.totalBytes,
          usedBytes: m.usedBytes,
          availBytes: m.availBytes,
          usedPercent: m.usedPercent,
          scans: [],
        })
      }
      const share = bySource.get(key)
      if (!share.mounts.includes(m.mount)) share.mounts.push(m.mount)
      if (!share.seenOn.includes(r.id)) share.seenOn.push(r.id)
      // 同一共享在不同机器上 df 可能有毫秒级差异，取最大值
      share.totalBytes = Math.max(share.totalBytes, m.totalBytes)
      share.usedBytes = Math.max(share.usedBytes, m.usedBytes)
    }
  }

  for (const r of records) {
    if (r.status !== 'ok') continue
    for (const scan of r.nasScans || []) {
      const share = bySource.get(scan.source || scan.mount)
      if (!share) continue
      if (!share.scans.some((s) => s.mount === scan.mount)) {
        share.scans.push({ ...scan, scannedBy: r.id })
      }
    }
  }

  return [...bySource.values()].map((share) => {
    const scan = share.scans[0] || null
    const children = scan ? scan.children : []
    const childSum = children.reduce((s, c) => s + c.bytes, 0)
    return {
      source: share.source,
      type: share.type,
      mounts: share.mounts,
      seenOn: share.seenOn.sort(),
      totalBytes: share.totalBytes,
      usedBytes: share.usedBytes,
      availBytes: share.availBytes,
      usedPercent: share.usedPercent,
      // du 出来的只是这个共享目录树自己的量，和 df 的整设备量不是一回事
      contentBytes: scan ? scan.totalBytes : null,
      contentLooseBytes: scan ? Math.max(0, scan.totalBytes - childSum) : null,
      children,
      scannedBy: scan ? scan.scannedBy : null,
    }
  })
}

/* ------------------------------------------------------------------ *
 * Transport —— 见 ssh.mjs（和体检、终端共用同一条连接方式）
 * ------------------------------------------------------------------ */

const EMPTY_TOTALS = {
  accountCount: 0,
  accountSumBytes: 0,
  containerCount: 0,
  runningCount: 0,
  homeSumBytes: 0,
  quotaSourceCount: 0,
  homeDirCount: 0,
  zfsAvailable: false,
}

export async function collectServer(server, { scanNas = false } = {}) {
  const started = Date.now()
  let conn
  try {
    conn = await openConnection(server)
    const execEpoch = Math.round(Date.now() / 1000)
    // 第一阶段绝不 exec 容器：那要等 Node 按 location 过滤完，才知道该 exec 哪几个
    const { stdout, stderr, code } = await exec(
      conn,
      buildRemoteScript({ scanNas, execFallback: false }),
      scanNas ? CONFIG.nasExecTimeout : CONFIG.execTimeout,
    )
    const sections = splitSections(stdout)
    const record = buildServerRecord(server, sections, {
      status: 'ok',
      probedAt: new Date().toISOString(),
      scanNas,
      localEpoch: execEpoch,
    })
    // zfs 拿不到（多数机器 /dev/zfs 是 root-only）时，补一次只针对本机容器的 df
    if (CONFIG.containerDfFallback && record.lxd && !record.lxd.zfsAvailable && record.lxd.containers.length) {
      const names = record.lxd.containers.filter((c) => c.source === 'none').map((c) => c.name)
      if (names.length) {
        const second = await exec(conn, buildContainerDfScript(names), CONFIG.execTimeout)
        applyContainerDf(record.lxd, splitSections(second.stdout).CDF)
        record.accounts = record.lxd.containers
        record.totals.accountCount = record.lxd.totals.accountCount
        record.totals.accountSumBytes = record.lxd.totals.containerSumBytes
      }
    }
    record.exitCode = code
    record.stderr = (stderr || '').split(/\r?\n/).filter(Boolean).slice(0, 4).join(' | ')
    record.durationMs = Date.now() - started
    conn.end()
    return record
  } catch (err) {
    if (conn) try { conn.end() } catch { /* ignore */ }
    return {
      ...server,
      status: 'error',
      error: err.message || String(err),
      hostname: '',
      accounts: [],
      homeAccounts: [],
      mounts: [],
      localMounts: [],
      networkMounts: [],
      nasScans: [],
      primary: null,
      capacity: null,
      capacityKind: null,
      lxd: null,
      gpu: null,
      profiles: [],
      profileAudit: { issues: [], info: [], missingSources: [] },
      snap: [],
      time: null,
      scannedNas: false,
      totals: { ...EMPTY_TOTALS },
      durationMs: Date.now() - started,
    }
  }
}

export async function collectAll(servers, scannerId) {
  const scanner = scannerId || CONFIG.nasScanner || servers[0]?.id
  const queue = [...servers]
  const results = new Array(servers.length)
  let slot = 0
  const workers = Array.from({ length: Math.min(CONFIG.concurrency, servers.length) }, async () => {
    while (queue.length) {
      const server = queue.shift()
      const at = slot++
      results[at] = await collectServer(server, { scanNas: server.id === scanner })
    }
  })
  await Promise.all(workers)
  return results
}
