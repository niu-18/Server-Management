import { formatBytes, formatPercent, usageTone } from '../lib/format.js'
import UsageBar from './UsageBar.jsx'

export default function ServerCard({ server, selected, onSelect, sharedWorst }) {
  const offline = server.status !== 'ok'
  const cap = server.capacity || server.primary
  const pct = offline ? null : cap?.usedPercent ?? null
  const tone = usageTone(pct)
  const nearFull = pct != null && pct >= 80
  const lxd = server.lxd

  return (
    <button
      type="button"
      className={`card ${selected ? 'is-selected' : ''} ${offline ? 'is-offline' : ''}`}
      onClick={() => onSelect(server.id)}
    >
      <div className="card-head">
        <span className="card-id">{server.id}</span>
        <span className="card-host" title={lxd?.pool ? `存储池 ${lxd.pool.name} (${lxd.pool.driver})` : (server.hostname || '')}>
          {offline ? '离线' : lxd?.pool ? `池 ${lxd.pool.name}` : server.hostname || server.host}
        </span>
        <span className={`card-pct tone-${tone}`}>{offline ? '—' : formatPercent(pct)}</span>
      </div>

      <UsageBar percent={pct} tone={tone} showTicks />

      <div className="card-meta">
        {offline ? (
          <span className="card-error" title={server.error || ''}>{server.error || '无法连接'}</span>
        ) : (
          <>
            <span>{formatBytes(cap?.usedBytes)} / {formatBytes(cap?.totalBytes)}</span>
            <span className="dot">·</span>
            <span>{lxd?.totals.containerCount ?? 0} 容器</span>
          </>
        )}
      </div>

      {!offline && (
        <div className="card-tags">
          {lxd && !lxd.zfsAvailable && (
            <span className="tag tag-warn" title="没有只读 zfs 权限，容器用量退化成 lxc exec + df，停着的容器取不到">
              无 zfs 权限
            </span>
          )}
          {lxd && lxd.zfsAvailable && <span className="tag">zfs</span>}
          {lxd && server.networkMounts?.length > 0 && sharedWorst != null && (
            <span className={`tag tone-${usageTone(sharedWorst.usedPercent)}`} title="9 台挂的是同一个共享，见顶部共享存储">
              共享 {formatPercent(sharedWorst.usedPercent)}
            </span>
          )}
        </div>
      )}

      {nearFull && <div className="card-warn">剩余 {formatBytes(cap?.availBytes)}</div>}
    </button>
  )
}
