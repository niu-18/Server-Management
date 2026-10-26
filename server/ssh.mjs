/**
 * SSH 传输层。
 *
 * 之前这两个函数埋在 collect.mjs 里不导出；体检（checks.mjs）和容器终端
 * （terminal.mjs）都要用同一条连接方式，所以抽出来放在这里。
 * 行为与原来完全一致：优先用 server.key / CONFIG.apiKey 的免密钥，
 * 其次密码，最后 ssh-agent。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from 'ssh2'
import { CONFIG } from './config.mjs'

export function expandHome(p) {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

function readFileSafe(p) {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p) : null
  } catch {
    return null
  }
}

/** 主机密钥指纹：SHA256:base64（和 ssh-keygen -lf 的格式对齐） */
export function fingerprintKey(key) {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

function readKnownHosts() {
  try {
    return fs.existsSync(CONFIG.knownHostsFile) ? JSON.parse(fs.readFileSync(CONFIG.knownHostsFile, 'utf8')) : {}
  } catch {
    return {}
  }
}

function writeKnownHosts(store) {
  try {
    fs.mkdirSync(path.dirname(CONFIG.knownHostsFile), { recursive: true })
    fs.writeFileSync(CONFIG.knownHostsFile, JSON.stringify(store, null, 2))
  } catch (err) {
    console.warn(`[ssh] 记录主机密钥失败: ${err.message}`)
  }
}

export function listKnownHosts() {
  return readKnownHosts()
}

export function forgetKnownHost(id) {
  const store = readKnownHosts()
  if (id === '*') {
    writeKnownHosts({})
    return Object.keys(store).length
  }
  const had = Boolean(store[id])
  delete store[id]
  writeKnownHosts(store)
  return had ? 1 : 0
}

function hostKeyMessage(id, prev, now) {
  return [
    `主机密钥与上次记录的不一致：${id}`,
    `  上次记录 ${prev}`,
    `  本次收到 ${now}`,
    `如果是重装系统/换机器导致的，确认无误后执行：npm run trust -- --forget ${id}`,
    '（也可以用 SSH_VERIFY_HOST=0 临时关掉校验，不建议）',
  ].join(String.fromCharCode(10))
}

export function buildConnectOptions(server) {
  const opts = {
    host: server.host,
    port: server.port,
    username: server.user,
    readyTimeout: CONFIG.connectTimeout,
    keepaliveInterval: 10000,
  }
  const keyPath = server.key ? expandHome(server.key) : CONFIG.apiKey
  const privateKey = keyPath ? readFileSafe(keyPath) : null
  if (privateKey) opts.privateKey = privateKey
  if (server.password) opts.password = server.password
  else if (CONFIG.sshPassword) opts.password = CONFIG.sshPassword
  if (!opts.privateKey && !opts.password && process.env.SSH_AUTH_SOCK) {
    opts.agent = process.env.SSH_AUTH_SOCK
  }
  // 首次连接记录指纹（TOFU），之后不一致就拒绝 —— 防止局域网里有人冒充宿主
  if (CONFIG.verifyHostKeys) {
    const id = `${server.host}:${server.port}`
    opts.hostVerifier = (key) => {
      const fp = fingerprintKey(key)
      const store = readKnownHosts()
      const prev = store[id]
      if (!prev) {
        store[id] = { fingerprint: fp, at: new Date().toISOString() }
        writeKnownHosts(store)
        return true
      }
      if (prev.fingerprint === fp) return true
      opts.hostKeyMismatch = { id, prev: prev.fingerprint, now: fp }
      return false
    }
  }
  return opts
}

export function openConnection(server) {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    const opts = buildConnectOptions(server)
    conn.once('ready', () => resolve(conn))
    conn.once('error', (err) => {
      if (opts.hostKeyMismatch) {
        reject(new Error(hostKeyMessage(opts.hostKeyMismatch.id, opts.hostKeyMismatch.prev, opts.hostKeyMismatch.now)))
      } else {
        reject(err)
      }
    })
    conn.connect(opts)
  })
}

/** 跑一条命令，拿 stdout/stderr/退出码；超时会掐掉整条连接。 */
export function exec(conn, command, timeoutMs = CONFIG.execTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { conn.end() } catch { /* 已结束 */ }
      reject(new Error(`执行超时 (${Math.round(timeoutMs / 1000)}s)`))
    }, timeoutMs)
    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      stream.on('data', (d) => (stdout += d.toString('utf8')))
      stream.stderr.on('data', (d) => (stderr += d.toString('utf8')))
      stream.on('close', (code) => {
        clearTimeout(timer)
        resolve({ stdout, stderr, code })
      })
    })
  })
}

/** 开一条连接跑完再关；中途出错也要保证连接被关掉。 */
export async function withConnection(server, fn) {
  let conn
  try {
    conn = await openConnection(server)
    return await fn(conn)
  } finally {
    if (conn) try { conn.end() } catch { /* ignore */ }
  }
}
