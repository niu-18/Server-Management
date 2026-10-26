import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes, formatPercent, formatClock, formatAgo, usageTone } from './lib/format.js'
import { jsonFetch } from './lib/api.js'
import ServerCard from './components/ServerCard.jsx'
import ServerDetail from './components/ServerDetail.jsx'
import PersonTable from './components/PersonTable.jsx'
import SharedStorage from './components/SharedStorage.jsx'
import HealthSection from './components/HealthSection.jsx'
import ClusterHealth from './components/ClusterHealth.jsx'
import GpuMatrix from './components/GpuMatrix.jsx'
import PortsSection from './components/PortsSection.jsx'
import OverviewSection from './components/OverviewSection.jsx'
import ContainerDrawer from './components/ContainerDrawer.jsx'
import { SectionHeader, Toaster } from './components/ui.jsx'
import UsageBar from './components/UsageBar.jsx'

const SECTIONS = [
  { id: 'overview', label: '总览', mark: '总', ready: true },
  { id: 'space', label: '空间占用', mark: '空', ready: true },
  { id: 'health', label: '账户体检', mark: '检', ready: true },
  { id: 'ports', label: '端口与配额', mark: '端', ready: true },
  { id: 'infra', label: '集群与显卡', mark: '集', ready: true },
  { id: 'process', label: '进程 / 负载', mark: '进', ready: false },
  { id: 'users', label: '用户与台账', mark: '用', ready: false },
]

const AUTO_MS = 5 * 60 * 1000
const THEME_KEY = 'srvman-theme'

function initialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* 隐私模式下 localStorage 会抛 */ }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** #/health?container=demo-24002&server=s0 —— 深链能直接打开某个容器的抽屉 */
function parseHash() {
  const raw = (window.location.hash || '').replace(/^#\/?/, '')
  if (!raw) return null
  const [seg, qs] = raw.split('?')
  const params = new URLSearchParams(qs || '')
  return {
    section: SECTIONS.some((s) => s.id === seg && s.ready) ? seg : null,
    container: params.get('container') || '',
    server: params.get('server') || '',
  }
}

export default function App() {
  const [snapshot, setSnapshot] = useState(null)
  const [selectedId, setSelectedId] = useState('s0')
  const [mode, setMode] = useState('server')
  const [section, setSection] = useState('overview')
  const [drawer, setDrawer] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [auto, setAuto] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [aggQuery, setAggQuery] = useState('')
  const [aggSort, setAggSort] = useState({ key: 'usedBytes', dir: 'desc' })
  const [health, setHealth] = useState(null)
  const [theme, setTheme] = useState(initialTheme)
  const [summaryData, setSummaryData] = useState({ quota: null, checks: { containers: [] }, ports: { rows: [] } })
  const startedAt = useRef(0)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem(THEME_KEY, theme) } catch { /* 忽略 */ }
  }, [theme])

  /** 汇总用的三份缓存数据（配额、最近体检、最近端口检查），都很便宜 */
  const loadSummary = useCallback(async () => {
    try {
      const [q, c, p] = await Promise.all([
        jsonFetch('/api/quota'),
        jsonFetch('/api/checks/last'),
        jsonFetch('/api/ports/last'),
      ])
      setSummaryData({
        quota: q.body?.pending ? null : q.body,
        checks: c.body || { containers: [] },
        ports: p.body || { rows: [] },
      })
    } catch { /* 缺一块不影响主界面 */ }
  }, [])

  useEffect(() => { loadSummary() }, [loadSummary, snapshot?.generatedAt])
  // 每次切回总览都重新汇总一次（都是本地缓存，毫秒级），避免体检/端口检查后数字还是旧的
  useEffect(() => { if (section === 'overview') loadSummary() }, [section, loadSummary])

  // 深链
  useEffect(() => {
    const apply = () => {
      const b = parseHash()
      if (!b) return
      if (b.section) setSection(b.section)
      if (b.container) setDrawer({ container: b.container, server: b.server, want: 'check', stamp: Date.now() })
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [])

  const skipHashSync = useRef(true)
  useEffect(() => {
    if (skipHashSync.current) { skipHashSync.current = false; return }
    const q = drawer?.container
      ? `?container=${encodeURIComponent(drawer.container)}${drawer.server ? `&server=${encodeURIComponent(drawer.server)}` : ''}`
      : ''
    const next = `#/${section}${q}`
    if (next !== window.location.hash) window.history.replaceState(null, '', next)
  }, [section, drawer])

  useEffect(() => {
    const s = SECTIONS.find((x) => x.id === section)
    document.title = `服务器管理 · ${s?.label || '总览'}`
  }, [section])

  const servers = snapshot?.servers ?? []
  const shares = useMemo(() => snapshot?.shared ?? [], [snapshot])

  const mergeRecord = useCallback((payload) => {
    setSnapshot((prev) => {
      if (!prev) return prev
      const next = prev.servers.slice()
      const idx = next.findIndex((s) => s.id === payload.server.id)
      if (idx >= 0) next[idx] = payload.server
      else next.push(payload.server)
      return {
        ...prev,
        servers: next,
        shared: payload.shared ?? prev.shared,
        // 单台刷新也会带回 cluster/drivers/summary，必须一起合并，否则集群面板还是旧值
        cluster: payload.cluster ?? prev.cluster,
        drivers: payload.drivers ?? prev.drivers,
        summary: payload.summary ? { ...prev.summary, ...payload.summary } : prev.summary,
        generatedAt: payload.generatedAt || new Date().toISOString(),
      }
    })
  }, [])

  const refreshAll = useCallback(async () => {
    setBusy(true)
    setError(null)
    startedAt.current = Date.now()
    try {
      const { body } = await jsonFetch('/api/refresh', { method: 'POST' })
      setSnapshot(body)
      if (body.servers?.length && !body.servers.some((s) => s.id === selectedId)) setSelectedId(body.servers[0].id)
    } catch (e) {
      setError(`刷新失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [selectedId])

  const refreshOne = useCallback(async (id) => {
    setBusy(true)
    setError(null)
    startedAt.current = Date.now()
    try {
      const { body } = await jsonFetch(`/api/refresh/${id}`, { method: 'POST' })
      if (body.server) mergeRecord(body)
    } catch (e) {
      setError(`刷新 ${id} 失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [mergeRecord])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const h = await jsonFetch('/api/health')
        if (alive) setHealth(h.body)
        const s = await jsonFetch('/api/space')
        if (!alive) return
        if (s.body.pending || !s.body.servers) {
          await refreshAll()
        } else {
          setSnapshot(s.body)
          const first = s.body.servers.find((x) => x.status === 'ok') ?? s.body.servers[0]
          if (first) setSelectedId(first.id)
        }
      } catch (e) {
        if (alive) setError(`后端未响应：${e.message}。请确认 npm run dev 已启动。`)
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!busy) { setElapsed(0); return }
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)), 500)
    return () => clearInterval(t)
  }, [busy])

  useEffect(() => {
    if (!auto || busy) return
    const t = setTimeout(() => { refreshAll() }, AUTO_MS)
    return () => clearTimeout(t)
  }, [auto, busy, snapshot?.generatedAt, refreshAll])

  const selected = useMemo(() => servers.find((s) => s.id === selectedId) ?? null, [servers, selectedId])

  const summary = useMemo(() => {
    const online = servers.filter((s) => s.status === 'ok')
    const capacity = online.reduce((a, s) => a + (s.capacity?.totalBytes || 0), 0)
    const used = online.reduce((a, s) => a + (s.capacity?.usedBytes || 0), 0)
    const worstLocal = online.map((s) => ({ id: s.id, pct: s.capacity?.usedPercent ?? 0 })).sort((a, b) => b.pct - a.pct)[0]
    return {
      total: servers.length,
      online: online.length,
      capacity,
      used,
      pct: capacity > 0 ? (used / capacity) * 100 : null,
      containers: online.reduce((a, s) => a + (s.lxd?.containers?.length || 0), 0),
      running: online.reduce((a, s) => a + (s.lxd?.totals?.runningCount || 0), 0),
      containerBytes: online.reduce((a, s) => a + (s.lxd?.totals?.containerSumBytes || 0), 0),
      noZfs: online.filter((s) => s.lxd && !s.lxd.zfsAvailable).map((s) => s.id),
      worstLocal,
    }
  }, [servers])

  const worstShare = useMemo(() => (shares.length ? shares.reduce((a, b) => ((b.usedPercent ?? 0) > (a.usedPercent ?? 0) ? b : a)) : null), [shares])

  const badges = useMemo(() => {
    const clusterAlerts = (snapshot?.cluster || []).flatMap((c) => c.alerts || [])
    const checkFails = (summaryData.checks.containers || []).filter((c) => c.verdict === 'fail' || c.verdict === 'error').length
    const quotaHot = summaryData.quota?.hot || []
    const portRows = (summaryData.ports.rows || []).filter((r) => r.verdict === 'no_forward' || r.verdict === 'no_listener')
    const ipBad = (summaryData.ports.ipCheck?.mismatches || []).filter((r) => r.ipVerdict !== 'no_ip')
    const critical = clusterAlerts.filter((a) => a.level === 'critical').length
      + checkFails
      + quotaHot.filter((r) => r.level === 'critical').length
      + portRows.filter((r) => r.verdict === 'no_listener').length
      + ipBad.length
    return {
      overview: critical,
      space: quotaHot.filter((r) => r.level === 'critical').length,
      health: checkFails,
      ports: portRows.length + ipBad.length,
      infra: clusterAlerts.length,
    }
  }, [snapshot, summaryData])

  const noKey = health && !health.keyConfigured
  const scannedByLabel = snapshot?.summary?.scannedBy?.join('、') || 's0'
  const openContainer = useCallback((container, server, want = 'check') => {
    setDrawer({ container, server, want, stamp: Date.now() })
  }, [])

  const nav = (
    <nav className="sb-nav" aria-label="版块">
      {SECTIONS.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`nav-item ${s.id === section ? 'active' : ''} ${s.ready ? '' : 'disabled'}`}
          disabled={!s.ready}
          title={s.ready ? s.label : '还没做'}
          onClick={() => s.ready && setSection(s.id)}
        >
          <span className="nav-mark" aria-hidden="true">{s.mark}</span>
          <span className="nav-label">{s.label}</span>
          {badges[s.id] > 0 && <span className={`nav-badge ${s.id === 'infra' ? 'soft' : ''}`}>{badges[s.id]}</span>}
          {!s.ready && <span className="nav-soon">待建</span>}
        </button>
      ))}
    </nav>
  )

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sb-brand">
          <span className="brand-mark">◧</span>
          <div>
            <h1>服务器管理</h1>
            <p className="brand-sub">10.0.0.10 · s0–s8</p>
          </div>
        </div>
        {nav}
        <div className="sb-foot">
          <div className="sb-age">
            <span className={busy ? 'tone-accent' : ''}>{busy ? `采集中 ${elapsed}s…` : `更新 ${formatAgo(snapshot?.generatedAt)}`}</span>
            <span className="sb-clock">{formatClock(snapshot?.generatedAt)}</span>
          </div>
          <button type="button" className="btn btn-primary sb-refresh" onClick={() => refreshAll()} disabled={busy}>
            {busy ? '刷新中…' : '刷新全部'}
          </button>
          <div className="sb-tools">
            <label className="toggle">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              <span>自动</span>
            </label>
            <button
              type="button"
              className="theme-btn"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
              aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>
          <p className="sb-hint">API :8787 · Web :5173</p>
        </div>
      </aside>

      <main className="main">
        {error && <div className="banner banner-error">{error}<button type="button" className="banner-x" onClick={() => setError(null)}>×</button></div>}
        {snapshot?.mock && <div className="banner banner-warn">当前显示的是 <strong>模拟数据</strong>（MOCK=1），不是真实服务器。</div>}
        {noKey && (
          <div className="banner banner-warn">
            后端找不到密钥 <code>{health.keyPath}</code>。先运行 <code>npm run install-key</code> 把公钥装到 9 台机器。
          </div>
        )}

        {section === 'overview' && (
          <>
            <SectionHeader
              title="总览"
              sub="先看这张「需要你处理」，再决定去哪一块。所有判定都来自最近一次采集、体检和端口检查的结果，鼠标停在数字上能看到口径。"
            />
            <OverviewSection
              snapshot={snapshot}
              servers={servers}
              summaryData={summaryData}
              busy={busy}
              onRefresh={refreshAll}
              onReload={loadSummary}
              onNavigate={(id, opts) => {
                if (opts?.server) setSelectedId(opts.server)
                setSection(id)
              }}
              onOpenContainer={openContainer}
            />
          </>
        )}

        {section === 'space' && (
          <>
            <SectionHeader
              title="空间占用"
              sub={`真实容量在 LXD 的 ZFS 池上（df 看不见）；账户就是容器。存储 ${formatBytes(summary.capacity, 1)}，已用 ${formatBytes(summary.used, 1)}（${formatPercent(summary.pct)}），容器已归因 ${formatBytes(summary.containerBytes, 1)}。`}
            >
              <div className="seg">
                <button type="button" className={`seg-btn ${mode === 'server' ? 'active' : ''}`} onClick={() => setMode('server')}>单机明细</button>
                <button type="button" className={`seg-btn ${mode === 'aggregate' ? 'active' : ''}`} onClick={() => setMode('aggregate')}>按人汇总</button>
              </div>
            </SectionHeader>

            <div className="summary">
              <div className="summary-main">
                <div className="summary-block"><span className="s-k">存储池合计</span><span className="s-v">{formatBytes(summary.capacity, 1)}</span></div>
                <div className="summary-block"><span className="s-k">已用</span><span className={`s-v tone-${usageTone(summary.pct)}`}>{formatBytes(summary.used, 1)}</span></div>
                <div className="summary-block"><span className="s-k">整体使用率</span><span className={`s-v tone-${usageTone(summary.pct)}`}>{formatPercent(summary.pct)}</span></div>
                <div className="summary-block"><span className="s-k">最紧张</span><span className={`s-v tone-${usageTone(summary.worstLocal?.pct)}`}>{summary.worstLocal ? `${summary.worstLocal.id} ${formatPercent(summary.worstLocal.pct)}` : '—'}</span></div>
                <div className="summary-block"><span className="s-k">容器</span><span className="s-v">{summary.containers}<span className="s-u"> 运行 {summary.running}</span></span></div>
                <div className="summary-block"><span className="s-k">共享 NAS</span><span className={`s-v tone-${usageTone(worstShare?.usedPercent)}`}>{worstShare ? formatPercent(worstShare.usedPercent) : '—'}</span></div>
              </div>
              <div className="summary-bar">
                <div className="summary-bar-row">
                  <span>全部存储池</span>
                  <span className={`tone-${usageTone(summary.pct)}`}>{formatPercent(summary.pct)}</span>
                </div>
                <UsageBar percent={summary.pct} tone={usageTone(summary.pct)} showTicks />
                <p className="summary-hint">
                  {summary.worstLocal && `最紧张 ${summary.worstLocal.id} ${formatPercent(summary.worstLocal.pct)}`}
                  {worstShare?.contentBytes != null && ` · 共享内容 ${formatBytes(worstShare.contentBytes, 1)}`}
                </p>
              </div>
            </div>

            {summary.noZfs.length > 0 && !snapshot?.mock && (
              <div className="banner banner-warn">
                {summary.noZfs.join('、')} 上没有可执行的 zfs，容器用量走 <code>lxc exec + df</code>（只覆盖运行中的容器）。
                要覆盖停着的：先装 <code>zfsutils-linux</code>，再跑 <code>npm run setup-root</code>。
              </div>
            )}

            <SharedStorage shares={shares} onSelectServer={(id) => { setSelectedId(id); setMode('server') }} />

            {mode === 'server' ? (
              <div className="layout">
                <div className="col-cards">
                  {servers.length === 0 && !busy && <div className="empty">还没有数据，点“刷新全部”开始采集</div>}
                  {busy && servers.length === 0 && <div className="empty">首次采集进行中…</div>}
                  <div className="cards">
                    {servers.map((s) => (
                      <ServerCard
                        key={s.id}
                        server={s}
                        sharedWorst={worstShare}
                        selected={s.id === selectedId}
                        onSelect={(id) => setSelectedId(id)}
                      />
                    ))}
                  </div>
                </div>
                <div className="col-detail">
                  <ServerDetail
                    server={selected}
                    busy={busy}
                    onRefreshOne={() => refreshOne(selectedId)}
                    onInspect={(container, want) => openContainer(container, selectedId, want)}
                  />
                </div>
              </div>
            ) : (
              <div className="panel">
                <SectionHeader title="按人汇总" sub="容器名是「姓名-学号」，同一个人在多台机器上的多个容器加在一起" level={3}>
                  <input className="search" type="search" placeholder="搜索姓名…" value={aggQuery} onChange={(e) => setAggQuery(e.target.value)} />
                </SectionHeader>
                <PersonTable
                  servers={servers}
                  query={aggQuery}
                  sort={aggSort}
                  onSort={(key) => setAggSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'owner' ? 'asc' : 'desc' }))}
                />
              </div>
            )}
          </>
        )}

        {section === 'health' && (
          <>
            <SectionHeader
              title="账户体检"
              sub="9 项只读检查，全部不需要 root；判定 GPU 时和容器所在成员的驱动比。点任意一行打开抽屉看逐项结果、修法和终端。"
            />
            <HealthSection
              servers={servers}
              results={summaryData.checks.containers || []}
              onOpenContainer={openContainer}
              onRefreshSummary={loadSummary}
            />
          </>
        )}

        {section === 'ports' && (
          <>
            <SectionHeader
              title="端口与配额"
              sub="台账来自 LXD proxy；外部不通时会登到成员确认 LXD 到底有没有在听，从而分清是路由器缺转发还是 proxy 没生效。"
            />
            <PortsSection onOpenContainer={openContainer} onChecked={loadSummary} />
          </>
        )}

        {section === 'infra' && (
          <>
            <SectionHeader
              title="集群与显卡"
              sub={`两台集群（7 节点 + 2 节点）。宿主驱动 ${(snapshot?.drivers?.versions || []).length} 套：${(snapshot?.drivers?.versions || []).join(' / ') || '—'}。`}
            >
              <span className="sec-tag">{summary.online}/{summary.total} 台在线</span>
            </SectionHeader>
            <div className="panel">
              <ClusterHealth clusters={snapshot?.cluster || []} />
              <div className="section">
                <SectionHeader level={3} title="宿主驱动与显卡矩阵" sub="点开一行看每张卡的显存、利用率、温度和上面的进程归属" />
                <GpuMatrix servers={servers} drivers={snapshot?.drivers || { rows: [], versions: [], consistent: true }} />
              </div>
            </div>
          </>
        )}

        <footer className="foot">
          <span>采集：LXD 存储池 + 容器数据集（zfs，无权限时退化 lxc exec df）+ 宿主 df + 共享 NAS（由 {scannedByLabel} 扫一次）</span>
          <span className="dot">·</span>
          <span>只读工具：所有修复都只生成命令，不代执行</span>
        </footer>
      </main>

      <ContainerDrawer
        target={drawer}
        servers={servers}
        ipRows={summaryData.ports?.ipCheck?.rows || []}
        onClose={() => setDrawer(null)}
        onChecked={loadSummary}
      />
      <Toaster />
    </div>
  )
}
