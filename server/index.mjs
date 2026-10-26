import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { CONFIG, loadServers, ROOT } from './config.mjs'
import { collectAll, collectServer, buildSharedStorage } from './collect.mjs'
import { CHECKS, runChecks, unknownCheckIds } from './checks.mjs'
import { buildClusterView } from './cluster.mjs'
import { buildDriverMatrix } from './gpu.mjs'
import { buildPortLedger, classifyLedger, conclude, diagnosePorts, probePorts, runIpChecks, memberIpMap, reconcileIpCheck, setGateway } from './ports.mjs'
import { buildQuotaAdvice } from './quota.mjs'
import { attachTerminal } from './terminal.mjs'
import { httpGuard } from './guard.mjs'
import { mockServers } from './mock.mjs'

const MOCK = process.env.MOCK === '1' || process.env.MOCK === 'true'

const app = express()
app.use(httpGuard)
app.use(express.json())

let snapshot = null
let inFlight = null

function summarise(servers, extra = {}) {
  const online = servers.filter((s) => s.status === 'ok')
  return {
    servers: servers.length,
    online: online.length,
    offline: servers.length - online.length,
    // 存储池按台相加（共享 NAS 单独算，不在这里重复计数）
    capacityBytes: online.reduce((s, x) => s + (x.capacity?.totalBytes || 0), 0),
    usedBytes: online.reduce((s, x) => s + (x.capacity?.usedBytes || 0), 0),
    accountBytes: online.reduce((s, x) => s + x.totals.accountSumBytes, 0),
    accounts: online.reduce((s, x) => s + x.totals.accountCount, 0),
    containers: online.reduce((s, x) => s + (x.lxd?.totals.containerCount || 0), 0),
    ...extra,
  }
}

function withShared(servers, extraFields = {}) {
  const shared = buildSharedStorage(servers)
  const scannedBy = servers.filter((s) => s.scannedNas).map((s) => s.id)
  return {
    generatedAt: new Date().toISOString(),
    servers,
    shared,
    cluster: buildClusterView(servers),
    drivers: buildDriverMatrix(servers),
    summary: {
      ...summarise(servers),
      sharedShares: shared.length,
      scannedBy,
      ...extraFields,
    },
  }
}

function persistSnapshot(next) {
  if (MOCK) return // 模拟数据不落盘，避免下次真实启动时当成缓存
  try {
    fs.mkdirSync(path.dirname(CONFIG.cacheFile), { recursive: true })
    fs.writeFileSync(CONFIG.cacheFile, JSON.stringify(next, null, 2))
  } catch (err) {
    console.warn(`[api] 快照写入缓存失败: ${err.message}`)
  }
}

function loadCachedSnapshot() {
  try {
    if (fs.existsSync(CONFIG.cacheFile)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG.cacheFile, 'utf8'))
      if (raw && Array.isArray(raw.servers)) {
        // 模拟数据与真实快照必须严格隔离（两个方向都不能串）
        if (Boolean(raw.mock) !== MOCK) return null
        if (!Array.isArray(raw.shared)) raw.shared = buildSharedStorage(raw.servers)
        // 旧缓存里没有这两个字段，按现有 servers 补算，别让新版块空着
        if (!Array.isArray(raw.cluster)) raw.cluster = buildClusterView(raw.servers)
        if (!raw.drivers) raw.drivers = buildDriverMatrix(raw.servers)
        return raw
      }
    }
  } catch (err) {
    console.warn(`[api] 缓存快照读取失败: ${err.message}`)
  }
  return null
}

async function refreshAll(servers) {
  const startedAt = Date.now()
  console.log(`[api] ${MOCK ? '生成模拟数据' : '开始采集'} ${servers.length} 台服务器…`)
  const results = MOCK ? mockServers() : await collectAll(servers)
  const durationMs = Date.now() - startedAt
  const next = withShared(results, { durationMs })
  next.mock = MOCK
  next.durationMs = durationMs
  snapshot = next
  persistSnapshot(next)
  const bad = results.filter((r) => r.status !== 'ok')
  const scanned = results.filter((r) => r.scannedNas).map((r) => r.id)
  console.log(
    `[api] 采集完成 (${next.durationMs}ms) — 成功 ${results.length - bad.length}/${results.length}` +
      `；共享存储 ${next.shared.length} 份，由 ${scanned.join(',') || '—'} 扫描` +
      (bad.length ? `；失败: ${bad.map((b) => `${b.id}: ${b.error}`).join('; ')}` : ''),
  )
  return next
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mock: MOCK,
    keyConfigured: MOCK || Boolean(CONFIG.apiKey && fs.existsSync(CONFIG.apiKey)),
    keyPath: CONFIG.apiKey,
    passwordConfigured: Boolean(CONFIG.sshPassword),
    servers: loadServers().length,
    hasSnapshot: Boolean(snapshot),
  })
})

