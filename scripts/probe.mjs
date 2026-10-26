#!/usr/bin/env node
/**
 * 不走 UI，直接在终端采集并打印，用来验证连通性和解析是否正确。
 *
 *   npm run probe                 全部
 *   npm run probe -- s0 s3        指定主机
 *   npm run probe -- --raw s0     打印远端原始输出（调试解析用）
 *   npm run probe -- --no-nas     不让任何一台扫共享存储（更快）
 */
import { Client } from 'ssh2'
import fs from 'node:fs'
import { CONFIG, loadServers } from '../server/config.mjs'
import {
  collectAll,
  buildServerRecord,
  buildSharedStorage,
  splitSections,
} from '../server/collect.mjs'
import { buildRemoteScript } from '../server/remoteScript.mjs'

const args = process.argv.slice(2)
const raw = args.includes('--raw')
const noNas = args.includes('--no-nas')
const ids = args.filter((a) => !a.startsWith('--'))

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`
}

async function rawDump(server) {
  const conn = new Client()
  await new Promise((res, rej) => {
    conn.once('ready', res)
    conn.once('error', rej)
    conn.connect({
      host: server.host,
      port: server.port,
      username: server.user,
      privateKey: CONFIG.apiKey && fs.existsSync(CONFIG.apiKey) ? fs.readFileSync(CONFIG.apiKey) : undefined,
      password: CONFIG.sshPassword || undefined,
      readyTimeout: CONFIG.connectTimeout,
    })
  })
  const out = await new Promise((res, rej) => {
    conn.exec(buildRemoteScript({ scanNas: true }), (err, stream) => {
      if (err) return rej(err)
      let buf = ''
      let e = ''
      stream.on('data', (d) => (buf += d))
      stream.stderr.on('data', (d) => (e += d))
      stream.on('close', () => res({ buf, e }))
    })
  })
  conn.end()
  console.log(`----- ${server.id} raw stdout -----\n${out.buf}`)
  if (out.e) console.log(`----- ${server.id} stderr -----\n${out.e}`)
}

async function main() {
  const all = loadServers()
  const servers = ids.length ? all.filter((s) => ids.includes(s.id)) : all
  if (servers.length === 0) {
    console.error(`没有匹配的主机，可用: ${all.map((s) => s.id).join(',')}`)
    process.exit(1)
  }
  if (raw) {
    for (const s of servers) await rawDump(s)
    return
  }

  const scanner = noNas ? '__none__' : CONFIG.nasScanner
  console.log(`采集 ${servers.length} 台…（共享存储由 ${scanner} 扫描）`)
  const t0 = Date.now()
  const results = await collectAll(servers, scanner)
  const shared = buildSharedStorage(results)
  console.log(`耗时 ${Date.now() - t0}ms\n`)

  for (const r of results) {
    const head = `[${r.id}] ${r.hostname || '(无主机名)'} ${r.user}@${r.host}:${r.port}`
    if (r.status !== 'ok') {
      console.log(`${head}\n  ✗ ${r.error}\n`)
      continue
    }
    const p = r.capacity || r.primary
    console.log(head)
    console.log(
      `  ${r.capacityKind === 'lxd-pool' ? 'LXD 存储池' : '磁盘'}: ${p ? `${p.name || p.mount} ${fmt(p.usedBytes)}/${fmt(p.totalBytes)} (${p.usedPercent}%) 剩 ${fmt(p.availBytes)}` : '未识别'}`,
    )
    if (r.lxd) {
      const got = r.lxd.containers.filter((c) => c.usedBytes != null).length
      const how = r.lxd.zfsAvailable
        ? 'zfs 数据集'
        : r.lxd.containers.some((c) => c.source === 'df')
          ? '降级 lxc exec df'
          : '降级已禁用，未取到'
      console.log(`  容器 ${r.lxd.totals.containerCount} 个 / 运行 ${r.lxd.totals.runningCount} 个，取到用量 ${got} 个（${how}）`)
      if (r.lxd.totals.unattributedBytes != null) {
        console.log(`  池内未归属到容器的部分: ${fmt(r.lxd.totals.unattributedBytes)}`)
      }
    }
    for (const c of r.accounts.slice(0, 10)) {
      console.log(`    - ${(c.name || '').padEnd(22)} ${fmt(c.usedBytes).padStart(9)} / ${c.quotaBytes ? fmt(c.quotaBytes).padStart(9) : '     无配额'}${c.usedPercent != null ? ` ${c.usedPercent}%` : ''}  [${c.source}] ${c.status || ''}`)
    }
    if (r.accounts.length > 10) console.log(`    … 另外 ${r.accounts.length - 10} 个容器`)
    console.log(`  宿主系统盘: ${r.localMounts.map((m) => `${m.mount} ${fmt(m.usedBytes)}/${fmt(m.totalBytes)} ${m.usedPercent}%`).join('；')}`)
    for (const a of (r.homeAccounts || []).slice(0, 4)) {
      console.log(`    ~ ${a.name.padEnd(12)} ${fmt(a.usedBytes).padStart(9)} [${a.source}] ${a.children?.length || 0} 个子目录`)
    }
    if (r.stderr) console.log(`  stderr: ${r.stderr}`)
    console.log('')
  }

  if (shared.length) {
    console.log('=== 共享存储（已按挂载源去重）===')
    for (const sh of shared) {
      console.log(`  ${sh.source} (${sh.type}) → ${sh.mounts.join(', ')}`)
      console.log(
        `    整设备: ${fmt(sh.usedBytes)}/${fmt(sh.totalBytes)} (${sh.usedPercent}%) 剩 ${fmt(sh.availBytes)}  ← df，含导出方其它数据`,
      )
      console.log(
        `    本共享内容: ${sh.contentBytes == null ? '未扫描' : fmt(sh.contentBytes)}` +
          `${sh.scannedBy ? `  (由 ${sh.scannedBy} 扫)` : ''}  挂在 ${sh.seenOn.length} 台`,
      )
      for (const c of sh.children) console.log(`      · ${c.name.padEnd(22)} ${fmt(c.bytes).padStart(10)}`)
      if (sh.contentLooseBytes > 0) {
        console.log(`      · ${'(该层零散文件)'.padEnd(22)} ${fmt(sh.contentLooseBytes).padStart(10)}`)
      }
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
