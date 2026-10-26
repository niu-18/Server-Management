const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(n, digits) {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n === 0) return digits === 0 ? '0B' : '0 B'
  let v = Math.abs(n)
  let i = 0
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024
    i++
  }
  const d = digits ?? (v >= 100 || i === 0 ? 0 : 1)
  return `${v.toFixed(d)}${UNITS[i]}`
}

export function formatPercent(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n.toFixed(n < 10 ? 1 : 0)}%`
}

export function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${m}分`
  return `${m}分`
}

export function formatAgo(iso) {
  if (!iso) return '从未'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}

export function formatClock(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', { hour12: false })
}

export function usageTone(pct) {
  if (pct == null) return 'none'
  if (pct >= 90) return 'critical'
  if (pct >= 80) return 'high'
  if (pct >= 60) return 'mid'
  return 'low'
}