app.get('/api/space', (req, res) => {
  const wantFresh = req.query.fresh === '1'
  if (snapshot && !wantFresh) return res.json(snapshot)
  if (!snapshot) {
    const cached = loadCachedSnapshot()
    if (cached && !wantFresh) {
      snapshot = cached
      return res.json({ ...cached, fromCache: true })
    }
  }
  res.status(202).json({ pending: true, message: '尚未有快照，请 POST /api/refresh' })
})

app.post('/api/refresh', async (req, res) => {
  try {
    const servers = loadServers()
    const target = typeof req.query.server === 'string' ? req.query.server : null
    if (!inFlight) {
      inFlight = refreshAll(servers).finally(() => { inFlight = null })
    }
    const current = await inFlight
    if (target) {
      const one = current.servers.find((s) => s.id === target)
      if (!one) return res.status(404).json({ error: `未知服务器 ${target}` })
      return res.json({ server: one, generatedAt: current.generatedAt })
    }
    res.json(current)
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) })
  }
})

app.post('/api/refresh/:id', async (req, res) => {
  try {
    const server = loadServers().find((s) => s.id === req.params.id)
    if (!server) return res.status(404).json({ error: `未知服务器 ${req.params.id}` })
    if (MOCK) {
      const all = mockServers()
      const payload = withShared(all, { durationMs: 0 })
      payload.mock = true
      snapshot = payload
      return res.json({
        server: all.find((m) => m.id === server.id),
        shared: payload.shared,
        cluster: payload.cluster,
        drivers: payload.drivers,
        summary: payload.summary,
        generatedAt: payload.generatedAt,
      })
    }
    const record = await collectServer(server, { scanNas: server.id === CONFIG.nasScanner })
    if (!record) return res.status(404).json({ error: `没有采到 ${server.id}` })
    const base = snapshot || { servers: [] }
    const servers = base.servers.slice()
    const idx = servers.findIndex((s) => s.id === server.id)
    if (idx >= 0) servers[idx] = record
    else servers.push(record)
    snapshot = withShared(servers, { durationMs: record.durationMs })
    snapshot.mock = MOCK
    persistSnapshot(snapshot)
    // cluster/drivers/summary 必须一起回，否则单台刷新后集群面板和总览还是旧值
    res.json({
      server: record,
      shared: snapshot.shared,
      cluster: snapshot.cluster,
      drivers: snapshot.drivers,
      summary: snapshot.summary,
      generatedAt: snapshot.generatedAt,
    })
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) })
  }
})

app.get('/api/servers/:id', (req, res) => {
  const src = snapshot || loadCachedSnapshot()
  const found = src?.servers?.find((s) => s.id === req.params.id)
  if (!found) return res.status(404).json({ error: '尚未采集到该服务器' })
  res.json({ server: found })
})

/* ------------------------------------------------------------------ *
 * 端口台账与配额
 * ------------------------------------------------------------------ */

function snapshotServers() {
  const src = snapshot || loadCachedSnapshot()
  if (src) snapshot = src
  const servers = src?.servers || []
  // 端口/探测命令里的"外部地址"以实际机器为准（也可用 GATEWAY_HOST 覆盖）
  if (servers.length) setGateway(CONFIG.gatewayHost || servers[0].host)
  return servers
}

/* ---- 体检 / 端口检查的最近一次结果（总览页用，刷新浏览器也还在）---- */
const CHECK_CACHE_FILE = path.join(ROOT, '.cache', 'checks.json')
const PORT_CACHE_FILE = path.join(ROOT, '.cache', 'ports.json')

