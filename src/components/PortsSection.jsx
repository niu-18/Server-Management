import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { jsonFetch, postJson, copyText } from '../lib/api.js'
import { formatBytes, formatPercent, usageTone } from '../lib/format.js'
import { SectionHeader } from './ui.jsx'
import UsageBar from './UsageBar.jsx'

const VERDICT_ICON = { ok: '✓', no_forward: '✗', no_listener: '✗', unknown: '?', unprobed: '·' }
const VERDICT_TEXT = {
  ok: '通',
  no_forward: '缺路由器转发',
  no_listener: 'LXD 没在听',
  unknown: '待定',
  unprobed: '未探测',
}
const IP_TEXT = { match: '一致', mismatch: '不一致', swap: '两个账户互换', other: '指向别的容器', segment: '网段不对', no_ip: '容器没 IP', stale: '配置已变', unknown: '读不到' }
const LEVEL_TEXT = { ok: '正常', warn: '注意', critical: '快满', unknown: '读不到' }

export default function PortsSection({ onOpenContainer, onChecked }) {
  const [ledger, setLedger] = useState(null)
  const [quota, setQuota] = useState(null)
  const [ipCheck, setIpCheck] = useState(null)
  const [query, setQuery] = useState('')
  const [onlyProblem, setOnlyProblem] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ipBusy, setIpBusy] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState('')
  const autoRan = useRef(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [p, q, last] = await Promise.all([
        jsonFetch('/api/ports'),
        jsonFetch('/api/quota'),
        jsonFetch('/api/ports/last'),
      ])
      if (p.body.pending) setError('还没有快照，先回「空间占用」点刷新全部')
      else setLedger(p.body)
      if (q.body && !q.body.pending) setQuota(q.body)
      // /api/ports 里已经带上了"按当前台账校正过"的 ipCheck，优先用它（两者一致，少一次判断）
      if (p.body.ipCheck) setIpCheck(p.body.ipCheck)
      else if (last.body?.ipCheck) setIpCheck(last.body.ipCheck)
    } catch (e) {
      setError(`读取失败：${e.message}`)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const runCheck = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const { body } = await postJson('/api/ports/check', {})
      setLedger((prev) => ({ ...prev, ...body }))
      onChecked?.()
    } catch (e) {
      setError(`端口检查失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }, [onChecked])

  const runIpCheck = useCallback(async () => {
    setIpBusy(true)
    setError(null)
    try {
      const { body } = await postJson('/api/ports/ipcheck', {})
      setIpCheck({ ranAt: body.ranAt, counts: body.counts, rows: body.rows, mismatches: body.mismatches })
      onChecked?.()
    } catch (e) {
      setError(`IP 核对失败：${e.message}`)
    } finally {
      setIpBusy(false)
    }
  }, [onChecked])

  const doCopy = async (text, key) => {
    const ok = await copyText(text)
    setCopied(ok ? key : '')
    setTimeout(() => setCopied(''), 1500)
  }

  // 打开这个版块就自动跑一次定责（实测 66 个端口 + 成员确认约 3.5 秒）。
  // 一次页面生命期只自动跑一次，来回切页签不会反复探测路由器。
  useEffect(() => {
    if (autoRan.current || !ledger?.rows?.length || ledger.verdicts) return
    autoRan.current = true
    runCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledger])

  const ipByPort = useMemo(() => {
    const map = new Map()
    for (const r of ipCheck?.rows || []) map.set(`${r.container}|${r.listenPort}`, r)
    return map
  }, [ipCheck])

  const rows = (ledger?.rows || []).map((r) => {
    const ip = ipByPort.get(`${r.container}|${r.listenPort}`) || null
    return { ...r, ip }
  })

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      const ipBad = r.ip && r.ip.ipVerdict !== 'match' && r.ip.ipVerdict !== 'unknown'
      if (onlyProblem && r.verdict === 'ok' && !ipBad) return false
      if (!q) return true
      return `${r.container} ${r.host} ${r.listenPort} ${r.listenHost} ${r.connectHost} ${(r.ip?.actualIps || []).join(' ')}`.toLowerCase().includes(q)
    })
  }, [rows, query, onlyProblem])

  const verdicts = ledger?.verdicts || {}
  const badCount = (verdicts.no_forward || 0) + (verdicts.no_listener || 0)
  const hot = quota?.hot || []
  // stale（核对后配置又改了）不算错，只提示重新核对
  const ipBad = (ipCheck?.rows || []).filter((r) => ['mismatch', 'swap', 'other', 'segment', 'no_ip'].includes(r.ipVerdict))
  const ipStale = (ipCheck?.rows || []).filter((r) => r.ipVerdict === 'stale')
  // 同一个容器可能有多条 proxy，顶部提示按容器去重，表格里仍逐条列
  const ipBadByContainer = [...new Map(ipBad.map((r) => [r.container, r])).values()]

  return (
    <section className="panel ports-panel">
      <div className="section-head">
        <h2>端口与配额</h2>
        <div className="health-tools">
          <button type="button" className="btn btn-small" onClick={runCheck} disabled={busy || rows.length === 0}>
            {busy ? '探测中…' : '探测端口并定责'}
          </button>
          <button type="button" className="btn btn-small" onClick={runIpCheck} disabled={ipBusy || rows.length === 0}>
            {ipBusy ? '核对中…' : '核对转发 IP'}
          </button>
          <button type="button" className="btn btn-small" onClick={load}>重新读取</button>
        </div>
      </div>

      <p className="note">
        台账来自 LXD 的 proxy 设备（权威、非 root 可读），<strong>66 条</strong>；外部 TCP 探测只证明"从外面进得去"，
        不通时后端会再登到该成员确认 LXD 有没有在听端口 —— 分清是<strong>路由器缺转发</strong>还是<strong>proxy 没生效</strong>。
        「核对转发 IP」是另一件事：进容器跑 <code>hostname -I</code> 拿实际地址，和 proxy 的 <code>connect</code> 比，
        迁移或重启后 fan 网络可能把 IP 换给别人，这时外部 SSH 会落到错的容器里。
      </p>

      {error && <div className="banner banner-error">{error}<button type="button" className="banner-x" onClick={() => setError(null)}>×</button></div>}

      {ipCheck && ipBad.length > 0 && (
        <div className="alert-list">
          {ipBadByContainer.map((r) => (
            <div className={`alert ${r.ipVerdict === 'no_ip' ? 'alert-warn' : 'alert-critical'}`} key={`${r.container}-${r.listenPort}`}>
              <strong>{r.container}@{r.host}</strong> · {IP_TEXT[r.ipVerdict]}：{r.ipDetail}
            </div>
          ))}
        </div>
      )}
      {ipCheck && ipBad.length === 0 && (
        <p className="note tone-low">
          按 {ipCheck.ranAt?.slice(11, 19)} 那次核对：{ipCheck.counts?.match || 0} 条转发目标与容器实际 IP 一致，没有发现不一致。
          {ipCheck.fixed > 0 && `其中 ${ipCheck.fixed} 条是核对之后改好的（配置已按提示修正）。`}
        </p>
      )}
      {ipStale.length > 0 && (
        <p className="note">
          有 {ipStale.length} 条配置在这次核对之后又改过（{ipStale.map((r) => r.container).join('、')}），结论已过期 —— 点「核对转发 IP」重跑一次。
        </p>
      )}

      {ledger && (
        <div className="quota-grid">
          <div className="kv-grid">
            <div className="kv"><span className="kv-k">端口条目</span><span className="kv-v">{ledger.summary?.total ?? 0}<span className="s-u"> 涉及 {ledger.summary?.containers ?? 0} 个容器</span></span></div>
            <div className="kv"><span className="kv-k">SSH 端口</span><span className="kv-v">{ledger.summary?.ssh ?? 0}</span></div>
            <div className="kv"><span className="kv-k">其他服务</span><span className="kv-v">{ledger.summary?.service ?? 0}</span></div>
            <div className="kv"><span className="kv-k">没有对外端口的容器</span><span className={`kv-v ${ledger.summary?.withoutPort ? 'tone-high' : 'tone-low'}`}>{ledger.summary?.withoutPort ?? 0}</span></div>
            <div className="kv"><span className="kv-k">外部端口冲突</span><span className={`kv-v ${ledger.conflicts?.length ? 'tone-critical' : 'tone-low'}`}>{ledger.conflicts?.length ?? 0}</span></div>
            <div className="kv"><span className="kv-k">不通并已定责</span><span className={`kv-v ${badCount ? 'tone-critical' : (verdicts.ok ? 'tone-low' : 'tone-none')}`}>{busy ? '…' : badCount || (verdicts.ok ? 0 : '—')}</span></div>
            <div className="kv">
              <span className="kv-k">转发目标 IP 不一致</span>
              <span className={`kv-v ${ipBad.length ? 'tone-critical' : ipCheck ? 'tone-low' : 'tone-none'}`}>
                {ipBusy ? '…' : ipCheck ? ipBad.length : '—'}
                {ipCheck && ipBad.length > 0 && <span className="s-u"> 条 · {ipBadByContainer.length} 个容器</span>}
              </span>
            </div>
          </div>
        </div>
      )}

      {ledger?.listenMismatches?.length > 0 && (
        <div className="banner banner-warn">
          listen 地址与所在成员内部地址不一致（迁移后没改）：{ledger.listenMismatches.join('；')}
        </div>
      )}
      {ledger?.conflicts?.length > 0 && (
        <div className="banner banner-error">
          外部端口撞车：{ledger.conflicts.map((c) => `${c.port} → ${c.containers.join('、')}`).join('；')}
        </div>
      )}
      {ledger?.containersWithoutPort?.length > 0 && (
        <p className="note">
          这些容器没有任何对外端口，只能从成员上用 <code>lxc exec</code> 进（本 UI 的容器终端就是走这条路）：
          {ledger.containersWithoutPort.map((c) => `${c.container}@${c.host}`).join('、')}
        </p>
      )}
      {ledger && !ledger.expectedLoaded && (
        <p className="note">
          没有 <code>expected-ports.json</code>（手册里那张分配表）。现在只做"LXD ↔ 外部可达"两方对账；
          想三方对账（应该有哪些端口）把那份表放成{' '}
          <code>{'[{"port":24417,"container":"demo-24417","note":"…"}]'}</code> 即可。
        </p>
      )}

      <div className="section-head">
        <h3>端口台账</h3>
        <div className="health-tools">
          <label className="toggle"><input type="checkbox" checked={onlyProblem} onChange={(e) => setOnlyProblem(e.target.checked)} /><span>只看有问题</span></label>
          <input className="search" type="search" placeholder="搜容器 / 端口 / 地址…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      <table className="table table-compact">
        <thead>
          <tr>
            <th className="th-left">容器</th>
            <th className="th-left">成员</th>
            <th className="th-left">外部端口</th>
            <th className="th-left">用途</th>
            <th className="th-left">转发到</th>
            <th className="th-left">实际 IP</th>
            <th className="th-left">结论</th>
            <th className="th-left">登录命令</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const ipBadRow = r.ip && !['match', 'unknown'].includes(r.ip.ipVerdict)
            return (
              <tr key={`${r.container}/${r.device}`} className={(r.verdict && r.verdict !== 'ok' && r.verdict !== 'unprobed') || ipBadRow ? 'row-hot' : ''}>
                <td className="td-name">
                  <button type="button" className="acct-name clickable" onClick={() => onOpenContainer?.(r.container, r.host, 'check')}>{r.container}</button>
                  {r.status !== 'Running' && <span className="acct-uid">{r.status}</span>}
                </td>
                <td className="td-num muted">{r.host}</td>
                <td className="td-num"><code>{r.listenHost}:{r.listenPort}</code></td>
                <td><span className={`chip ${r.kind === 'ssh' ? 'chip-quota' : ''}`}>{r.kind === 'ssh' ? 'SSH' : `服务 :${r.connectPort}`}</span></td>
                <td className="td-path muted">{r.connectHost}:{r.connectPort}</td>
                <td className="td-path">
                  {r.ip ? (
                    <span className={ipBadRow ? 'tone-critical' : 'muted'}>
                      {r.ip.actualIps?.join(' / ') || '（空）'}
                      <span className="ip-tag">{IP_TEXT[r.ip.ipVerdict]}</span>
                    </span>
                  ) : <span className="muted">未核对</span>}
                </td>
                <td className="td-detail">
                  <span className={`st st-${r.verdict === 'ok' ? 'pass' : r.verdict === 'unprobed' ? 'none' : 'fail'}`}>{VERDICT_ICON[r.verdict] || '?'}</span>{' '}
                  <span className={r.verdict === 'ok' ? 'muted' : 'tone-critical'}>{VERDICT_TEXT[r.verdict] || r.verdict}</span>
                  {ipBadRow && <span className="tone-critical"> · 但转发目标有误</span>}
                  {r.advice && r.verdict !== 'ok' && <div className="advice">{r.advice}</div>}
                  {ipBadRow && (
                    <div className="advice tone-critical">
                      <strong>{IP_TEXT[r.ip.ipVerdict]}：</strong>{r.ip.ipDetail}
                      {r.ip.ipSwapWith && <div>互换对象：{r.ip.ipSwapWith}</div>}
                    </div>
                  )}
                  {(r.commands || []).length > 0 && (
                    <div className="fix-box">
                      {r.commands.map((c, i) => (
                        <div className="fix-line" key={i}>
                          <code>{c}</code>
                          {!c.startsWith('#') && <button type="button" className="btn btn-tiny" onClick={() => doCopy(c, `p${r.listenPort}${i}`)}>复制</button>}
                        </div>
                      ))}
                    </div>
                  )}
                  {ipBadRow && (r.ip.ipFix || []).length > 0 && (
                    <div className="fix-box">
                      <div className="detail-k">修复转发目标（只生成命令，不代执行）</div>
                      {r.ip.ipFix.map((c, i) => (
                        <div className="fix-line" key={`ip${i}`}>
                          <code>{c}</code>
                          {!c.startsWith('#') && <button type="button" className="btn btn-tiny" onClick={() => doCopy(c, `ip${r.listenPort}${i}`)}>复制</button>}
                        </div>
                      ))}
                    </div>
                  )}
                  {copied === `p${r.listenPort}0` && <span className="muted">已复制</span>}
                </td>
                <td className="td-path">
                  {r.sshCmd && (
                    <span className="cmd-line">
                      <code>{r.sshCmd}</code>
                      <button type="button" className="btn btn-tiny" onClick={() => doCopy(r.sshCmd, `ssh${r.listenPort}`)}>复制</button>
                      {copied === `ssh${r.listenPort}` && <span className="muted">✓</span>}
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
          {shown.length === 0 && <tr><td colSpan={8} className="empty">{rows.length ? '没有匹配的行' : '还没有台账数据'}</td></tr>}
        </tbody>
      </table>

      <SectionHeader
        level={3}
        title="配额预警"
        sub={quota ? `阈值 ${quota.thresholds.warn}% / ${quota.thresholds.high}%；扩容命令只在到线时才给` : '加载中…'}
      />

      {quota && (
        <>
          {hot.length === 0 ? (
            <p className="note">没有容器到达 {quota.thresholds.warn}% —— 暂时不用管配额。</p>
          ) : (
            <table className="table table-compact">
              <thead>
                <tr>
                  <th className="th-left">容器</th>
                  <th className="th-left">成员</th>
                  <th className="th-left">已用 / 配额</th>
                  <th className="th-left">使用率</th>
                  <th className="th-left">建议</th>
                  <th className="th-left">命令（只生成，不代执行）</th>
                </tr>
              </thead>
              <tbody>
                {hot.map((r) => (
                  <tr key={`${r.host}/${r.container}`} className={r.level === 'critical' ? 'row-hot' : ''}>
                    <td className="td-name">
                      <button type="button" className="acct-name clickable" onClick={() => onOpenContainer?.(r.container, r.host, 'check')}>{r.container}</button>
                    </td>
                    <td className="td-num muted">{r.host}</td>
                    <td className="td-num">{formatBytes(r.usedBytes)} / {formatBytes(r.quotaBytes)}</td>
                    <td className="td-share">
                      <UsageBar percent={r.usedPercent} tone={usageTone(r.usedPercent)} showTicks />
                      <span className={`td-share-num tone-${usageTone(r.usedPercent)}`}>{formatPercent(r.usedPercent)} {LEVEL_TEXT[r.level]}</span>
                    </td>
                    <td className="td-num">
                      {r.suggestedGiB ? `${r.suggestedGiB} GiB（+${Math.round(r.growBytes / 1024 ** 3)}）` : '—'}
                      {r.fitsInPool === false && <div className="advice tone-critical">该成员池里只剩 {formatBytes(r.poolAvailBytes)}，扩不动</div>}
                    </td>
                    <td>
                      <div className="fix-box">
                        {r.commands.map((c, i) => (
                          <div className="fix-line" key={i}>
                            <code>{c}</code>
                            {!c.startsWith('#') && <button type="button" className="btn btn-tiny" onClick={() => doCopy(c, `q${r.container}${i}`)}>复制</button>}
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4 className="sub-h4">各成员存储池压力</h4>
          <table className="table table-compact">
            <thead>
              <tr>
                <th className="th-left">成员</th>
                <th className="th-left">池</th>
                <th className="th-left">已用 / 容量</th>
                <th className="th-left">使用率</th>
                <th className="th-right">容器</th>
                <th className="th-right">迁移残留</th>
              </tr>
            </thead>
            <tbody>
              {quota.pools.map((p) => (
                <tr key={p.host} className={p.level === 'critical' ? 'row-hot' : ''}>
                  <td className="td-name">{p.host}</td>
                  <td className="td-path muted">{p.pool}</td>
                  <td className="td-num">{formatBytes(p.usedBytes, 1)} / {formatBytes(p.totalBytes, 1)}<span className="muted"> 剩 {formatBytes(p.availBytes, 1)}</span></td>
                  <td className="td-share">
                    <UsageBar percent={p.usedPercent} tone={usageTone(p.usedPercent)} showTicks />
                    <span className={`td-share-num tone-${usageTone(p.usedPercent)}`}>{formatPercent(p.usedPercent)}</span>
                  </td>
                  <td className="td-num">{p.containers}</td>
                  <td className="td-num">{p.orphans ? `${p.orphans} 个 ${formatBytes(p.orphanBytes, 1)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}
