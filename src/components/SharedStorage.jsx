import { formatBytes, formatPercent, usageTone } from '../lib/format.js'
import UsageBar from './UsageBar.jsx'

/**
 * 共享存储单独一块：9 台机器挂的是同一个共享，按 source 去重只算一份，
 * 并且把 df 的“整台 NAS 设备”和 du 的“这个共享自己的内容量”分开展示。
 */
export default function SharedStorage({ shares, onSelectServer }) {
  if (!shares || shares.length === 0) {
    return (
      <section className="shared">
        <h2 className="shared-title">共享存储</h2>
        <p className="empty">没有检测到网络挂载（cifs / nfs）</p>
      </section>
    )
  }

  return (
    <section className="shared">
      <div className="shared-head">
        <h2 className="shared-title">共享存储</h2>
        <span className="shared-sub">
          按挂载源去重 · {shares.length} 份 · 不是每台各一份
        </span>
      </div>

      {shares.map((sh) => {
        const tone = usageTone(sh.usedPercent)
        const max = sh.children.reduce((m, c) => Math.max(m, c.bytes), 0) || 1
        return (
          <div className="share" key={sh.source || sh.mounts[0]}>
            <div className="share-top">
              <div className="share-id">
                <code className="share-src">{sh.source}</code>
                <span className="muted"> → {sh.mounts.join(', ')} ({sh.type})</span>
              </div>
              <div className="share-count">
                <span className="muted">挂在</span>
                <div className="td-servers">
                  {sh.seenOn.map((id) => (
                    <button type="button" key={id} className="srv-chip" onClick={() => onSelectServer(id)}>
                      {id}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="share-grid">
              <div className="share-cell">
                <div className="cell-label">
                  整台 NAS 设备 <span className="hint" title="df 在 cifs 上返回的是导出方整个卷的用量，不只是这个共享">?</span>
                </div>
                <div className="cell-big">
                  <span className={`tone-${tone}`}>{formatBytes(sh.usedBytes)}</span>
                  <span className="muted"> / {formatBytes(sh.totalBytes)}</span>
                </div>
                <UsageBar percent={sh.usedPercent} tone={tone} showTicks />
                <div className="cell-foot">
                  <span className={`tone-${tone}`}>{formatPercent(sh.usedPercent)}</span>
                  <span className="dot">·</span>
                  <span>剩 {formatBytes(sh.availBytes)}</span>
                </div>
              </div>

              <div className="share-cell">
                <div className="cell-label">
                  这个共享的内容量 <span className="hint" title={sh.scannedBy ? `由 ${sh.scannedBy} 扫描 du` : '未扫描'}>?</span>
                </div>
                <div className="cell-big">
                  <span>{sh.contentBytes != null ? formatBytes(sh.contentBytes) : '未扫描'}</span>
                  <span className="muted">{sh.contentBytes != null ? `  (${formatPercent(sh.totalBytes ? (sh.contentBytes / sh.totalBytes) * 100 : null)} 的设备容量)` : ''}</span>
                </div>
                {sh.children.length > 0 && (
                  <ul className="share-kids">
                    {sh.children.slice(0, 8).map((c) => (
                      <li key={c.path}>
                        <span className="kid-name" title={c.path}>{c.name}</span>
                        <span className="kid-bar">
                          <UsageBar percent={(c.bytes / max) * 100} tone="accent" />
                        </span>
                        <span className="kid-size">{formatBytes(c.bytes)}</span>
                      </li>
                    ))}
                    {sh.contentLooseBytes > 0 && (
                      <li className="kid-loose">
                        <span className="kid-name">该层零散文件</span>
                        <span className="kid-bar" />
                        <span className="kid-size muted">{formatBytes(sh.contentLooseBytes)}</span>
                      </li>
                    )}
                    {sh.children.length > 8 && (
                      <li className="kid-loose muted">… 另外 {sh.children.length - 8} 项</li>
                    )}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </section>
  )
}
