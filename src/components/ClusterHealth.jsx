import { formatUptime } from '../lib/format.js'

const ROLE_CN = { 'database-leader': 'leader', database: '投票', 'database-standby': '备份', '': '—' }

function roleLabel(m) {
  if (m.roles.length === 0) return '不带角色'
  return m.roles.map((r) => ROLE_CN[r] || r).join('+')
}

export default function ClusterHealth({ clusters }) {
  if (!clusters || clusters.length === 0) {
    return <div className="empty">还没有集群数据，先点「刷新全部」</div>
  }

  return (
    <div className="cluster-wrap">
      {clusters.map((c) => {
        const critical = c.alerts.filter((a) => a.level === 'critical')
        const warns = c.alerts.filter((a) => a.level === 'warn')
        return (
          <section className="cluster-block" key={c.key}>
            <div className="section-head">
              <h3>
                {c.members.map((m) => m.name).join(' · ')}
                <span className="cluster-sub">
                  {c.memberCount} 个成员 · leader <strong>{c.leader || '读不到'}</strong> · 投票者 {c.voters.length} 个（在线 {c.aliveVoters}）
                  · LXD {c.versions.join('/') || '—'} · 宿主驱动 {c.drivers.length} 套
                </span>
              </h3>
            </div>

            {(critical.length > 0 || warns.length > 0) && (
              <ul className="alert-list">
                {[...critical, ...warns].map((a, i) => (
                  <li key={i} className={`alert alert-${a.level}`}>{a.text}</li>
                ))}
              </ul>
            )}
            {c.alerts.length === 0 && <p className="note">这个集群没检出问题：leader 在、成员全 ONLINE、版本一致、时钟同步、snap 都 held。</p>}

            <table className="table table-compact">
              <thead>
                <tr>
                  <th className="th-left">成员</th>
                  <th className="th-left">状态</th>
                  <th className="th-left">角色</th>
                  <th className="th-left">内部地址</th>
                  <th className="th-left">LXD</th>
                  <th className="th-left">snap</th>
                  <th className="th-left">宿主驱动</th>
                  <th className="th-right">卡</th>
                  <th className="th-right">时钟偏差</th>
                  <th className="th-right">开机</th>
                </tr>
              </thead>
              <tbody>
                {c.members.map((m) => (
                  <tr key={m.name} className={m.status !== 'Online' ? 'row-hot' : ''}>
                    <td className="td-name"><span className="acct-name">{m.name}</span></td>
                    <td>
                      <span className={`state ${m.status === 'Online' ? 'state-running' : 'state-stopped'}`}>{m.status || '未知'}</span>
                      {m.message && !/fully operational/i.test(m.message) && <span className="muted"> {m.message}</span>}
                    </td>
                    <td>
                      <span className={`chip ${m.leader ? 'chip-quota' : ''}`}>{roleLabel(m)}</span>
                      {!m.collected && <span className="muted">（不在这次的 9 台里）</span>}
                    </td>
                    <td className="td-path muted">{m.url.replace(/:8443$/, '')}</td>
                    <td className="td-num">{m.lxdVersion || '—'}</td>
                    <td>
                      {m.snapHeld == null ? <span className="muted">—</span>
                        : <span className={m.snapHeld ? 'tone-low' : 'tone-critical'}>{m.snapVersion}{m.snapHeld ? ' held' : ' 未held'}</span>}
                    </td>
                    <td className="td-num">{m.driverVersion || '—'}</td>
                    <td className="td-num">{m.gpuCount ?? '—'}</td>
                    <td className={`td-num ${Math.abs(m.clockSkew ?? 0) > 2 ? 'tone-high' : 'muted'}`}>
                      {m.clockSkew == null ? '—' : `${m.clockSkew > 0 ? '+' : ''}${m.clockSkew}s`}
                    </td>
                    <td className="td-num muted">{formatUptime(m.uptimeSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )
      })}
    </div>
  )
}
