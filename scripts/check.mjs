#!/usr/bin/env node
/**
 * 命令行跑账户体检：
 *   node scripts/check.mjs --container teacher-demo
 *   node scripts/check.mjs --server s0            # 只查 s0 上的容器
 *   node scripts/check.mjs --all --slow           # 全集群，含 torch 那条慢检查
 *   node scripts/check.mjs --container x --json   # 机器可读，给别的脚本用
 *
 * 只读：所有命令都不改任何东西，失败项只打印修复命令。
 */
import { loadServers } from '../server/config.mjs'
import { CHECKS, runChecks } from '../server/checks.mjs'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : process.argv[i + 1]
}
const has = (name) => process.argv.includes(`--${name}`)

const ICON = { pass: '✓', warn: '!', fail: '✗', error: '×', skip: '–' }
const COLOR = { pass: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', error: '\x1b[35m', skip: '\x1b[90m' }

function printOne(r) {
  const head = `${r.container}@${r.member || r.server} (${r.status}) 判定 ${ICON[r.verdict] || r.verdict}`
  console.log(`\n${head}`)
  if (r.error) console.log(`  采集失败: ${r.error}`)
  for (const it of r.results || []) {
    const c = COLOR[it.status] || ''
    console.log(`  ${c}${ICON[it.status] || '?'} ${it.title}\x1b[0m  ${it.detail}`)
    if (it.status !== 'pass') {
      console.log(`      命令: ${it.command}`)
      if (it.rc != null) console.log(`      退出码: ${it.rc}`)
      if (it.output) console.log(`      输出: ${it.output.split('\n').slice(0, 3).join(' / ')}`)
      for (const cmdLine of it.commands || []) console.log(`      修法: ${cmdLine}`)
    }
  }
}

async function main() {
  const servers = loadServers()
  const container = arg('container')
  const server = arg('server')
  const scope = container ? 'container' : server ? 'server' : 'all'
  const json = has('json')
  const ids = arg('ids') ? arg('ids').split(',') : undefined

  const t0 = Date.now()
  const res = await runChecks({
    servers,
    container,
    server,
    scope,
    ids,
    includeSlow: has('slow'),
    onProgress: json ? () => {} : ({ done, total }) => {
      if (done % 10 === 0 || done === total) process.stdout.write(`\r体检进度 ${done}/${total}…`)
    },
  })
  if (!json) process.stdout.write('\r')

  if (json) {
    console.log(JSON.stringify({ ...res, durationMs: Date.now() - t0 }, null, 2))
  } else {
    for (const r of res.items) printOne(r)
    const bad = res.items.filter((r) => r.verdict === 'fail' || r.verdict === 'error')
    console.log(
      `\n合计 ${res.items.length} 个容器，判定不通过 ${bad.length} 个，耗时 ${Math.round((Date.now() - t0) / 1000)}s`,
    )
    if (bad.length) console.log(`问题容器: ${bad.map((b) => `${b.container}@${b.member || b.server}`).join(', ')}`)
    for (const e of res.errors || []) console.log(`连不上 ${e.server}: ${e.error}`)
  }
  process.exitCode = res.items.some((r) => r.verdict === 'fail') ? 1 : 0
}

if (has('list')) {
  for (const c of CHECKS) console.log(`${c.id}\t${c.title}${c.optIn ? '（默认不跑）' : ''}`)
} else {
  main().catch((err) => {
    console.error(`失败: ${err.message || err}`)
    process.exitCode = 2
  })
}
