import { useMemo, useState } from 'react'
import { formatBytes, formatPercent, formatUptime, usageTone } from '../lib/format.js'
import ContainerTable from './ContainerTable.jsx'
import AccountTable from './AccountTable.jsx'
import UsageBar from './UsageBar.jsx'

export default function ServerDetail({ server, busy, onRefreshOne, onInspect }) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState({ key: 'usedBytes', dir: 'desc' })
  const [showHost, setShowHost] = useState(false)

  const lxd = server?.lxd
  const cap = server?.capacity || server?.primary

  const containers = useMemo(() => (lxd ? lxd.containers : []), [lxd])
  const orphans = useMemo(() => (lxd?.orphanDatasets || []), [lxd])
  const orphanSum = orphans.reduce((a, o) => a + (o.usedBytes || 0), 0)
  const orphanMax = orphans.reduce((m, o) => Math.max(m, o.usedBytes || 0), 0)

  if (!server) return <div className="panel panel-empty">从左侧选择一台服务器</div>

  if (server.status !== 'ok') {
    return (
      <div className="panel">
        <div className="detail-head">
          <div>
            <h2>{server.id}</h2>
            <p className="muted">{server.user}@{server.host}:{server.port}</p>
          </div>
          <button type="button" className="btn" onClick={onRefreshOne} disabled={busy}>
            {busy ? '重试中…' : '重试'}
          </button>
        </div>
        <div className="error-box">
          <strong>连接失败</strong>
          <p>{server.error}</p>
          <ul className="muted">
            <li>确认这台机器是否在跑、端口是否正确</li>
            <li>终端排查：<code>npm run probe -- {server.id}</code></li>
          </ul>
        </div>
      </div>
    )
  }

  const sortHandler = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }))

  return (
    <div className="panel">
      <div className="detail-head">
        <div className="detail-title">
          <h2>{server.id}</h2>
          <div className="detail-sub">
            <span>{server.hostname}</span>
            <span className="dot">·</span>
            <span>{lxd ? `${lxd.pool?.name} 池 (${lxd.pool?.driver})` : '无 LXD'}</span>
            <span className="dot">·</span>
            <span>运行 {formatUptime(server.uptimeSeconds)}</span>
          </div>
        </div>
        <button type="button" className="btn" onClick={onRefreshOne} disabled={busy}>
          {busy ? '采集中…' : '只刷新这台'}
        </button>
      </div>

      <div className="kv-grid">
        <div className="kv">
          <span className="kv-k">池容量</span>
          <span className="kv-v">{formatBytes(cap?.totalBytes)}</span>
        </div>
        <div className="kv">
          <span className="kv-k">已用</span>
          <span className={`kv-v tone-${usageTone(cap?.usedPercent)}`}>{formatBytes(cap?.usedBytes)}</span>
        </div>
        <div className="kv">
          <span className="kv-k">剩余</span>
          <span className="kv-v">{formatBytes(cap?.availBytes)}</span>
        </div>
        <div className="kv">
          <span className="kv-k">使用率</span>
          <span className={`kv-v tone-${usageTone(cap?.usedPercent)}`}>{formatPercent(cap?.usedPercent)}</span>
        </div>
        <div className="kv">
          <span className="kv-k">容器</span>
          <span className="kv-v">
            {lxd?.totals.containerCount ?? 0}
            <span className="s-u"> 运行 {lxd?.totals.runningCount ?? 0}</span>
          </span>
        </div>
        <div className="kv">
          <span className="kv-k">容器合计</span>
          <span className="kv-v">{formatBytes(lxd?.totals.containerSumBytes)}</span>
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <h3>容器 / 账户占用</h3>
          <input
            className="search"
            type="search"
            placeholder="搜索容器名…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {lxd && !lxd.zfsAvailable && (
          <p className="note note-warn">
            这台没有可执行的 <code>zfs</code>（LXD snap 自带那份缺 <code>libcrypto.so.1.1</code>，在 snap 外跑不起来），
            所以容器用量走 <code>lxc exec + df</code>：只有<strong>运行中</strong>的容器能取到，停着的显示“未取到”。
            要覆盖停着的，需先在这台装 <code>zfsutils-linux</code>，再跑 <code>npm run setup-root</code>。
          </p>
        )}
        {lxd && lxd.zfsAvailable && (
          <p className="note">
            口径为 <code>zfs list</code> 的每个容器数据集，含停着的容器；配额取 dataset 的 quota。
          </p>
        )}
        {!lxd && <p className="note">这台机器上没有可用的 LXD。</p>}
        <ContainerTable
          containers={containers.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))}
          query=""
          sort={sort}
          onSort={sortHandler}
          onInspect={onInspect}
          emptyText={containers.length === 0 ? '这台没有容器' : `没有匹配 “${query}” 的容器`}
        />

        {orphans.length > 0 && (
          <div className="orphan-box">
            <h4>
              迁移残留数据集 {orphans.length} 个 · 合计 {formatBytes(orphanSum)}
            </h4>
            <p className="note">
              这台上有 <code>{lxd.pool?.name}/containers/&lt;名字&gt;</code> 数据集，但没有任何容器实例落在这台。
              通常是迁移后旧机器上的数据集没删。<strong>它们真实占盘，但不计入上面任何账户</strong>，
              所以池使用率会比容器合计高出一截。
            </p>
            <ul className="kid-list">
              {orphans.map((o) => (
                <li key={o.dataset}>
                  <span className="kid-name" title={o.dataset}>{o.name}</span>
                  <span className="kid-bar">
                    <UsageBar percent={orphanMax ? (o.usedBytes / orphanMax) * 100 : 0} tone="high" />
                  </span>
                  <span className="kid-size">{formatBytes(o.usedBytes)}</span>
                  <span className="kid-share muted">{o.quotaBytes ? `配额 ${formatBytes(o.quotaBytes)}` : '无配额'}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="section">
        <button type="button" className="disclose" onClick={() => setShowHost((v) => !v)}>
          <span className={`twisty ${showHost ? 'open' : ''}`}>▸</span>
          宿主机本身（系统盘 / {server.homeAccounts?.length || 0} 个本机账户 / 网络挂载）
        </button>

        {showHost && (
          <div className="disclose-body">
            <h4>系统盘</h4>
            <table className="table table-compact">
              <thead>
                <tr>
                  <th className="th-left">挂载点</th>
                  <th className="th-left">设备</th>
                  <th className="th-right">容量</th>
                  <th className="th-right">已用</th>
                  <th className="th-right">剩余</th>
                  <th className="th-right">使用率</th>
                </tr>
              </thead>
              <tbody>
                {server.localMounts.map((m) => (
                  <tr key={`${m.source}|${m.mount}`}>
                    <td className="td-path">{m.mount}</td>
                    <td className="td-path muted">{m.source}{m.type ? ` (${m.type})` : ''}</td>
                    <td className="td-num">{formatBytes(m.totalBytes)}</td>
                    <td className="td-num">{formatBytes(m.usedBytes)}</td>
                    <td className="td-num">{formatBytes(m.availBytes)}</td>
                    <td className={`td-num tone-${usageTone(m.usedPercent)}`}>{formatPercent(m.usedPercent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h4>宿主机 /home 账户</h4>
            <AccountTable
              accounts={server.homeAccounts || []}
              query=""
              sort={{ key: 'usedBytes', dir: 'desc' }}
              onSort={() => {}}
              emptyText="没有本机账户目录"
            />

            {server.networkMounts?.length > 0 && (
              <>
                <h4>网络挂载</h4>
                <p className="note">
                  {server.networkMounts.map((m) => `${m.source} → ${m.mount}`).join('；')}
                  。这是 9 台共用的同一份，统计在顶部“共享存储”里，不重复计入本机池容量。
                </p>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
