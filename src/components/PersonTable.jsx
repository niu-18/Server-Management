import { useMemo } from 'react'
import { formatBytes, formatPercent, usageTone } from '../lib/format.js'
import UsageBar from './UsageBar.jsx'

const COLUMNS = [
  { key: 'owner', label: '姓名 / 账户', align: 'left' },
  { key: 'usedBytes', label: '总用量', align: 'right' },
  { key: 'share', label: '全局占比', align: 'left' },
  { key: 'quotaBytes', label: '配额合计', align: 'right' },
  { key: 'worstPercent', label: '最满的容器', align: 'right' },
  { key: 'containers', label: '容器', align: 'left' },
]

/** 容器名是「姓名-学号」，同一个人常常有多个容器、甚至跨机器，所以按姓名聚合。 */
export default function PersonTable({ servers, query, sort, onSort }) {
  const rows = useMemo(() => {
    const map = new Map()
    let grand = 0
    const touch = (key) => {
      if (!map.has(key)) {
        map.set(key, { owner: key, usedBytes: 0, quotaBytes: 0, worstPercent: null, containers: [], servers: new Set(), orphanBytes: 0 })
      }
      return map.get(key)
    }
    for (const s of servers) {
      if (s.status !== 'ok' || !s.lxd) continue
      for (const c of s.lxd.containers) {
        const row = touch(c.owner || c.name)
        row.usedBytes += c.usedBytes || 0
        row.quotaBytes += c.quotaBytes || 0
        if (c.usedPercent != null && (row.worstPercent == null || c.usedPercent > row.worstPercent)) {
          row.worstPercent = c.usedPercent
        }
        row.containers.push({ name: c.name, host: s.id, usedBytes: c.usedBytes, percent: c.usedPercent, status: c.status })
        row.servers.add(s.id)
      }
      // 迁移残留也记在该人头上：不这样算，一个人的真实足迹会被低估
      for (const o of s.lxd.orphanDatasets || []) {
        const owner = o.name.replace(/-[^-]*$/, '')
        const row = touch(owner)
        row.usedBytes += o.usedBytes || 0
        row.orphanBytes += o.usedBytes || 0
        row.quotaBytes += o.quotaBytes || 0
        row.containers.push({ name: o.name, host: s.id, usedBytes: o.usedBytes, percent: null, status: '残留' })
        row.servers.add(s.id)
      }
      grand += s.lxd.totals.containerSumBytes + (s.lxd.totals.orphanSumBytes || 0)
    }
    const list = [...map.values()]
    for (const r of list) {
      r.share = grand > 0 ? (r.usedBytes / grand) * 100 : 0
      r.containers.sort((a, b) => b.usedBytes - a.usedBytes)
    }
    return list
  }, [servers])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = q ? rows.filter((r) => r.owner.toLowerCase().includes(q)) : rows.slice()
    const dir = sort.dir === 'asc' ? 1 : -1
    out.sort((a, b) => {
      const av = a[sort.key]
      const bv = b[sort.key]
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av ?? '').localeCompare(String(bv ?? '')) * dir
      }
      if (Array.isArray(av) || Array.isArray(bv)) return (av?.length ?? 0) - (bv?.length ?? 0) * dir
      return ((av ?? -Infinity) - (bv ?? -Infinity)) * dir
    })
    return out
  }, [rows, query, sort])

  if (rows.length === 0) return <div className="empty">还没有采集到任何容器数据</div>
  if (filtered.length === 0) return <div className="empty">没有匹配 “{query}” 的人</div>

  const max = filtered.reduce((m, r) => Math.max(m, r.usedBytes), 0) || 1

  return (
    <table className="table">
      <thead>
        <tr>
          {COLUMNS.map((c) => (
            <th key={c.key} className={`th-${c.align}`}>
              <button type="button" className={`th-btn ${sort.key === c.key ? 'active' : ''}`} onClick={() => onSort(c.key)}>
                {c.label}
                {sort.key === c.key && <span className="th-arrow">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {filtered.map((r) => (
          <tr key={r.owner} className={r.worstPercent != null && r.worstPercent >= 90 ? 'row-hot' : ''}>
            <td className="td-name">
              <span className="acct-name">{r.owner}</span>
              {r.orphanBytes > 0 && (
                <span className="orphan-flag" title={`其中 ${formatBytes(r.orphanBytes)} 是迁移残留数据集，不在任何运行实例上`}>
                  含残留 {formatBytes(r.orphanBytes)}
                </span>
              )}
            </td>
            <td className="td-num">{formatBytes(r.usedBytes)}</td>
            <td className="td-share">
              <UsageBar percent={(r.usedBytes / max) * 100} tone="accent" />
              <span className="td-share-num">{formatPercent(r.share)}</span>
            </td>
            <td className="td-num">{r.quotaBytes ? formatBytes(r.quotaBytes) : '—'}</td>
            <td className={`td-num ${r.worstPercent != null ? `tone-${usageTone(r.worstPercent)}` : 'muted'}`}>
              {formatPercent(r.worstPercent)}
            </td>
            <td className="td-containers">
              {r.containers.map((c) => (
                <span
                  key={`${c.host}/${c.name}`}
                  className={`ctn ${c.percent != null && c.percent >= 90 ? 'ctn-hot' : ''} ${c.status === 'Stopped' ? 'ctn-stopped' : ''} ${c.status === '残留' ? 'ctn-orphan' : ''}`}
                  title={`${c.name} @ ${c.host}：${formatBytes(c.usedBytes)}${c.percent != null ? ` / ${formatPercent(c.percent)}` : ''} (${c.status})`}
                >
                  {c.name.split('-').slice(1).join('-') || c.name}
                  <em>{c.host}</em>
                </span>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
