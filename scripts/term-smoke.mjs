#!/usr/bin/env node
/**
 * 容器终端的无头冒烟测试（不需要浏览器）：
 *   node scripts/term-smoke.mjs [server] [container] ["要执行的命令"]
 *
 * 它连的是后端 WebSocket，验证的东西和浏览器点进去完全一样：
 * pty 是否分配、tmux 是否接上、输出能不能拿回来。
 */
import WebSocket from 'ws'

const server = process.argv[2] || 's0'
const container = process.argv[3] || 'teacher-demo'
const command = process.argv[4] || 'hostname; tty; tmux display -p "#S"; nvidia-smi -L 2>&1 | head -2'
const PORT = Number(process.env.API_PORT || 8787)
// 想验证 vite 的 /ws 代理（浏览器实际走的那条路），设 WS_BASE=http://localhost:5173
const BASE = process.env.WS_BASE || `http://127.0.0.1:${PORT}`
const MARK = '<<<SMOKE_END>>>'

const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/terminal?server=${encodeURIComponent(server)}&container=${encodeURIComponent(container)}&cols=90&rows=24`)
let buf = ''
let finished = false

const finish = (code) => {
  if (finished) return
  finished = true
  const text = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  console.log('----- 终端原始输出（去 ANSI 后） -----')
  console.log(text.split('\n').slice(0, 40).join('\n'))
  const checks = {
    有输出: text.trim().length > 0,
    拿到pty: /\/dev\/pts\//.test(text) || !/no tty|not a tty/i.test(text),
    tmux会话: /ui/.test(text),
    命令执行完: text.includes(MARK) || text.includes(container),
  }
  console.log('----- 判定 -----')
  for (const [k, v] of Object.entries(checks)) console.log(`${v ? '✓' : '✗'} ${k}`)
  ws.close()
  process.exitCode = v_any(checks) ? 0 : 1
  setTimeout(() => process.exit(), 200)
}
const v_any = (o) => Object.values(o).every(Boolean)

ws.on('error', (err) => { console.error(`WebSocket 连接失败: ${err.message}（后端起来了吗？npm run api）`); process.exitCode = 2 })
ws.on('open', () => {
  const feed = (s) => ws.send(JSON.stringify({ t: 'in', d: Buffer.from(`${s}\n`, 'utf8').toString('base64') }))
  setTimeout(() => feed('clear'), 400)
  setTimeout(() => feed(command), 1200)
  setTimeout(() => feed(`echo ${MARK}`), 2600)
})
ws.on('message', (raw) => {
  let msg
  try { msg = JSON.parse(raw.toString('utf8')) } catch { return }
  if (msg.t === 'out') buf += Buffer.from(msg.d, 'base64').toString('utf8')
  if (buf.includes(MARK)) finish(0)
})
setTimeout(() => finish(1), 25000)
