import { useMemo, useState } from 'react'
import { formatBytes, formatPercent, formatAgo, usageTone } from '../lib/format.js'
import { Stat, SectionHeader, CopyBtn } from './ui.jsx'
import UsageBar from './UsageBar.jsx'

const SEV_ORDER = { critical: 0, warn: 1, info: 2 }
const SEV_TEXT = { critical: '严重', warn: '注意', info: '提示' }

export default function OverviewSection({ snapshot, servers, summaryData, onNavigate, onOpenContainer, onRefresh, onReload, busy }) {
  const [showAll, setShowAll] = useState(false)
  const quota = summaryData?.quota || null
  const checks = summaryData?.checks || { containers: [] }
  const ports = summaryData?.ports || { rows: [] }

  const online = servers.filter((s) => s.status === 'ok')
  const capacity = online.reduce((a, s) => a + (s.capacity?.totalBytes || 0), 0)
  const used = online.reduce((a, s) => a + (s.capacity?.usedBytes || 0), 0)
  const containers = online.reduce((a, s) => a + (s.lxd?.containers?.length || 0), 0)
  // lxd 可能为 null（旧缓存/采集被截断），这里必须防御，否则整个总览白屏
  const running = online.reduce((a, s) => a + (s.lxd?.containers || []).filter((c) => c.status === 'Running').length, 0)
  const worst = online.map((s) => ({ id: s.id, pct: s.capacity?.usedPercent ?? 0 })).sort((a, b) => b.pct - a.pct)[0]
  const share = (snapshot?.shared || [])[0] || null
  const clusterAlerts = (snapshot?.cluster || []).flatMap((c) => (c.alerts || []).map((a) => ({ ...a, cluster: c.key })))

  const actions = useMemo(() => {
    const items = []

    for (const c of checks?.containers || []) {
      if (c.verdict !== 'fail' && c.verdict !== 'error') continue
      const first = c.fails?.[0]
      items.push({
        id: `chk-${c.container}`,
        sev: 'critical',
        title: `${c.container} 体检不通过`,
        detail: first ? first.detail : (c.error || '采集失败'),
        chips: [`${c.member || c.server}`, `通过 ${c.passed}/${c.total}`, `体检于 ${formatAgo(c.ranAt)}`],
        commands: first?.commands || [],
        action: { label: '打开', onClick: () => onOpenContainer(c.container, c.server, 'check') },
      })
    }

    for (const r of quota?.hot || []) {
      items.push({
        id: `q-${r.container}`,
        sev: r.level === 'critical' ? 'critical' : 'warn',
        title: `${r.container} 配额 ${formatPercent(r.usedPercent)}`,
        detail: `已用 ${formatBytes(r.usedBytes)} / ${formatBytes(r.quotaBytes)}${r.suggestedGiB ? `，建议扩到 ${r.suggestedGiB}GiB` : ''}${r.fitsInPool === false ? '（该成员池已装不下）' : ''}`,
        chips: [r.host],
        commands: r.commands || [],
        action: { label: '打开', onClick: () => onOpenContainer(r.container, r.host, 'check') },
      })
    }

    for (const a of clusterAlerts) {
      items.push({
        id: `cl-${a.cluster}-${a.text.slice(0, 20)}`,
        sev: a.level === 'critical' ? 'critical' : 'warn',
        title: a.level === 'critical' ? '集群状态异常' : '集群配置有隐患',
        detail: a.text,
        chips: [a.cluster.split(',').length > 3 ? `${a.cluster.split(',').length} 节点集群` : a.cluster],
        action: { label: '查看', onClick: () => onNavigate('infra') },
      })
    }

    for (const r of ports?.rows || []) {
      if (r.verdict !== 'no_forward' && r.verdict !== 'no_listener') continue
      items.push({
        id: `pt-${r.container}-${r.listenPort}`,
        sev: r.verdict === 'no_forward' ? 'warn' : 'critical',
        title: `${r.container} 的 ${r.listenPort} 外部不通`,
        detail: r.advice,
        chips: [r.host, r.verdict === 'no_forward' ? '缺路由器转发' : 'proxy 没生效'],
        action: { label: '查看', onClick: () => onNavigate('ports') },
      })
    }

    // 转发目标 IP 与容器实际 IP 不一致（迁移/重启后 fan 网络把地址换给别人的典型后果）。
    // 同一容器多条端口只报一条，免得 516/3390 这种重复占两行。
    const ipSeen = new Set()
    for (const r of ports.ipCheck?.mismatches || []) {
      if (ipSeen.has(r.container)) continue
      ipSeen.add(r.container)
      const label = { mismatch: '不一致', swap: '两个账户互换', other: '指向别的容器', segment: '网段不对', no_ip: '容器没 IP' }[r.ipVerdict] || r.ipVerdict
      items.push({
        id: `ip-${r.container}-${r.listenPort}`,
        sev: r.ipVerdict === 'no_ip' ? 'warn' : 'critical',
        title: `${r.container} 的 ${r.listenPort} 登录会落到错的容器`,
        detail: r.ipDetail,
        chips: [r.host, `转发 ${r.connectHost}`, `实际 ${(r.actualIps || []).join(' / ') || '空'}`, label],
        commands: (r.ipFix || []).filter((c) => !c.startsWith('#')).slice(0, 1),
        action: { label: '去修', onClick: () => onNavigate('ports') },
      })
    }

    for (const s of servers) {
      const orphans = s.lxd?.orphanDatasets || []
      if (orphans.length) {
        items.push({
          id: `or-${s.id}`,
          sev: 'warn',
          title: `${s.id} 有 ${orphans.length} 个迁移残留数据集`,
          detail: `合计 ${formatBytes(s.lxd.totals?.orphanSumBytes)}，真实占盘但不在任何账户账上`,
          chips: [s.id, '可清理'],
          action: { label: '查看', onClick: () => onNavigate('space', { server: s.id }) },
        })
      }
      if (s.profileAudit?.missingSources?.length) {
        items.push({
          id: `pr-${s.id}`,
          sev: 'critical',
          title: `${s.id} 的 profile 挂载源缺失`,
          detail: s.profileAudit.missingSources.join('、'),
          chips: [s.id],
          action: { label: '查看', onClick: () => onNavigate('infra') },
        })
      }
    }

    const seen = new Set()
    return items
      .filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)))
      .sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || a.title.localeCompare(b.title))
  }, [checks, quota, ports, clusterAlerts, servers, onOpenContainer, onNavigate])

  const critical = actions.filter((a) => a.sev === 'critical').length
  const shown = showAll ? actions : actions.slice(0, 6)
  const checked = checks?.containers?.length || 0

  return (
    <div className="overview">
      <div className="stat-grid">
        <Stat label="存储池合计" value={formatBytes(capacity, 1)} hint={`已用 ${formatBytes(used, 1)} · ${formatPercent(capacity ? (used / capacity) * 100 : null)}`} tone={usageTone(capacity ? (used / capacity) * 100 : null)} />
        <Stat label="容器" value={`${containers}`} hint={`运行 ${running} · ${online.length}/${servers.length} 台在线`} onClick={() => onNavigate('space')} />
        <Stat label="最紧张" value={worst ? `${worst.id} ${formatPercent(worst.pct)}` : '—'} hint="存储池使用率" tone={usageTone(worst?.pct)} onClick={() => worst && onNavigate('space', { server: worst.id })} />
        <Stat label="共享 NAS" value={share ? formatPercent(share.usedPercent) : '—'} hint={share ? `${formatBytes(share.usedBytes)} / ${formatBytes(share.totalBytes)}` : '未采集'} tone={usageTone(share?.usedPercent)} onClick={() => onNavigate('space')} />
        <Stat label="待处理" value={`${actions.length}`} hint={critical ? `其中 ${critical} 项严重` : '暂无严重问题'} tone={critical ? 'critical' : actions.length ? 'high' : 'low'} />
        <Stat label="体检覆盖" value={`${checked}/${containers}`} hint={checks?.updatedAt ? `最近 ${formatAgo(checks.updatedAt)}` : '还没跑过'} onClick={() => onNavigate('health')} />
      </div>

      <section className="panel overview-actions">
        <SectionHeader
          title="需要你处理"
          sub="把体检、配额、集群、端口、残留数据集的结论合成一张清单；每条都写明证据，点开就是对应的容器或版块"
        >
          <button type="button" className="btn btn-small" onClick={onReload}>重新汇总</button>
          <button type="button" className="btn btn-small btn-primary" onClick={onRefresh} disabled={busy}>{busy ? '采集中…' : '刷新全部'}</button>
        </SectionHeader>

        {actions.length === 0 && (
          <div className="empty-state">
            <span className="empty-mark">✓</span>
            <p>没有待处理项（按目前的数据）：体检、配额、集群、端口都没报问题。</p>
            <p className="muted">建议在「账户体检」里跑一次全集群体检，把 65 个容器都过一遍，结果会落在这里。</p>
          </div>
        )}

        <ul className="action-list">
          {shown.map((a) => (
            <li key={a.id} className={`action action-${a.sev}`}>
              <span className={`action-dot action-dot-${a.sev}`} aria-hidden="true" />
              <div className="action-main">
                <div className="action-title">
                  {a.title}
                  <span className="action-sev">{SEV_TEXT[a.sev]}</span>
                </div>
                <div className="action-detail">{a.detail}</div>
                <div className="action-chips">
                  {(a.chips || []).map((c) => <span className="chip" key={c}>{c}</span>)}
                </div>
                {(a.commands || []).length > 0 && (
                  <div className="action-cmd">
                    <code>{a.commands[0]}</code>
                    <CopyBtn text={a.commands[0]} />
                  </div>
                )}
              </div>
              {a.action && (
                <button type="button" className="btn btn-small action-btn" onClick={a.action.onClick}>{a.action.label}</button>
              )}
            </li>
          ))}
        </ul>
        {actions.length > 6 && (
          <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)}>
            {showAll ? '收起' : `展开全部 ${actions.length} 项`}
          </button>
        )}
      </section>

      <section className="panel">
        <SectionHeader title="机器一览" sub="点一行跳到那台的明细；使用率、驱动、显卡占用一眼看完">
          <button type="button" className="btn btn-small" onClick={() => onNavigate('space')}>进入单机明细</button>
        </SectionHeader>
        <table className="table table-compact host-table">
          <thead>
            <tr>
              <th className="th-left">机器</th>
              <th className="th-left">存储池</th>
              <th className="th-right">容器</th>
              <th className="th-left">宿主驱动</th>
              <th className="th-left">显卡</th>
              <th className="th-left">备注</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => {
              const pct = s.capacity?.usedPercent ?? null
              const gpu = s.gpu
              const issues = []
              if (s.lxd?.orphanDatasets?.length) issues.push(`${s.lxd.orphanDatasets.length} 个残留`)
              if (s.profileAudit?.missingSources?.length) issues.push('挂载源缺失')
              if (gpu?.hostBroken) issues.push('GPU 宿主异常')
              else if (gpu?.uvmConsistent === false) issues.push('uvm 主编号不符')
              if (s.status !== 'ok') issues.push('离线')
              return (
                <tr key={s.id} className="host-row" onClick={() => onNavigate('space', { server: s.id })}>
                  <td className="td-name">
                    <span className={`st ${s.status === 'ok' ? 'st-pass' : 'st-fail'}`}>{s.status === 'ok' ? '✓' : '✗'}</span>
                    <span className="acct-name">{s.id}</span>
                  </td>
                  <td className="td-share">
                    <UsageBar percent={pct} tone={usageTone(pct)} showTicks />
                    <span className={`td-share-num tone-${usageTone(pct)}`}>{formatPercent(pct)}</span>
                  </td>
                  <td className="td-num">{s.lxd?.containers?.length ?? 0}<span className="muted"> / {s.lxd?.totals?.runningCount ?? 0} 跑</span></td>
                  <td className="td-num">{gpu?.driverVersion || '—'}</td>
                  <td className="td-name">{gpu?.gpus?.length ? `${gpu.gpus.length} × ${gpu.gpus[0].name.replace('NVIDIA GeForce ', '')}` : '—'}</td>
                  <td className="td-name">{issues.length ? <span className="tone-high">{issues.join(' · ')}</span> : <span className="muted">—</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>
    </div>
  )
}
