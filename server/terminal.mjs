/**
 * 容器终端：浏览器 ←WebSocket→ Node ←SSH pty→ lxc exec ←→ 容器里的 tmux。
 *
 * 为什么要套一层 tmux：浏览器一刷新、Node 一重启，SSH 通道就断了；
 * 如果直接跑 bash，学生（或你自己）正在跑的训练会跟着一起没。
 * 套上 tmux 后断的只是客户端，容器里的 tmux server 和它的子进程照跑，
 * 下次点进来 `tmux new -A -s ui` 就是重新 attach。
 *
 * 安全边界：
 *   · 后端只监听 127.0.0.1（见 index.mjs），本机能开就是本人。
 *   · 容器名先用正则卡一次，再拿真实 `lxc list` 核对，绝不把用户输入拼进命令。
 *   · 停着的容器直接拒绝，不自动 lxc start（那是会影响别人的写操作）。
 *   · 宿主机 shell 默认关闭，要 ALLOW_HOST_TERMINAL=1 才开。
 *   · 只记会话起止和时长到 logs/sessions.jsonl，不录键入内容。
 */
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { Client } from 'ssh2'
import { CONFIG } from './config.mjs'
import { buildConnectOptions } from './ssh.mjs'
import { shQuote } from './checks.mjs'
import { parseInstances } from './lxd.mjs'
import { upgradeAllowed } from './guard.mjs'

const NAME_RE = /^[A-Za-z0-9._-]+$/

function log(session) {
  try {
    fs.mkdirSync(path.dirname(CONFIG.sessionLog), { recursive: true })
    fs.appendFileSync(CONFIG.sessionLog, `${JSON.stringify(session)}\n`)
  } catch (err) {
    console.warn(`[terminal] 会话日志写不下去: ${err.message}`)
  }
}

function connect(server) {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    conn.once('ready', () => resolve(conn))
    conn.once('error', reject)
    conn.connect(buildConnectOptions(server))
  })
}

/** 拿成员上的真实实例清单，用来核对名字和状态。 */
async function liveInstances(conn) {
  // lxc list 在集群异常时会挂住；没有超时这里永远不返回，pty 也建不起来
  const json = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { conn.end() } catch { } reject(new Error('读取实例清单超时（30s）')) }, 30000)
    conn.exec('lxc list --format=json 2>/dev/null | tr -d "\\n"', (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err) }
      let out = ''
      stream.on('data', (d) => (out += d))
      stream.stderr.on('data', () => {})
      stream.on('close', () => { clearTimeout(timer); resolve(out) })
    })
  })
  return parseInstances(json)
}

function execPty(conn, command, { cols, rows }) {
  return new Promise((resolve, reject) => {
    conn.exec(
      command,
      { pty: { term: 'xterm-256color', rows, cols, width: 0, height: 0 } },
      (err, stream) => (err ? reject(err) : resolve(stream)),
    )
  })
}

export function attachTerminal(httpServer, { servers }) {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req, socket, head) => {
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname !== '/ws/terminal') return // 别的升级请求留给别人
    if (!upgradeAllowed(req)) {
      // Host/Origin 不对就拒绝升级：否则任何网页都能连进来开容器 root shell
      socket.write('HTTP/1.1 403 Forbidden' + String.fromCharCode(13, 10, 13, 10))
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleSession(ws, url, servers))
  })

  return wss
}

