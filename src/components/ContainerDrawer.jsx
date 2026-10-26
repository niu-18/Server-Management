import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { postJson } from '../lib/api.js'
import { formatBytes, formatPercent, formatAgo, usageTone } from '../lib/format.js'
import { SectionHeader, CopyBtn } from './ui.jsx'
import CheckPanel from './CheckPanel.jsx'
import ContainerTerminal from './ContainerTerminal.jsx'

/**
 * 全局容器抽屉：容器名出现在任何地方，点开都是这里。
 * 把"体检 + 终端 + 基本信息 + 端口"放一处，省得在几个页签之间来回跳。
 */
export default function ContainerDrawer({ target, servers, ipRows = [], onClose, onChecked }) {
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [includeSlow, setIncludeSlow] = useState(false)
  const [termOpen, setTermOpen] = useState(false)
  const [insert, setInsert] = useState({ seq: 0, text: '' })
  const seqRef = useRef(0)
  const lastKey = useRef('')

  const info = useMemo(() => {
    if (!target?.container) return null
    for (const s of servers || []) {
      const c = (s.lxd?.containers || []).find((x) => x.name === target.container)
      if (c) return { container: c, host: s, member: c.location || s.id }
    }
    return { container: { name: target.container, status: '?', usedBytes: null, quotaBytes: null, usedPercent: null }, host: null, member: target.server || '?' }
  }, [target, servers])

  const runSeq = useRef(0)
  const run = useCallback(async (slow = includeSlow) => {
    if (!target?.container) return
    // 切到别的容器后，慢请求（torch）回来不能覆盖新容器的结果
    const seq = ++runSeq.current
    const forContainer = target.container
    setBusy(true)
    setError(null)
    try {
      const { body } = await postJson('/api/check', {
        container: forContainer,
        server: target.server || undefined,
        includeSlow: slow,
      })
      if (seq !== runSeq.current) return
      setResult(body)
      onChecked?.(body)
    } catch (e) {
      if (seq !== runSeq.current) return
      setError(e.message)
    } finally {
      if (seq === runSeq.current) setBusy(false)
    }
  }, [target, includeSlow, onChecked])

  useEffect(() => {
    if (!target?.container) return
    const key = `${target.container}|${target.stamp || ''}`
    if (lastKey.current === key) return
    lastKey.current = key
    setResult(null)
    setError(null)
    setTermOpen(target.want === 'terminal')
    run(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  useEffect(() => {
    if (!target) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [target, onClose])

  if (!target) return null
  const c = info?.container || {}
  const ports = c.proxyPorts || []
  const ipByKey = new Map((ipRows || []).map((r) => [`${r.container}|${r.listenPort}`, r]))
  const sshPort = ports.find((p) => p.connectPort === 22)?.listenPort
  // LXD 的 state.network 在这套 5.0 上有时是空的；proxy 的 connect 地址反而是"真能连到的那个"
  const containerAddr = c.ipv4 || ports[0]?.connectHost || '—'
  const open = Boolean(target)

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className={`drawer ${open ? 'drawer-open' : ''}`} role="dialog" aria-label={`${c.name} 详情`}>
        <div className="drawer-head">
          <div>
            <h2 className="drawer-title">{c.name || target.container}</h2>
            <p className="drawer-sub">
              {info?.member || '—'} · {c.status || '—'}
              {c.usedPercent != null && <span className={`tone-${usageTone(c.usedPercent)}`}> · {formatPercent(c.usedPercent)} 配额</span>}
            </p>
          </div>
          <button type="button" className="drawer-x" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="drawer-body">
          <div className="kv-grid drawer-kv">
            <div className="kv"><span className="kv-k">已用 / 配额</span><span className="kv-v">{formatBytes(c.usedBytes)} <span className="s-u">/ {c.quotaBytes ? formatBytes(c.quotaBytes) : '无配额'}</span></span></div>
            <div className="kv"><span className="kv-k">最近启动</span><span className="kv-v kv-small">{c.lastUsedAt ? formatAgo(c.lastUsedAt) : '—'}</span></div>
            <div className="kv"><span className="kv-k">容器地址</span><span className="kv-v kv-small">{containerAddr}</span></div>
            <div className="kv"><span className="kv-k">数据集</span><span className="kv-v kv-small">{c.dataset || '—'}</span></div>
          </div>

          <section className="drawer-sec">
            <SectionHeader level={3} title="对外端口" sub={ports.length ? '来自 LXD proxy 设备；外部可达性去「端口与配额」里一键定责' : '这个容器没有对外端口，只能走下面的终端进'}>
              {sshPort && <CopyBtn text={`ssh ubuntu@10.0.0.10 -p ${sshPort}`} label="复制 SSH" />}
            </SectionHeader>
            {ports.length > 0 ? (
              <ul className="port-list">
                {ports.map((p) => {
                  const ip = ipByKey.get(`${c.name}|${p.listenPort}`)
                  const bad = ip && !['match', 'unknown'].includes(ip.ipVerdict)
                  return (
                    <li key={p.device}>
                      <code>10.0.0.10:{p.listenPort}</code>
                      <span className="muted">→ {p.connectHost}:{p.connectPort}</span>
                      <span className="chip">{p.connectPort === 22 ? 'SSH' : '服务'}</span>
                      {ip ? (
                        <span className={bad ? 'tone-critical' : 'muted'}>
                          实际 IP {ip.actualIps?.join(' / ') || '（空）'}{bad ? ' · 不一致' : ''}
                        </span>
                      ) : <span className="muted">实际 IP 未核对</span>}
                      {bad && <span className="ip-tag">去「端口与配额」一键核对并给修复命令</span>}
                    </li>
                  )
                })}
              </ul>
            ) : <p className="note">—</p>}
          </section>

          <section className="drawer-sec">
            <SectionHeader level={3} title="账户体检" sub="9 项只读检查；失败项会写明是哪条命令、报了什么，并给修复命令（不代执行）">
              <label className="toggle">
                <input type="checkbox" checked={includeSlow} onChange={(e) => { setIncludeSlow(e.target.checked); run(e.target.checked) }} />
                <span>含 torch 慢检查</span>
              </label>
              <button type="button" className="btn btn-small" onClick={() => run()} disabled={busy}>{busy ? '体检中…' : '重新体检'}</button>
            </SectionHeader>
            {error && <div className="banner banner-error">体检失败：{error}</div>}
            {!result && busy && <div className="skeleton">正在连 {info?.member} 跑检查…（一个容器约 4–6 秒）</div>}
            <CheckPanel
              result={result}
              busy={busy}
              includeSlow={includeSlow}
              onToggleSlow={(v) => { setIncludeSlow(v); run(v) }}
              onRerun={() => run()}
              onInsert={(text) => {
                seqRef.current += 1
                setInsert({ seq: seqRef.current, text: `${text}\n` })
                setTermOpen(true)
              }}
            />
          </section>

          <section className="drawer-sec">
            <SectionHeader level={3} title="容器终端" sub={c.status === 'Running' ? '浏览器里是 tmux 会话 ui，关掉页面不会杀正在跑的东西' : `容器是 ${c.status}，进不去；先 lxc start ${c.name}`}>
              <button
                type="button"
                className="btn btn-small"
                disabled={c.status !== 'Running'}
                onClick={() => setTermOpen((v) => !v)}
              >
                {termOpen ? '收起终端' : '进入终端'}
              </button>
            </SectionHeader>
            {termOpen && c.status === 'Running' && (
              <ContainerTerminal
                key={`${target.server}/${c.name}`}
                server={target.server || info?.member}
                container={c.name}
                open={termOpen}
                insert={insert}
              />
            )}
          </section>
        </div>
      </aside>
    </>
  )
}
