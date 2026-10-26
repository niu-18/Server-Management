import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

function cssVar(name, fallback) {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function b64encode(s) {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  bytes.forEach((b) => { bin += String.fromCharCode(b) })
  return btoa(bin)
}

/**
 * 容器终端。外层用 key={`${server}/${container}`} 强制重挂，
 * 所以这里不用处理“换容器”的情况，只管开/关。
 */
export default function ContainerTerminal({ server, container, open, insert, onStatus }) {
  const hostRef = useRef(null)
  const termRef = useRef(null)
  const sockRef = useRef(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!open || !hostRef.current) return undefined

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: cssVar('--mono', 'monospace'),
      theme: {
        background: cssVar('--term-bg', '#0b1220'),
        foreground: cssVar('--term-fg', '#e6ebf5'),
        cursor: cssVar('--accent', '#5b9dff'),
        selectionBackground: cssVar('--line-strong', '#33456a'),
      },
      scrollback: 4000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    termRef.current = term

    const cols = term.cols || 90
    const rows = term.rows || 26
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/ws/terminal?server=${encodeURIComponent(server)}`
      + `&container=${encodeURIComponent(container)}&cols=${cols}&rows=${rows}`
    const ws = new WebSocket(url)
    sockRef.current = ws

    ws.onopen = () => { setConnected(true); onStatus?.('已连接'); term.focus() }
    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.t !== 'out') return
      term.write(Uint8Array.from(atob(msg.d), (c) => c.charCodeAt(0)))
    }
    ws.onclose = () => {
      setConnected(false)
      onStatus?.('已断开')
      term.write('\r\n\x1b[90m连接已断开。容器里的 tmux 会话不受影响，重新点“进入终端”就能接回去。\x1b[0m\r\n')
    }
    ws.onerror = () => {
      setConnected(false)
      onStatus?.('连接出错')
      term.write('\r\n\x1b[90mWebSocket 出错：确认后端在跑（npm run api），再刷新页面重试。\x1b[0m\r\n')
    }

    const disp = term.onData((s) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'in', d: b64encode(s) }))
    })

    const onResize = () => {
      try {
        fit.fit()
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
      } catch { /* 拖窗口太快会抛，忽略 */ }
    }
    window.addEventListener('resize', onResize)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null
    ro?.observe(hostRef.current)

    return () => {
      window.removeEventListener('resize', onResize)
      ro?.disconnect()
      disp.dispose()
      try { ws.close() } catch { /* ignore */ }
      term.dispose()
      termRef.current = null
      sockRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, server, container])

  // 体检面板点“贴到终端”：写进输入行但不回车，由人确认后执行
  useEffect(() => {
    if (!open || !insert?.seq || !termRef.current) return
    termRef.current.write(insert.text)
    termRef.current.focus()
  }, [open, insert])

  return (
    <div className="term-wrap">
      <div className="term-bar">
        <span className={`term-dot ${connected ? 'on' : ''}`} aria-hidden="true" />
        <span className="term-title">{container} @ {server}</span>
        <span className="term-hint">
          {connected ? '已连接 · 里面是 tmux 会话 ui，关掉浏览器不会杀正在跑的东西' : '连接中…'}
        </span>
      </div>
      <div className="term-host" ref={hostRef} />
    </div>
  )
}
