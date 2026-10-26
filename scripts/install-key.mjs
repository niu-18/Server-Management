#!/usr/bin/env node
/**
 * 把本 UI 的公钥写入 9 台服务器的 ~/.ssh/authorized_keys（用密码登录一次）。
 * 密码只在内存里，不落盘。
 *
 *   npm run install-key                    交互输入密码
 *   npm run install-key -- --dry-run       只测试密码是否可用
 *   npm run install-key -- --only s0,s1    只处理部分主机
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { Client } from 'ssh2'
import { CONFIG, loadServers } from '../server/config.mjs'

const args = process.argv.slice(2)
const flag = (n) => {
  const i = args.indexOf(`--${n}`)
  return i === -1 ? null : args[i + 1]
}
const has = (n) => args.includes(`--${n}`)

const dryRun = has('dry-run')
const only = flag('only')?.split(',').map((s) => s.trim()).filter(Boolean) || null
const pubPath = flag('key') || path.join(os.homedir(), '.ssh', 'srvman_ed25519.pub')
const privPath = flag('private-key') || CONFIG.apiKey
const limit = Number(flag('concurrency')) || 4

if (!fs.existsSync(pubPath)) {
  console.error(`找不到公钥: ${pubPath}`)
  process.exit(1)
}
const publicKey = fs.readFileSync(pubPath, 'utf8').trim()
const keyBlob = publicKey.split(/\s+/)[1]
if (!keyBlob) {
  console.error('公钥格式不对')
  process.exit(1)
}

function askHidden(text) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      rl.question(text, (a) => { rl.close(); resolve(a) })
      return
    }
    process.stdout.write(text)
    let buf = ''
    const prevRaw = process.stdin.isRaw
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    const onKey = (ch) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.removeListener('data', onKey)
        process.stdin.setRawMode(Boolean(prevRaw))
        process.stdin.pause()
        process.stdout.write('\n')
        resolve(buf)
      } else if (ch === '\u0003') {
        process.stdin.removeListener('data', onKey)
        process.stdin.setRawMode(Boolean(prevRaw))
        process.stdout.write('\n已取消\n')
        process.exit(130)
      } else if (ch === '\u007f' || ch === '\b') {
        buf = buf.slice(0, -1)
      } else if (ch.charCodeAt(0) >= 32) {
        buf += ch
        process.stdout.write('*')
      }
    }
    process.stdin.on('data', onKey)
  })
}

function withConn(server, password) {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    conn.once('ready', () => resolve(conn))
    conn.once('error', reject)
    conn.connect({
      host: server.host,
      port: server.port,
      username: server.user,
      password,
      readyTimeout: 20000,
    })
  })
}

function withKey(server) {
  return new Promise((resolve, reject) => {
    if (!privPath || !fs.existsSync(privPath)) return reject(new Error('私钥不存在'))
    const conn = new Client()
    conn.once('ready', () => resolve(conn))
    conn.once('error', reject)
    conn.connect({
      host: server.host,
      port: server.port,
      username: server.user,
      privateKey: fs.readFileSync(privPath),
      readyTimeout: 20000,
    })
  })
}

function run(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      let err_ = ''
      stream.on('data', (d) => (out += d))
      stream.stderr.on('data', (d) => (err_ += d))
      stream.on('close', (code) => resolve({ code, out: out.trim(), err: err_.trim() }))
    })
  })
}

const INSTALL_CMD = [
  'set -e',
  'umask 077',
  'mkdir -p "$HOME/.ssh"',
  'chmod 700 "$HOME/.ssh"',
  'touch "$HOME/.ssh/authorized_keys"',
  'chmod 600 "$HOME/.ssh/authorized_keys"',
  `grep -qF '${keyBlob}' "$HOME/.ssh/authorized_keys" 2>/dev/null \\`,
  `  && echo "ALREADY" || { printf '%s\\n' '${publicKey}' >> "$HOME/.ssh/authorized_keys"; echo "ADDED"; }`,
].join('\n')

async function handle(server, password) {
  const r = { id: server.id, target: `${server.user}@${server.host}:${server.port}` }
  let conn
  try {
    conn = await withConn(server, password)
    if (dryRun) {
      const probe = await run(conn, 'echo OK; id -un; hostname')
      r.password = 'ok'
      r.detail = probe.out.replace(/\n/g, ' / ')
      r.install = 'skipped(--dry-run)'
      return r
    }
    const inst = await run(conn, INSTALL_CMD)
    r.password = 'ok'
    r.install = inst.out || `exit ${inst.code}`
    if (inst.err) r.installErr = inst.err.slice(0, 200)
    conn.end()
    conn = null

    const v = await withKey(server)
    const probe = await run(v, 'echo KEY_OK; id -un; hostname; uname -sr')
    v.end()
    r.verify = probe.out.includes('KEY_OK') ? 'key-ok' : 'key-failed'
    r.detail = probe.out.replace(/KEY_OK\n?/, '').replace(/\n/g, ' / ')
    return r
  } catch (err) {
    r.error = err.message || String(err)
    if (conn) try { conn.end() } catch { /* ignore */ }
    return r
  }
}

async function main() {
  const servers = loadServers().filter((s) => !only || only.includes(s.id))
  if (servers.length === 0) {
    console.error(`没有匹配的主机 (--only ${only})`)
    process.exit(1)
  }
  console.log(`公钥 : ${publicKey.slice(0, 60)}…`)
  console.log(`目标 : ${servers.map((s) => `${s.id}(:${s.port})`).join(' ')}`)
  const password = process.env.SSH_PASSWORD || (await askHidden('SSH 密码（输入不回显）: '))
  if (!password) {
    console.error('密码为空，退出')
    process.exit(1)
  }

  const queue = [...servers]
  const results = []
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const s = queue.shift()
      const res = await handle(s, password)
      results.push(res)
      const tag = res.error ? `✗ ${res.error}` : `${res.install || ''} ${res.verify || ''}`.trim()
      console.log(`  ${res.id.padEnd(3)} ${res.target.padEnd(30)} ${tag}`)
      if (res.detail) console.log(`      ${res.detail}`)
    }
  })
  await Promise.all(workers)

  const failed = results.filter((r) => r.error || r.verify === 'key-failed')
  console.log('')
  if (dryRun) {
    console.log(`dry-run 完成：${results.filter((r) => r.password === 'ok').length}/${servers.length} 台密码可用`)
  } else if (failed.length === 0) {
    console.log(`全部完成：${results.filter((r) => r.verify === 'key-ok').length}/${servers.length} 台已可免密登录`)
    console.log('下一步: npm run dev')
  } else {
    console.log(`有 ${failed.length} 台未通过: ${failed.map((f) => f.id).join(', ')}`)
    process.exitCode = 1
  }
}

main()
