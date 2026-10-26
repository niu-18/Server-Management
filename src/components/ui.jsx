import { useEffect, useState } from 'react'
import { copyText } from '../lib/api.js'
import { subscribeToast } from '../lib/toast.js'

/** 每个版块统一的开头：标题 + 一句说明 + 右侧操作 */
export function SectionHeader({ title, sub, children, level = 2 }) {
  const H = level === 3 ? 'h3' : 'h2'
  return (
    <header className="sec-head">
      <div className="sec-head-text">
        <H>{title}</H>
        {sub && <p className="sec-sub">{sub}</p>}
      </div>
      {children && <div className="sec-actions">{children}</div>}
    </header>
  )
}

/** 顶部/概览用的数字卡 */
export function Stat({ label, value, hint, tone = 'none', onClick }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag type={onClick ? 'button' : undefined} className={`stat ${onClick ? 'stat-click' : ''}`} onClick={onClick}>
      <span className="stat-k">{label}</span>
      <span className={`stat-v tone-${tone}`}>{value}</span>
      {hint && <span className="stat-h">{hint}</span>}
    </Tag>
  )
}

/** 带 toast 的复制按钮 */
export function CopyBtn({ text, label = '复制', small = true, title }) {
  return (
    <button
      type="button"
      className={`btn ${small ? 'btn-tiny' : ''}`}
      title={title || `复制：${text}`}
      onClick={async (e) => {
        e.stopPropagation()
        const ok = await copyText(text)
        const { toast } = await import('../lib/toast.js')
        toast(ok ? '已复制到剪贴板' : '复制失败，请手动选中', ok ? 'ok' : 'warn')
      }}
    >
      {label}
    </button>
  )
}

export function Toaster() {
  const [items, setItems] = useState([])
  useEffect(() => subscribeToast((item) => {
    setItems((prev) => [...prev.slice(-3), item])
    setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== item.id)), 2200)
  }), [])
  if (items.length === 0) return null
  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((it) => (
        <div key={it.id} className={`toast toast-${it.kind}`}>{it.message}</div>
      ))}
    </div>
  )
}
