/**
 * 本机访问边界。
 *
 * 只监听 127.0.0.1 挡不住浏览器：WebSocket 不受同源策略限制，任何网页都能连
 * ws://127.0.0.1:8787/ws/terminal；DNS rebinding 也能让恶意域名解析到 127.0.0.1
 * 后同源调用 API（那时 Host 头是攻击者的域名）。
 *
 * 所以 HTTP 和 WS 升级都要校验 Host（挡住 rebinding）和 Origin（挡住第三方网页）。
 * 注意 vite 代理带 changeOrigin，会把 Host 改成 127.0.0.1，所以不能只校验 Host。
 */
export function isLoopbackName(name) {
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '[::1]'
}

export function hostAllowed(hostHeader) {
  const h = String(hostHeader || '').trim()
  if (!h) return false
  try {
    return isLoopbackName(new URL(`http://${h}`).hostname)
  } catch {
    return false
  }
}

export function originAllowed(origin) {
  if (!origin) return true // curl / 命令行工具不带 Origin
  try {
    return isLoopbackName(new URL(origin).hostname)
  } catch {
    return false
  }
}

export function httpGuard(req, res, next) {
  if (!hostAllowed(req.headers.host)) {
    return res.status(403).json({ error: `Host 不被允许（${req.headers.host || '空'}）；这个界面只接受 127.0.0.1 / localhost 访问` })
  }
  if (!originAllowed(req.headers.origin)) {
    return res.status(403).json({ error: `Origin 不被允许（${req.headers.origin}）` })
  }
  next()
}

export function upgradeAllowed(req) {
  return hostAllowed(req.headers.host) && originAllowed(req.headers.origin)
}