function readJson(file, fallback) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data))
  } catch (err) {
    console.warn(`[api] 写缓存失败 ${file}: ${err.message}`)
  }
}

/** 只留总览/抽屉要用的部分，别把整份 stdout 塞进缓存 */
function compactCheck(r) {
  return {
    container: r.container,
    server: r.server,
    member: r.member,
    status: r.status,
    verdict: r.verdict,
    ranAt: r.ranAt,
    hostDriver: r.hostDriver || '',
    error: r.error || '',
    total: (r.results || []).length,
    passed: (r.results || []).filter((x) => x.status === 'pass').length,
    fails: (r.results || []).filter((x) => x.status === 'fail' || x.status === 'error')
      .map((x) => ({ id: x.id, title: x.title, detail: x.detail, commands: x.commands || [] })),
    warns: (r.results || []).filter((x) => x.status === 'warn').map((x) => ({ id: x.id, title: x.title, detail: x.detail })),
  }
}

function recordChecks(list) {
  const cur = readJson(CHECK_CACHE_FILE, { containers: {}, updatedAt: null })
  for (const c of list) if (c.container) cur.containers[c.container] = c
  cur.updatedAt = new Date().toISOString()
  writeJson(CHECK_CACHE_FILE, cur)
}

app.get('/api/checks/last', (_req, res) => {
  const data = readJson(CHECK_CACHE_FILE, { containers: {}, updatedAt: null })
  res.json({ updatedAt: data.updatedAt, containers: Object.values(data.containers || {}) })
})

app.get('/api/ports/last', (_req, res) => {
  const cache = readJson(PORT_CACHE_FILE, { ranAt: null, rows: [], verdicts: {} })
  const servers = snapshotServers()
  if (cache.ipCheck && servers.length) {
    const ledger = buildPortLedger(servers)
    cache.ipCheck = reconcileIpCheck(cache.ipCheck, ledger.rows)
  }
  res.json(cache)
})

app.get('/api/ports', (_req, res) => {
  const servers = snapshotServers()
  if (servers.length === 0) return res.status(202).json({ pending: true, message: '还没有快照，先 POST /api/refresh' })
  const ledger = buildPortLedger(servers)
  // 把上次的 IP 核对结果按当前台账校正后再给前端，避免"明明一致却报错"
  const cachedIp = readJson(PORT_CACHE_FILE, {}).ipCheck
  res.json({ ...classifyLedger(ledger), ipCheck: cachedIp ? reconcileIpCheck(cachedIp, ledger.rows) : null })
})

app.post('/api/ports/probe', async (req, res) => {
  try {
    const servers = snapshotServers()
    if (servers.length === 0) return res.status(202).json({ pending: true, message: '还没有快照，先 POST /api/refresh' })
    const ledger = buildPortLedger(servers)
    const body = req.body || {}
    const only = Array.isArray(body.ports) && body.ports.length
      ? ledger.rows.filter((r) => body.ports.includes(r.listenPort))
      : ledger.rows
    const startedAt = Date.now()
    const probes = await probePorts(only, { concurrency: body.concurrency, timeout: body.timeout || CONFIG.probeTimeout })
    const out = classifyLedger(ledger, probes)
    // 只回探测过的那些行，界面自己合并
    const probedPorts = new Set(probes.keys())
    res.json({ ...out, rows: out.rows.filter((r) => probedPorts.has(r.listenPort)), durationMs: Date.now() - startedAt })
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) })
  }
})

/**
 * 转发目标 vs 容器实际 IP。
 * 手册里的两步：`lxc config device show <容器>` 看 connect，`lxc exec <容器> -- hostname -I` 看实际地址。
 * 这里对全部 66 条 proxy 一次跑完，不一致的直接给改 connect 的命令。
 */
