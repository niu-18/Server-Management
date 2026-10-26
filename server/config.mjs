import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(__dirname, '..')

/* ---- minimal .env loader (no dependency) ---- */
function loadDotEnv() {
  const file = path.join(ROOT, '.env')
  if (!fs.existsSync(file)) return
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadDotEnv()

function expandHome(p) {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/* ---- server inventory ----
 * 下面是**占位示例**。真实环境请在项目根放一个 servers.json（已在 .gitignore 里），
 * 格式：
 *   { "servers": [ { "id": "s0", "host": "192.168.1.10", "port": 2222, "user": "s0" } ] }
 * 或者直接改这里的默认值（不建议，容易误提交到 git）。
 */
export const DEFAULT_SERVERS = [
  { id: 's0', host: '10.0.0.10', port: 2222, user: 's0' },
  { id: 's1', host: '10.0.0.10', port: 122, user: 's1' },
  { id: 's2', host: '10.0.0.10', port: 222, user: 's2' },
  { id: 's3', host: '10.0.0.10', port: 322, user: 's3' },
  { id: 's4', host: '10.0.0.10', port: 422, user: 's4' },
  { id: 's5', host: '10.0.0.10', port: 522, user: 's5' },
  { id: 's6', host: '10.0.0.10', port: 622, user: 's6' },
  { id: 's7', host: '10.0.0.10', port: 722, user: 's7' },
  { id: 's8', host: '10.0.0.10', port: 822, user: 's8' },
]

export function loadServers() {
  const file = path.join(ROOT, 'servers.json')
  if (!fs.existsSync(file)) return DEFAULT_SERVERS
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = Array.isArray(raw) ? raw : raw.servers
    if (!Array.isArray(list) || list.length === 0) return DEFAULT_SERVERS
    return list.map((s, i) => ({
      id: s.id || `s${i}`,
      host: s.host,
      port: Number(s.port) || 22,
      user: s.user,
      label: s.label || s.id || `s${i}`,
    }))
  } catch (err) {
    console.warn(`[config] servers.json 解析失败，使用内置清单: ${err.message}`)
    return DEFAULT_SERVERS
  }
}

export const CONFIG = {
  apiKey: process.env.SSH_KEY
    ? path.resolve(expandHome(process.env.SSH_KEY))
    : path.join(os.homedir(), '.ssh', 'srvman_ed25519'),
  sshPassword: process.env.SSH_PASSWORD || '',
  apiPort: Number(process.env.API_PORT) || 8787,
  // 外部访问入口（路由器/NAT 的地址）；不填就用 servers.json 里第一台的 host
  gatewayHost: process.env.GATEWAY_HOST || '',
  connectTimeout: Number(process.env.SSH_CONNECT_TIMEOUT) || 15000,
  // 普通采集只要扫各家 /home，秒级
  execTimeout: Number(process.env.COLLECT_TIMEOUT) || 120000,
  // 负责 NAS 的那台要多走一遍共享目录树
  nasExecTimeout: Number(process.env.NAS_COLLECT_TIMEOUT) || 300000,
  // 共享存储只让这一台去扫（9 台挂的是同一个共享，重复扫没有意义）
  nasScanner: process.env.NAS_SCANNER || 's0',
  // zfs 不可用时，退化成 lxc exec + df（只对运行中的容器有效）
  containerDfFallback: process.env.CONTAINER_DF_FALLBACK !== '0',
  concurrency: Number(process.env.COLLECT_CONCURRENCY) || 9,
  cacheFile: path.join(ROOT, '.cache', 'snapshot.json'),
  // SSH 主机密钥校验（首次连接记录指纹，之后不一致就拒绝；SSH_VERIFY_HOST=0 可关）
  verifyHostKeys: process.env.SSH_VERIFY_HOST !== '0',
  knownHostsFile: path.join(ROOT, '.cache', 'known_hosts.json'),
  // 体检：单个容器一轮 ≈4–6s，全集群一轮两三分钟，所以走异步 job
  checkTimeout: Number(process.env.CHECK_TIMEOUT) || 180000,
  // 端口连通性探测：单个端口等多久
  probeTimeout: Number(process.env.PORT_PROBE_TIMEOUT) || 2500,
  // 容器终端：空闲多久自动断开（容器里的 tmux 不受影响）
  terminalIdleMs: Number(process.env.TERMINAL_IDLE_MS) || 30 * 60 * 1000,
  sessionLog: path.join(ROOT, 'logs', 'sessions.jsonl'),
  // 宿主机 shell 风险大（能直接动 LXD 和别人的机器），默认关
  allowHostTerminal: process.env.ALLOW_HOST_TERMINAL === '1' || process.env.ALLOW_HOST_TERMINAL === 'true',
}
