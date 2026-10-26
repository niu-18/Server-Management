import { useState } from 'react'
import { copyText } from '../lib/api.js'

const ICON = { pass: '✓', warn: '!', fail: '✗', error: '×', skip: '–' }
const LABEL = { pass: '通过', warn: '注意', fail: '不通过', error: '取不到', skip: '不适用' }

/** facts.gpu_names 是分号串，同型号重复出现，收成 “8× Tesla V100” 才好读 */
function gpuSummary(facts) {
  const names = String(facts?.gpu_names || '').split(';').map((s) => s.trim()).filter(Boolean)
  if (names.length === 0) return ''
  const counts = new Map()
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1)
  return [...counts.entries()].map(([n, c]) => (c > 1 ? `${c}× ${n}` : n)).join('，')
}

export default function CheckPanel({ result, busy, onRerun, onInsert, includeSlow, onToggleSlow }) {
  const [openRow, setOpenRow] = useState(null)
  const [copied, setCopied] = useState('')

  if (!result) {
    return (
      <div className="empty">
        选一个容器，点“一键体检”。每项检查独立出结果，不通过的那一项会写明是哪条命令、报了什么错、怎么修。
      </div>
    )
  }

  const doCopy = async (text, key) => {
    const ok = await copyText(text)
    setCopied(ok ? key : `失败:${key}`)
    setTimeout(() => setCopied(''), 1600)
  }

  const counts = result.results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc }, {})

  return (
    <div className="check-panel">
      <div className="check-head">
        <div>
          <span className={`verdict verdict-${result.verdict}`}>
            {ICON[result.verdict] || '?'} {LABEL[result.verdict] || result.verdict}
          </span>
          <span className="check-sub">
            {result.container} @ {result.member || result.server} · {result.status} · 宿主驱动 {result.hostDriver || '—'} · {result.ranAt?.slice(11, 19)}
          </span>
        </div>
        <div className="check-actions">
          <label className="toggle">
            <input type="checkbox" checked={Boolean(includeSlow)} onChange={(e) => onToggleSlow(e.target.checked)} />
            <span>含 torch 慢检查</span>
          </label>
          <button type="button" className="btn btn-small" onClick={onRerun} disabled={busy}>
            {busy ? '体检中…' : '重新体检'}
          </button>
        </div>
      </div>

      {result.error && <div className="banner banner-error">采集失败：{result.error}</div>}

      <p className="note">
        通过 {counts.pass || 0} · 注意 {counts.warn || 0} · 不通过 {counts.fail || 0} · 不适用 {counts.skip || 0}
        {result.facts?.gpu_count ? ` · ${result.member} 有 ${result.facts.gpu_count} 张卡（${gpuSummary(result.facts)}）` : ''}
      </p>

      {result.hostDriverBroken && (
        <div className="banner banner-error">
          {result.member} 宿主机的 <code>nvidia-smi</code> 本身就报错（{result.facts?.nvml_error}）。
          这台上所有容器的 GPU 都会跟着坏，先修宿主机 —— 容器里重装驱动没有用。
        </div>
      )}

      <table className="table table-compact check-table">
        <thead>
          <tr>
            <th className="th-left">结果</th>
            <th className="th-left">检查项</th>
            <th className="th-left">结论</th>
            <th className="th-left">&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          {result.results.map((r) => (
            <Row
              key={r.id}
              row={r}
              expanded={openRow === r.id}
              onToggle={() => setOpenRow((v) => (v === r.id ? null : r.id))}
              onCopy={doCopy}
              onInsert={onInsert}
              copied={copied === r.id || copied === `${r.id}:fix`}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Row({ row, expanded, onToggle, onCopy, onInsert, copied }) {
  const hasFix = (row.commands || []).length > 0
  return (
    <>
      <tr className={`check-row ${row.status === 'fail' ? 'row-hot' : ''}`}>
        <td className="td-status">
          <span className={`st st-${row.status}`} title={LABEL[row.status] || row.status}>{ICON[row.status] || '?'}</span>
        </td>
        <td className="td-name">
          <span className="acct-name">{row.title}</span>
          <span className="acct-uid">{row.group}</span>
        </td>
        <td className="td-detail">{row.detail}</td>
        <td className="th-right">
          <button type="button" className={`twisty ${expanded ? 'open' : ''}`} onClick={onToggle} aria-expanded={expanded}>▸</button>
        </td>
      </tr>
      {expanded && (
        <tr className="row-kids">
          <td colSpan={4}>
            <div className="detail-block">
              <div className="detail-line"><span className="detail-k">执行的命令</span><code>{row.command}</code></div>
              <div className="detail-line"><span className="detail-k">退出码</span><code>{row.rc == null ? '—（没跑成）' : row.rc}</code></div>
              {row.output && (
                <div className="detail-line detail-out">
                  <span className="detail-k">原始输出</span>
                  <pre>{row.output}</pre>
                </div>
              )}
              {row.manual && (
                <div className="detail-line"><span className="detail-k">手册出处</span><span className="muted">{row.manual}</span></div>
              )}
              {hasFix && (
                <div className="fix-box">
                  <div className="detail-k">修复命令（只生成，我不会替你执行）</div>
                  {(row.commands || []).map((cmd, i) => (
                    <div className="fix-line" key={`${row.id}-${i}`}>
                      <code>{cmd}</code>
                      <span className="fix-btns">
                        <button type="button" className="btn btn-tiny" onClick={() => onCopy(cmd, `${row.id}:fix`)}>复制</button>
                        {!cmd.startsWith('#') && (
                          <button type="button" className="btn btn-tiny" onClick={() => onInsert(cmd)}>贴到终端</button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {copied && <span className="muted">已复制到剪贴板</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
