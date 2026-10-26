#!/usr/bin/env node
/**
 * 关掉占用端口的残留进程。
 *
 * 为什么需要：concurrently 在 Windows 上收到 Ctrl+C 时，经常只杀掉了它自己那个
 * 包装进程，node server/index.mjs 和 vite 的子进程还活着，下次启动就 EADDRINUSE。
 *
 *   npm run stop              释放 8787 / 5173 / 5174
 *   npm run stop -- --check   只看谁占着，不动进程
 *   npm run stop -- --ports 8787,5173
 */
import { execSync } from 'node:child_process'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const portsArg = args.includes('--ports') ? args[args.indexOf('--ports') + 1] : ''
const PORTS = (portsArg || process.env.DEV_PORTS || '8787,5173,5174')
  .split(',').map((p) => Number(p.trim())).filter(Boolean)

function findPids() {
  let out = ''
  try {
    // 不能用 `-p tcp`：那会排除 TCPv6，而 vite 经常监听在 [::1]:5173，
    // 结果就是杀掉了 API 却漏掉 vite，还会误报"已全部释放"。
    out = execSync('netstat -ano', { encoding: 'utf8', windowsHide: true })
  } catch (err) {
    out = String(err.stdout || '')
  }
  const found = new Map()
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const cols = line.trim().split(/\s+/)
    const local = cols[1] || ''
    const pid = Number(cols[cols.length - 1])
    const port = Number(local.split(':').pop())
    if (!PORTS.includes(port) || !Number.isFinite(pid) || pid <= 4) continue
    if (!found.has(pid)) found.set(pid, [])
    found.get(pid).push(port)
  }
  return found
}

function kill(pid) {
  // 先只杀这一个；失败再试连子进程一起杀。
  // 不打印 taskkill 的原文：中文 Windows 上它是 GBK 编码，读出来是乱码。
  for (const flag of ['/F', '/T /F']) {
    try {
      // stdio: 'ignore' 是必须的 —— execSync 失败时会把子进程 stderr 透传出来，
      // 而 taskkill 在中文 Windows 上用 GBK 输出，直接变成乱码。
      execSync(`taskkill ${flag} /PID ${pid}`, { stdio: 'ignore', windowsHide: true })
      return { pid, ok: true }
    } catch { /* 试下一种 */ }
  }
  return { pid, ok: false }
}

const found = findPids()
if (found.size === 0) {
  console.log(`端口 ${PORTS.join('/')} 都没被占用，无需处理。`)
  process.exit(0)
}

for (const [pid, ports] of found) {
  let name = '?'
  try { name = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { encoding: 'utf8', windowsHide: true }).split('"')[1] || '?' } catch { /* 忽略 */ }
  console.log(`  PID ${pid}  占用 ${ports.join(',')}  ${name}`)
}

if (checkOnly) {
  console.log('\n--check 模式，未结束任何进程。去掉 --check 即可释放端口。')
  process.exit(0)
}

console.log('')
for (const pid of found.keys()) {
  const r = kill(pid)
  console.log(r.ok ? `  已结束 PID ${pid}` : `  PID ${pid} 未能结束（可能已自行退出）`)
}

// 最终结论只看端口是否真的空了 —— 这才是唯一可信的判据
const left = findPids()
console.log('')
if (left.size === 0) {
  console.log('端口已全部释放。')
} else {
  for (const [pid, ports] of left) console.log(`  仍占用：PID ${pid} → ${ports.join(',')}`)
  console.log('\n请手动结束：taskkill /PID <上面的数字> /T /F')
  process.exitCode = 1
}
