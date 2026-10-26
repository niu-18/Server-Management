import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { jsonFetch, postJson, sleep } from '../lib/api.js'
import { formatAgo } from '../lib/format.js'
import { SectionHeader } from './ui.jsx'

const ICON = { pass: '✓', warn: '!', fail: '✗', error: '×', skip: '–' }
const VERDICT_TEXT = { pass: '通过', warn: '注意', fail: '不通过', error: '取不到', skip: '不适用' }

/**
 * 体检版块：批量体检 + 结果清单。单个容器点开是抽屉（体检 + 终端 + 端口都在那儿），
 * 所以这里不再放"选一个容器再看详情"的两栏布局。
 */
export default function HealthSection({ servers, results, onOpenContainer, onRefreshSummary }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [includeSlow, setIncludeSlow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [job, setJob] = useState(null)
  const [target, setTarget] = useState('')

  const containers = useMemo(() => {
    const out = []
    for (const s of servers || []) {
      for (const c of s.lxd?.containers || []) {
        out.push({ name: c.name, host: c.location || s.id, status: c.status })
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }, [servers])

  const byName = useMemo(() => new Map((results || []).map((r) => [r.container, r])), [results])

  const rows = useMemo(() => {
    const list = containers.map((c) => {
      const r = byName.get(c.name)
      return { ...c, check: r || null, verdict: r?.verdict || 'unchecked' }
    })
    const q = query.trim().toLowerCase()
    return list.filter((r) => {
      if (filter === 'fail' && !(r.verdict === 'fail' || r.verdict === 'error')) return false
      if (filter === 'unchecked' && r.verdict !== 'unchecked') return false
      if (filter === 'done' && r.verdict === 'unchecked') return false
      if (!q) return true
      return `${r.name} ${r.host} ${r.verdict}`.toLowerCase().includes(q)
    })
  }, [containers, byName, query, filter])

  const counts = useMemo(() => {
    const all = containers.map((c) => byName.get(c.name)?.verdict || 'unchecked')
    return {
      total: all.length,
      fail: all.filter((v) => v === 'fail' || v === 'error').length,
      warn: all.filter((v) => v === 'warn').length,
      pass: all.filter((v) => v === 'pass').length,
      unchecked: all.filter((v) => v === 'unchecked').length,
    }
  }, [containers, byName])

  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  const runBatch = useCallback(async (scope) => {
    setBusy(true)
    setError(null)
    setJob({ done: 0, total: 0, items: [], finished: false })
    try {
      const { body } = await postJson('/api/check/batch', { scope, includeSlow })
      // 组件卸载（切版块）后必须停止轮询，否则后台会一直跑十几分钟
      for (let i = 0; i < 900 && aliveRef.current; i += 1) {
        await sleep(1200)
        if (!aliveRef.current) return
        const { body: j } = await jsonFetch(`/api/check/job/${body.jobId}`)
        if (!aliveRef.current) return
        setJob(j)
        if (j.finished) break
      }
      await onRefreshSummary?.()
    } catch (e) {
      setError(`批量体检失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [includeSlow, onRefreshSummary])

  return (
    <div className="health">
      <div className="panel">
        <SectionHeader
          level={3}
          title="批量体检"
          sub="全集群 65 个容器一轮约 3–4 分钟（每个容器 4–6 秒，9 台并行）。结果会自动存下来，总览页和徽标都用它。"
        >
          <label className="toggle">
            <input type="checkbox" checked={includeSlow} onChange={(e) => setIncludeSlow(e.target.checked)} />
            <span>含 torch 慢检查</span>
          </label>
          <button type="button" className="btn btn-small" disabled={busy || !target} onClick={() => runBatch('server')}>体检单机</button>
          <select className="select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="选择机器">
            <option value="">选一台…</option>
            {(servers || []).map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
          <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => runBatch('all')}>
            {busy ? '体检中…' : '全集群体检'}
          </button>
        </SectionHeader>

        {error && <div className="banner banner-error">{error}<button type="button" className="banner-x" onClick={() => setError(null)}>×</button></div>}

        {job && (
          <div className="progress-box">
            <div className="progress-row">
              <span>{job.finished ? '完成' : '进行中'} {job.done}/{job.total || '…'}</span>
              <span className="muted">{job.items.slice(-1).map((i) => i.container).join('')}</span>
            </div>
            <div className="progress-track"><div className="progress-fill" style={{ width: `${job.total ? Math.round((job.done / job.total) * 100) : 2}%` }} /></div>
            <div className="batch-list">
              {job.items.slice(-10).reverse().map((it) => (
                <button type="button" key={it.container} className={`ctn ctn-${it.verdict}`} onClick={() => onOpenContainer?.(it.container, it.server, 'check')}>
                  {ICON[it.verdict] || '?'} {it.container}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="health-stats">
          <span className="hstat"><b>{counts.total}</b> 个容器</span>
          <span className="hstat tone-low"><b>{counts.pass}</b> 通过</span>
          <span className="hstat tone-high"><b>{counts.warn}</b> 注意</span>
          <span className="hstat tone-critical"><b>{counts.fail}</b> 不通过</span>
          <span className="hstat muted"><b>{counts.unchecked}</b> 未体检</span>
        </div>
      </div>

      <div className="panel">
        <SectionHeader level={3} title="体检结果" sub="点一行打开抽屉：逐项结果、命令原文、修法、终端都在那儿">
          <div className="seg">
            {[['all', '全部'], ['fail', '不通过'], ['done', '已体检'], ['unchecked', '未体检']].map(([k, label]) => (
              <button type="button" key={k} className={`seg-btn ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
          <input className="search" type="search" placeholder="搜容器 / 机器…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </SectionHeader>

        <table className="table table-compact">
          <thead>
            <tr>
              <th className="th-left">容器</th>
              <th className="th-left">成员</th>
              <th className="th-left">判定</th>
              <th className="th-left">通过</th>
              <th className="th-left">不通过的项</th>
              <th className="th-left">最近体检</th>
              <th className="th-right">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className={r.verdict === 'fail' || r.verdict === 'error' ? 'row-hot' : ''}>
                <td className="td-name">
                  <button type="button" className="acct-name clickable" onClick={() => onOpenContainer?.(r.name, r.host, 'check')}>{r.name}</button>
                  {r.status !== 'Running' && <span className="acct-uid">{r.status}</span>}
                </td>
                <td className="td-num muted">{r.host}</td>
                <td>
                  <span className={`st st-${r.verdict === 'unchecked' ? 'none' : r.verdict === 'pass' ? 'pass' : r.verdict === 'warn' ? 'warn' : 'fail'}`}>
                    {r.verdict === 'unchecked' ? '·' : ICON[r.verdict] || '?'}
                  </span>
                  <span className="muted"> {r.verdict === 'unchecked' ? '未体检' : VERDICT_TEXT[r.verdict] || r.verdict}</span>
                </td>
                <td className="td-num">{r.check ? `${r.check.passed}/${r.check.total}` : '—'}</td>
                <td className="td-detail">
                  {r.check?.fails?.length ? r.check.fails.map((f) => <span className="chip chip-hot" key={f.id}>{f.title}</span>) : r.check?.warns?.length ? <span className="muted">{r.check.warns.length} 项注意</span> : <span className="muted">—</span>}
                </td>
                <td className="td-num muted">{r.check?.ranAt ? formatAgo(r.check.ranAt) : '—'}</td>
                <td className="th-right">
                  <button type="button" className="btn btn-tiny" onClick={() => onOpenContainer?.(r.name, r.host, 'terminal')}>终端</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="empty">没有匹配的容器</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