app.post('/api/ports/ipcheck', async (req, res) => {
  try {
    const servers = snapshotServers()
    if (servers.length === 0) return res.status(202).json({ pending: true, message: '还没有快照，先 POST /api/refresh' })
    const ledger = buildPortLedger(servers)
    if (ledger.rows.length === 0) return res.json({ rows: [], counts: {}, mismatches: [], errors: [] })
    const startedAt = Date.now()
    const out = await runIpChecks(servers, ledger, memberIpMap(servers))
    const prevCache = readJson(PORT_CACHE_FILE, {})
    writeJson(PORT_CACHE_FILE, {
      ...prevCache,
      ipCheck: {
        ranAt: out.ranAt,
        counts: out.counts,
        // 全量存（66 条），抽屉和总览都要按容器查
        rows: out.rows.map((r) => ({
          container: r.container,
          host: r.host,
          device: r.device,
          listenPort: r.listenPort,
          connectHost: r.connectHost,
          connectPort: r.connectPort,
          actualIps: r.actualIps,
          ipVerdict: r.ipVerdict,
          ipDetail: r.ipDetail,
          ipSwapWith: r.ipSwapWith || '',
          ipFix: r.ipFix || [],
        })),
        mismatches: out.mismatches.map((r) => ({
          container: r.container,
          host: r.host,
          listenPort: r.listenPort,
          connectHost: r.connectHost,
          connectPort: r.connectPort,
          actualIps: r.actualIps,
          ipVerdict: r.ipVerdict,
          ipDetail: r.ipDetail,
          ipSwapWith: r.ipSwapWith || '',
          ipFix: r.ipFix || [],
        })),
      },
    })
    res.json({ ...out, durationMs: Date.now() - startedAt })
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) })
  }
})

app.get('/api/quota', (_req, res) => {
  const servers = snapshotServers()
  if (servers.length === 0) return res.status(202).json({ pending: true, message: '还没有快照，先 POST /api/refresh' })
  res.json(buildQuotaAdvice(servers))
})

/**
 * 一次做完：外部探测 → 对不通的端口去所在成员确认 LXD 有没有在听 → 出结论。
 * 手册里"两处必须一起改"的那类不同步，就是靠这一步定责的。
 */
app.post('/api/ports/check', async (req, res) => {
  try {
    const servers = snapshotServers()
    if (servers.length === 0) return res.status(202).json({ pending: true, message: '还没有快照，先 POST /api/refresh' })
    const body = req.body || {}
    const ledger = buildPortLedger(servers)
    const startedAt = Date.now()
    const probes = await probePorts(ledger.rows, {
      concurrency: Number(body.concurrency) || 8,
      timeout: Number(body.timeout) || CONFIG.probeTimeout,
    })
    const classified = classifyLedger(ledger, probes)
    const diagnosis = body.localCheck === false ? new Map() : await diagnosePorts(classified.rows, servers)
    const rows = conclude(classified.rows, diagnosis)
    const verdicts = rows.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc }, {})
    const durationMs = Date.now() - startedAt
    const prevCache = readJson(PORT_CACHE_FILE, {})
    writeJson(PORT_CACHE_FILE, {
      ...prevCache,
      ranAt: new Date().toISOString(),
      durationMs,
      verdicts,
      conflicts: ledger.conflicts.length,
      rows: rows.map((r) => ({ container: r.container, host: r.host, listenPort: r.listenPort, verdict: r.verdict, advice: r.advice })),
    })
    res.json({
      ...classified,
      rows,
      verdicts,
      conflicts: ledger.conflicts,
      containersWithoutPort: ledger.containersWithoutPort,
      durationMs,
    })
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) })
  }
})
/* ------------------------------------------------------------------ *
 * 账户体检
 * ------------------------------------------------------------------ */

const JOBS = new Map()
const JOB_TTL_MS = 30 * 60 * 1000

function newJob(kind) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
  const job = { id, kind, total: 0, done: 0, items: [], errors: [], startedAt: new Date().toISOString(), finished: false }
  JOBS.set(id, job)
  for (const [key, old] of JOBS) {
    if (old.finished && Date.now() - new Date(old.startedAt).getTime() > JOB_TTL_MS) JOBS.delete(key)
  }
  return job
}

/** 配额信息从上一次快照里拿，体检就不用再跑一次 zfs。 */
function quotaEnrich() {
  const src = snapshot || loadCachedSnapshot()
  const map = new Map()
  for (const s of src?.servers || []) {
    for (const c of s.lxd?.containers || []) {
      map.set(c.name, { quotaBytes: c.quotaBytes ?? null, usedPercent: c.usedPercent ?? null })
    }
  }
  return map
}