async function handleSession(ws, url, servers) {
  const serverId = url.searchParams.get('server') || ''
  const container = (url.searchParams.get('container') || '').trim()
  const mode = url.searchParams.get('mode') === 'host' ? 'host' : 'container'
  const cols = Math.max(20, Math.min(400, Number(url.searchParams.get('cols')) || 100))
  const rows = Math.max(6, Math.min(200, Number(url.searchParams.get('rows')) || 30))

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  }
  const outText = (text) => send({ t: 'out', d: Buffer.from(String(text), 'utf8').toString('base64') })

  const server = servers.find((s) => s.id === serverId)
  if (!server) {
    outText(`\r\n未知服务器 ${serverId}\r\n`)
    ws.close()
    return
  }
  if (mode === 'host' && !CONFIG.allowHostTerminal) {
    outText('\r\n宿主机 shell 没有打开。要用的话设 ALLOW_HOST_TERMINAL=1 再启动后端。\r\n')
    ws.close()
    return
  }
  if (mode === 'container' && !NAME_RE.test(container)) {
    outText(`\r\n容器名不合法: ${container}\r\n`)
    ws.close()
    return
  }

  const openedAt = Date.now()
  let conn
  let stream
  let idleTimer
  let aborted = false
  let closed = false

  const closeAll = (reason) => {
    if (closed) return
    closed = true
    aborted = true
    if (idleTimer) clearTimeout(idleTimer)
    try { stream?.end() } catch { /* ignore */ }
    try { conn?.end() } catch { /* ignore */ }
    log({ mode, server: serverId, container: container || null, reason: reason || 'closed', openedAt, closedAt: Date.now(), durationMs: Date.now() - openedAt })
    if (ws.readyState === ws.OPEN) ws.close()
  }

  // 浏览器可能在连 SSH / 取实例 / 开 pty 的任意一刻关掉页面。
  // 关闭事件必须在任何 await 之前注册，否则会留下一个 root shell 和 30 分钟空闲计时器。
  ws.on('close', () => { aborted = true; closeAll('ws-close') })
  ws.on('error', () => { aborted = true; closeAll('ws-error') })

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { outText('\r\n[空闲太久，已断开；容器里的 tmux 会话还在，重新点进来即可]\r\n'); closeAll('idle') }, CONFIG.terminalIdleMs)
  }

  try {
    conn = await connect(server)
  } catch (err) {
    outText(`\r\n连不上 ${serverId}: ${err.message}\r\n`)
    ws.close()
    return
  }
  if (aborted) { try { conn.end() } catch { /* ignore */ } return }

  try {
    let command
    if (mode === 'host') {
      command = 'exec bash -l'
    } else {
      const instances = await liveInstances(conn)
      if (aborted) return closeAll('aborted')
      const inst = instances.find((i) => i.name === container)
      if (!inst) {
        outText(`\r\n${serverId} 所在的 LXD 集群里没有容器 ${container}，拒绝进入。\r\n`)
        return closeAll('not-found')
      }
      if (inst.status !== 'Running') {
        outText(
          `\r\n${container} 当前是 ${inst.status}，进不去。要开的话自己执行：\r\n  lxc start ${shQuote(container)}\r\n` +
            `（我没有自动帮你 start —— 那会影响别人）\r\n`,
        )
        return closeAll('stopped')
      }
      const memberNote = inst.location && inst.location !== serverId ? `（它在 ${inst.location}，LXD 会自己转过去）\r\n` : ''
      outText(`\r\n→ ${container} @ ${serverId}${memberNote}`)
      command =
        `lxc exec ${shQuote(container)} -- sh -c ` +
        shQuote('if command -v tmux >/dev/null 2>&1; then exec tmux new -A -s ui; else echo "[这个容器没有 tmux，用的是普通 bash；跑长任务前先装一个]"; exec bash -l; fi')
    }

    stream = await execPty(conn, command, { cols, rows })
    if (aborted) { try { stream.end() } catch { /* ignore */ } return closeAll('aborted') }
    armIdle()

    stream.on('data', (buf) => { armIdle(); send({ t: 'out', d: buf.toString('base64') }) })
    stream.stderr.on('data', (buf) => send({ t: 'out', d: buf.toString('base64') }))
    stream.on('close', (code) => { outText(`\r\n[会话结束，退出码 ${code}]\r\n`); closeAll('pty-close') })
    stream.on('error', (err) => { outText(`\r\n[通道错误: ${err.message}]\r\n`); closeAll('pty-error') })

    ws.on('message', (raw) => {
      if (closed) return
      let msg
      try {
        msg = JSON.parse(raw.toString('utf8'))
      } catch {
        return
      }
      armIdle()
      if (msg.t === 'in') {
        const data = Buffer.from(String(msg.d ?? ''), 'base64')
        stream.write(data)
      } else if (msg.t === 'resize') {
        const r = Math.max(6, Math.min(200, Number(msg.rows) || rows))
        const c = Math.max(20, Math.min(400, Number(msg.cols) || cols))
        try { stream.setWindow(r, c, 0, 0) } catch { /* 有的实现对 setWindow 宽容 */ }
      }
    })

    log({ mode, server: serverId, container: container || null, reason: 'open', openedAt, cols, rows })
  } catch (err) {
    outText(`\r\n进不去: ${err.message}\r\n`)
    closeAll('throw')
  }
}
