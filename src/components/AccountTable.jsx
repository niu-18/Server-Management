import { Fragment, useState } from 'react'
import { formatBytes, formatPercent, usageTone } from '../lib/format.js'
import UsageBar from './UsageBar.jsx'

const SOURCE_LABEL = { quota: '配额', du: 'du', none: '无数据' }

const COLUMNS = [
  { key: 'name', label: '账户', align: 'left' },
  { key: 'usedBytes', label: '占用', align: 'right' },
  { key: 'share', label: '相对占比', align: 'left' },
  { key: 'hardBytes', label: '配额上限', align: 'right' },
  { key: 'percentOfQuota', label: '配额使用', align: 'right' },
  { key: 'source', label: '口径', align: 'left' },
]

/** 账户行可以展开看 home 直属子目录，数据来自同一次 du 扫描。 */
export default function AccountTable({ accounts, query, sort, onSort, emptyText = '没有匹配的账户' }) {
  const [open, setOpen] = useState(() => new Set())
  const max = accounts.reduce((m, a) => Math.max(m, a.usedBytes || 0), 0) || 1

  const toggle = (name) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  if (accounts.length === 0) return <div className="empty">{emptyText}</div>

  return (
    <table className="table">
      <thead>
        <tr>
          <th className="th-left" style={{ width: 22 }} />
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
          <th className="th-left">Home</th>
        </tr>
      </thead>
      <tbody>
        {accounts.map((a) => {
          const rel = (a.usedBytes / max) * 100
          const kidMax = a.children.reduce((m, c) => Math.max(m, c.bytes), 0) || 1
          const isOpen = open.has(a.name)
          const expandable = a.children.length > 0
          return (
            <Fragment key={a.name}>
              <tr className={isOpen ? 'row-open' : ''}>
                <td className="td-toggle">
                  {expandable ? (
                    <button
                      type="button"
                      className={`twisty ${isOpen ? 'open' : ''}`}
                      onClick={() => toggle(a.name)}
                      aria-label={isOpen ? '收起' : '展开子目录'}
                    >
                      ▸
                    </button>
                  ) : (
                    <span className="twisty-sp" />
                  )}
                </td>
                <td className="td-name">
                  <span
                    className={`acct-name ${expandable ? 'clickable' : ''}`}
                    title={expandable ? '点开看 home 里什么最占地方' : (a.home || '')}
                    onClick={expandable ? () => toggle(a.name) : undefined}
                  >
                    {a.name}
                  </span>
                  {a.uid != null && <span className="acct-uid">uid {a.uid}</span>}
                </td>
                <td className="td-num">{formatBytes(a.usedBytes)}</td>
                <td className="td-share">
                  <UsageBar percent={rel} tone={rel > 80 ? 'high' : 'low'} />
                  <span className="td-share-num">{formatPercent(rel)}</span>
                </td>
                <td className="td-num">{a.hardBytes ? formatBytes(a.hardBytes) : '—'}</td>
                <td className={`td-num ${a.percentOfQuota != null ? `tone-${usageTone(a.percentOfQuota)}` : 'muted'}`}>
                  {a.percentOfQuota == null ? '—' : formatPercent(a.percentOfQuota)}
                </td>
                <td>
                  <span className={`chip chip-${a.source}`}>{SOURCE_LABEL[a.source] || a.source}</span>
                </td>
                <td className="td-path muted" title={a.home || ''}>{a.home || '—'}</td>
              </tr>

              {isOpen && expandable && (
                <tr key={`${a.name}-kids`} className="row-kids">
                  <td colSpan={8}>
                    <ul className="kid-list">
                      {a.children.map((c) => (
                        <li key={c.path}>
                          <span className="kid-name" title={c.path}>{c.name}</span>
                          <span className="kid-bar">
                            <UsageBar percent={(c.bytes / kidMax) * 100} tone="accent" />
                          </span>
                          <span className="kid-size">{formatBytes(c.bytes)}</span>
                          <span className="kid-share muted">
                            {formatPercent(a.usedBytes ? (c.bytes / a.usedBytes) * 100 : null)}
                          </span>
                        </li>
                      ))}
                      {a.looseBytes > 0 && (
                        <li className="kid-loose">
                          <span className="kid-name">home 根下零散文件</span>
                          <span className="kid-bar" />
                          <span className="kid-size">{formatBytes(a.looseBytes)}</span>
                          <span className="kid-share muted">
                            {formatPercent(a.usedBytes ? (a.looseBytes / a.usedBytes) * 100 : null)}
                          </span>
                        </li>
                      )}
                      {a.children.length === 0 && <li className="muted">这个 home 下没有子目录</li>}
                    </ul>
                  </td>
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}