function guardMock(res) {
  if (!MOCK) return false
  res.status(409).json({ error: '当前是 MOCK 模式，体检要连真机。去掉 MOCK=1 再启动后端。' })
  return true
}

app.get('/api/checks', (_req, res) => {
  res.json({
    checks: CHECKS.map((c) => ({
      id: c.id,
      title: c.title,
      group: c.group,
      manual: c.manual,
      command: c.cmd,
      timeout: c.timeout,
      optIn: Boolean(c.optIn),
    })),
  })
})

app.post('/api/check', async (req, res) => {
  if (guardMock(res)) return
  const body = req.body || {}
  const container = typeof body.container === 'string' ? body.container.trim() : ''
  if (!container) return res.status(400).json({ error: '缺少 container' })
  const ids = Array.isArray(body.ids) && body.ids.length ? body.ids : undefined
  const badIds = unknownCheckIds(ids)
  if (badIds.length) return res.status(400).json({ error: `未知的检查项：${badIds.join('、')}` })
  const servers = loadServers()
  if (body.server && !servers.some((x) => x.id === body.server)) {
    return res.status(400).json({ error: `未知服务器 ${body.server}` })
  }
  try {
    const out = await runChecks({
      servers,
      scope: 'container',
      container,
      server: body.server || undefined,
      ids,
      includeSlow: Boolean(body.includeSlow),
      enrich: quotaEnrich(),
    })
    if (!out.items.length) return res.status(404).json({ error: '没有采到结果' })
    recordChecks((out.items || []).map(compactCheck))
    res.json(out.items[0] || null)
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) })
  }
})

app.post('/api/check/batch', (req, res) => {
  if (guardMock(res)) return
  const body = req.body || {}
  const scope = body.scope === 'all' ? 'all' : 'server'
  if (scope === 'server' && !body.server) return res.status(400).json({ error: '缺少 server' })
  const badIds = unknownCheckIds(Array.isArray(body.ids) && body.ids.length ? body.ids : undefined)
  if (badIds.length) return res.status(400).json({ error: `未知的检查项：${badIds.join('、')}` })
  const servers = loadServers()
  if (body.server && !servers.some((x) => x.id === body.server)) {
    return res.status(400).json({ error: `未知服务器 ${body.server}` })
  }
  runChecks({
    servers,
    scope,
    server: body.server,
    ids: Array.isArray(body.ids) && body.ids.length ? body.ids : undefined,
    includeSlow: Boolean(body.includeSlow),
    enrich: quotaEnrich(),
    onProgress: ({ done, total, last }) => {
      job.done = done
      job.total = total
      if (last) job.items.push(last)
    },
  })
    .then((out) => {
      job.errors = out.errors
      job.finished = true
      job.finishedAt = new Date().toISOString()
      recordChecks(job.items.map(compactCheck))
    })
    .catch((err) => {
      job.error = err.message || String(err)
      job.finished = true
    })
  res.json({ jobId: job.id })
})

app.get('/api/check/job/:id', (req, res) => {
  const job = JOBS.get(req.params.id)
  if (!job) return res.status(404).json({ error: '这个体检任务已经不在了' })
  res.json(job)
})

setGateway(CONFIG.gatewayHost || loadServers()[0]?.host)
const srv = app.listen(CONFIG.apiPort, '127.0.0.1', () => {
  console.log(`[api] http://127.0.0.1:${CONFIG.apiPort}  密钥: ${CONFIG.apiKey}`)
  console.log(
    `[api] 容器终端已开启（仅 127.0.0.1）；宿主机 shell ${CONFIG.allowHostTerminal ? '已打开，风险自担' : '默认关闭（ALLOW_HOST_TERMINAL=1 才开）'}`,
  )
  const cached = loadCachedSnapshot()
  if (cached) console.log(`[api] 已加载上次快照 (${cached.generatedAt})`)
})

attachTerminal(srv, { servers: loadServers() })

srv.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[api] 端口 ${CONFIG.apiPort} 已被占用，说明已经有一个实例在跑。`)
    console.error(`      直接用原来的那个就行；要先停掉它：`)
    console.error(`        netstat -ano | findstr :${CONFIG.apiPort}`)
    console.error(`        taskkill /PID <上面查到的数字> /F\n`)
    process.exit(1)
  }
  throw err
})
