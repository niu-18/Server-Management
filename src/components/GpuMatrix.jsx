import { Fragment, useState } from 'react'
import { formatBytes, formatPercent, usageTone } from '../lib/format.js'
import UsageBar from './UsageBar.jsx'

export default function GpuMatrix({ servers, drivers }) {
  const [open, setOpen] = useState(null)
  const byId = new Map((servers || []).map((s) => [s.id, s]))
  const rows = (drivers?.rows || []).filter((r) => r.online)

  if (rows.length === 0) return <div className="empty">这台后端还没采到显卡数据（或全部机器离线）</div>

  const totalMem = rows.reduce((a, r) => a + (r.totalMemoryBytes || 0), 0)
  const usedMem = rows.reduce((a, r) => a + (r.usedMemoryBytes || 0), 0)
  const busyHosts = rows.filter((r) => r.busyContainers > 0)

  // profile 问题按标题去重，但要知道是哪几台
  const issues = new Map()
  const missing = []
  for (const s of servers || []) {
    for (const i of s.profileAudit?.issues || []) {
      if (!issues.has(i.title)) issues.set(i.title, { ...i, hosts: [] })
      issues.get(i.title).hosts.push(s.id)
    }
    for (const p of s.profileAudit?.missingSources || []) missing.push({ host: s.id, path: p })
  }

  return (
    <div className="gpu-wrap">
      <div className="gpu-summary">
        <span>全集群显存 <strong>{formatBytes(usedMem, 1)}</strong> / {formatBytes(totalMem, 1)} 在用</span>
        <span className="dot">·</span>
        <span>{busyHosts.length ? `正在被占用：${busyHosts.map((b) => `${b.id}(${b.busyContainers} 个容器)`).join('、')}` : '此刻没有任何容器在用 GPU'}</span>
        <span className="dot">·</span>
        <span className={drivers.consistent ? 'tone-low' : 'tone-high'}>
          宿主驱动 {drivers.versions.length} 套：{drivers.versions.join(' / ')}
        </span>
      </div>

      {!drivers.consistent && (
        <p className="note note-warn">
          同一个 LXD 集群里宿主驱动不一致，意味着<strong>容器迁过去就会坏</strong>（容器里的用户态库必须和宿主内核模块同版本）。
          现在 7 节点集群里 s5 是 550.100、其余 580.142/580.126.09 —— 它上面 3 个账户现在能用，一迁到别的成员立刻坏。
          升驱动要在维护窗口停容器，我没动过。
        </p>
      )}

      <table className="table table-compact">
        <thead>
          <tr>
            <th className="th-left">机器</th>
            <th className="th-left">驱动</th>
            <th className="th-left">卡</th>
            <th className="th-left">显存</th>
            <th className="th-left">利用率</th>
            <th className="th-left">温度</th>
            <th className="th-left">uvm 节点</th>
            <th className="th-left">谁在用</th>
            <th className="th-left">&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const rec = byId.get(r.id)
            const gpu = rec?.gpu
            const util = gpu?.maxUtilPercent ?? null
            const expanded = open === r.id
            return (
              <Fragment key={r.id}>
                <tr className={r.hostBroken ? 'row-hot' : ''}>
                  <td className="td-name"><span className="acct-name">{r.id}</span></td>
                  <td className="td-num">{r.driverVersion || '—'}</td>
                  <td className="td-name">{r.gpuCount} × {r.gpuNames.join('，') || '—'}</td>
                  <td className="td-share">
                    <UsageBar percent={r.totalMemoryBytes ? (r.usedMemoryBytes / r.totalMemoryBytes) * 100 : 0} tone={usageTone(r.totalMemoryBytes ? (r.usedMemoryBytes / r.totalMemoryBytes) * 100 : null)} />
                    <span className="td-share-num">{formatBytes(r.usedMemoryBytes, 0)}</span>
                  </td>
                  <td className={`td-num tone-${usageTone(util)}`}>{util == null ? '—' : `${util}%`}</td>
                  <td className="td-num">{gpu?.maxTempC != null ? `${gpu.maxTempC}℃` : '—'}</td>
                  <td>
                    {r.hostBroken ? <span className="tone-critical">宿主 nvidia-smi 坏了</span>
                      : r.uvmConsistent === false ? <span className="tone-high">主编号对不上</span>
                        : r.uvmConsistent == null ? <span className="tone-none">未比对</span>
                          : <span className="muted">{r.uvmProcMajor} 一致</span>}
                  </td>
                  <td className="td-name">
                    {gpu?.users?.length
                      ? gpu.users.map((u) => u.container || '宿主机进程').join('、')
                      : <span className="muted">空闲</span>}
                  </td>
                  <td className="th-right">
                    <button type="button" className={`twisty ${expanded ? 'open' : ''}`} onClick={() => setOpen(expanded ? null : r.id)} aria-expanded={expanded}>▸</button>
                  </td>
                </tr>
                {expanded && (
                  <tr className="row-kids" key={`${r.id}-kids`}>
                    <td colSpan={9}>
                      {r.hostBroken && <div className="banner banner-error">{gpu?.hostError} —— 这台上所有容器的 GPU 都不可用，先修宿主机（手册 2025.9.19：reboot，不行就断电强关）</div>}
                      <table className="table table-compact inner-table">
                        <thead>
                          <tr>
                            <th className="th-left">卡</th>
                            <th className="th-left">型号</th>
                            <th className="th-left">显存</th>
                            <th className="th-left">利用率</th>
                            <th className="th-left">温度</th>
                            <th className="th-left">功耗</th>
                            <th className="th-left">进程</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(gpu?.gpus || []).map((g) => {
                            const pct = g.memoryTotalBytes ? (g.memoryUsedBytes / g.memoryTotalBytes) * 100 : 0
                            const procs = (gpu?.compute || []).filter((c) => c.gpuIndex === g.index)
                            return (
                              <tr key={g.index}>
                                <td className="td-num">#{g.index}</td>
                                <td className="td-name">{g.name}</td>
                                <td className="td-share">
                                  <UsageBar percent={pct} tone={usageTone(pct)} />
                                  <span className="td-share-num">{formatBytes(g.memoryUsedBytes, 0)} / {formatBytes(g.memoryTotalBytes, 0)}</span>
                                </td>
                                <td className={`td-num tone-${usageTone(g.utilPercent)}`}>{g.utilPercent == null ? '—' : `${g.utilPercent}%`}</td>
                                <td className={`td-num ${g.temperatureC >= 75 ? 'tone-high' : 'muted'}`}>{g.temperatureC == null ? '—' : `${g.temperatureC}℃`}</td>
                                <td className="td-num muted">{g.powerWatts == null ? '—' : `${g.powerWatts} W`}</td>
                                <td className="td-name">
                                  {procs.length === 0 ? <span className="muted">无</span>
                                    : procs.map((p) => (
                                      <span className="ctn" key={p.pid}>{p.container || '宿主'}<em>{formatBytes(p.usedBytes, 0)}</em></span>
                                    ))}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                      {gpu && gpu.gpus.length === 0 && <p className="muted">这台读不到任何卡（没有 nvidia-smi，或者没插卡）。</p>}
                      <p className="note">
                        归属方法：宿主 <code>nvidia-smi --query-compute-apps</code> 拿到 PID，再读 <code>/proc/&lt;PID&gt;/cgroup</code> 里的
                        <code>lxc.payload.&lt;容器名&gt;</code>。因为 default profile 是把全部卡透传给每个容器的，
                        所以"LXD 配置"里看不出谁用哪张卡，只能这样反查。
                      </p>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>

      <section className="section">
        <h3>profile 体检</h3>
        {[...issues.values()].length === 0 && missing.length === 0 && (
          <p className="note">profile 里没检出问题：gpu 设备写法正确，所有挂载源都在这台上存在。</p>
        )}
        {[...issues.values()].map((i) => (
          <div className={`issue issue-${i.level}`} key={i.title}>
            <div className="issue-title">{i.title}<span className="issue-hosts">{i.hosts.join(' ')}</span></div>
            <p className="note">{i.detail}</p>
            {i.commands?.length > 0 && (
              <pre className="issue-cmd">{i.commands.join('\n')}</pre>
            )}
          </div>
        ))}
        {missing.length > 0 && (
          <div className="issue issue-critical">
            <div className="issue-title">profile 的挂载源在部分机器上不存在<span className="issue-hosts">{[...new Set(missing.map((m) => m.host))].join(' ')}</span></div>
            <p className="note">{missing.map((m) => `${m.host}: ${m.path}`).join('；')}</p>
          </div>
        )}
      </section>
    </div>
  )
}
