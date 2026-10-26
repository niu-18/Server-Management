import { formatBytes, formatPercent, usageTone } from '../lib/format.js'
import UsageBar from './UsageBar.jsx'

const COLUMNS = [
  { key: 'name', label: '容器 / 账户', align: 'left' },
  { key: 'usedBytes', label: '已用', align: 'right' },
  { key: 'usedPercent', label: '配额使用率', align: 'left' },
  { key: 'quotaBytes', label: '配额', align: 'right' },
  { key: 'availBytes', label: '剩余', align: 'right' },
  { key: 'status', label: '状态', align: 'left' },
  { key: 'source', label: '口径', align: 'left' },
]

const SOURCE_CN = { zfs: 'zfs 数据集', df: '容器内 df', none: '未取到' }

export default function ContainerTable({ containers, query, sort, onSort, onInspect, emptyText = '没有匹配的容器' }) {
  const rows = (query ? containers.filter((c) => c.name.toLowerCase().includes(query.toLowerCase())) : containers)
    .slice()
    .sort((a, b) => {
      const dir = sort.dir === 'asc' ? 1 : -1
      const av = a[sort.key]
      const bv = b[sort.key]
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av ?? '').localeCompare(String(bv ?? '')) * dir
      }
      return ((av ?? -Infinity) - (bv ?? -Infinity)) * dir
    })

  if (rows.length === 0) return <div className="empty">{emptyText}</div>

  const maxUsed = rows.reduce((m, c) => Math.max(m, c.usedBytes || 0), 0) || 1

  return (
    <table className="table">
      <thead>
        <tr>
          {COLUMNS.map((c) => (
            <th key={c.key} className={`th-${c.align}`}>
              <button
                type="button"
                className={`th-btn ${sort.key === c.key ? 'active' : ''}`}
                onClick={() => onSort(c.key)}
              >
                {c.label}
                {sort.key === c.key && <span className="th-arrow">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
              </button>
            </th>
          ))}
          <th className="th-left">IPv4</th>
          <th className="th-left">操作</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => {
          const over = c.usedPercent != null && c.usedPercent >= 90
          return (
            <tr key={c.name} className={over ? 'row-hot' : ''}>
              <td className="td-name">
                <span className="acct-name" title={c.dataset || ''}>{c.name}</span>
              </td>
              <td className="td-num">{formatBytes(c.usedBytes)}</td>
              <td className="td-share">
                <UsageBar
                  percent={c.usedPercent ?? (maxUsed ? (c.usedBytes / maxUsed) * 100 : 0)}
                  tone={usageTone(c.usedPercent)}
                  showTicks={c.usedPercent != null}
                />
                <span className="td-share-num">{formatPercent(c.usedPercent)}</span>
              </td>
              <td className="td-num">{c.quotaBytes ? formatBytes(c.quotaBytes) : '无配额'}</td>
              <td className="td-num">{c.availBytes != null ? formatBytes(c.availBytes) : '—'}</td>
              <td>
                <span className={`state state-${(c.status || '').toLowerCase()}`}>{c.status || '—'}</span>
              </td>
              <td>
                <span className={`chip chip-${c.source === 'zfs' ? 'quota' : c.source === 'df' ? 'du' : 'none'}`}>
                  {SOURCE_CN[c.source] || c.source}
                </span>
              </td>
              <td className="td-path muted">{c.ipv4 || '—'}</td>
              <td className="td-act">
                {onInspect && (
                  <>
                    <button type="button" className="btn btn-tiny" onClick={() => onInspect(c.name)} title="跑一遍账户体检">体检</button>
                    <button type="button" className="btn btn-tiny" onClick={() => onInspect(c.name, 'terminal')} title="进容器终端（只影响你自己看的窗口）">终端</button>
                  </>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
