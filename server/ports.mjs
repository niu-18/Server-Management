/**
 * 端口台账。
 *
 * 手册里最容易出错的一类操作：LXD 的 proxy 设备和路由器的端口转发必须**两处一起改**。
 * 这里的口径分得很清楚：
 *   · LXD proxy 的数据是权威可读的（lxc list 里就有，非 root）。
 *   · 从本机 TCP 探测 10.0.0.10:<port> 只能证明"外面进得去、有人 accept"，
 *     **不能证明 LuCI 里的配置是对的**（转发到别的机器也算通）。UI 上就这么标，不夸大。
 *   · 想对账"应该有哪些端口"，需要你那份期望表 server/expected-ports.json（可选，没有就不比对）。
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { ROOT } from './config.mjs'

// 外部访问入口。默认是个占位地址，启动后由 index.mjs 用 servers.json 的第一台覆盖，
// 也可以在 .env 里用 GATEWAY_HOST 指定。
export let GATEWAY = process.env.GATEWAY_HOST || '10.0.0.10'
export function setGateway(host) {
  if (host) GATEWAY = String(host)
}

/** 成员内部地址：从任一台的 cluster 成员表里拿（url 是 https://192.168.1.x:8443） */
export function memberIpMap(records = []) {
  const map = new Map()
  for (const r of records) {
    for (const m of r.lxd?.clusterMembers || []) {
      const ip = (String(m.url).match(/\/\/([\d.]+):/) || [])[1]
      if (ip && !map.has(m.name)) map.set(m.name, ip)
    }
  }
  return map
}

export function loadExpectedPorts(file = path.join(ROOT, 'expected-ports.json')) {
  if (!fs.existsSync(file)) return []
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = Array.isArray(raw) ? raw : raw.ports
    if (!Array.isArray(list)) return []
    return list
      .map((p) => ({
        port: Number(p.port || p.external) || null,
        container: p.container || p.name || '',
        user: p.user || '',
        note: p.note || p.desc || '',
      }))
      .filter((p) => Number.isFinite(p.port))
  } catch (err) {
    console.warn(`[ports] expected-ports.json 读不了: ${err.message}`)
    return []
  }
}

/**
 * 把快照里所有 proxy 设备摊成一张台账。
 * 外部端口 = listen 的端口（路由器把 GW:同端口 转过来），SSH 是 connect 到容器 22 的那种。
 */
export function buildPortLedger(records = [], opts = {}) {
  const expected = opts.expected ?? loadExpectedPorts()
  const memberIps = opts.memberIps ?? memberIpMap(records)
  const expectedByPort = new Map(expected.map((e) => [e.port, e]))
  const rows = []
  const containersWithoutPort = []

  for (const r of records) {
    for (const c of r.lxd?.containers || []) {
      const ports = c.proxyPorts || []
      if (ports.length === 0) {
        containersWithoutPort.push({ container: c.name, host: c.location || r.id, status: c.status })
        continue
      }
      for (const p of ports) {
        const memberIp = memberIps.get(c.location || r.id) || ''
        const listenMismatch = Boolean(memberIp && String(p.listenHost).startsWith('192.168.') && p.listenHost !== memberIp)
        const exp = expectedByPort.get(p.listenPort) || null
        rows.push({
          container: c.name,
          host: c.location || r.id,
          status: c.status,
          device: p.device,
          bind: p.bind || 'auto',
          listenHost: p.listenHost,
          listenPort: p.listenPort,
          connectHost: p.connectHost,
          connectPort: p.connectPort,
          kind: p.connectPort === 22 ? 'ssh' : 'service',
          external: p.listenPort == null ? '' : `${GATEWAY}:${p.listenPort}`,
          user: exp?.user || (p.connectPort === 22 ? 'ubuntu' : ''),
          note: exp?.note || '',
          sshCmd: p.listenPort == null ? '' : `ssh ubuntu@${GATEWAY} -p ${p.listenPort}`,
          // 手册专门提醒：迁移后 listen 要跟着改成新成员的内部地址
          listenMismatch,
          expected: exp ? { container: exp.container, note: exp.note } : null,
          // 内部 240.x 地址的前两段能看出它挂在哪个成员网段上
          connectSegment: String(p.connectHost).split('.')[1] || '',
        })
      }
    }
  }

  rows.sort((a, b) => (a.listenPort ?? 0) - (b.listenPort ?? 0))

  const byPort = new Map()
  for (const row of rows) {
    if (row.listenPort == null) continue
    if (!byPort.has(row.listenPort)) byPort.set(row.listenPort, [])
    byPort.get(row.listenPort).push(row)
  }
  const conflicts = [...byPort.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([port, list]) => ({ port, containers: list.map((l) => `${l.container}@${l.host}`) }))

  // 期望表里有、LXD 里没有 → 转发打到一个不存在的账户
  const seenPorts = new Set(byPort.keys())
  const expectedOnly = expected.filter((e) => !seenPorts.has(e.port))

  const containerNames = new Set(rows.map((x) => x.container))
  for (const e of expectedOnly) {
    if (e.container && containerNames.has(e.container)) {
      const owned = rows.find((x) => x.container === e.container)
      if (owned) owned.expectedOnlyPort = e.port
    }
  }

  return {
    gateway: GATEWAY,
    rows,
    conflicts,
    containersWithoutPort,
    expectedOnly,
    expectedLoaded: expected.length > 0,
    listenMismatches: rows.filter((x) => x.listenMismatch).map((x) => `${x.container}: listen ${x.listenHost} 应为 ${memberIps.get(x.host)}`),
    summary: {
      total: rows.length,
      ssh: rows.filter((x) => x.kind === 'ssh').length,
      service: rows.filter((x) => x.kind === 'service').length,
      containers: containerNames.size,
      withoutPort: containersWithoutPort.length,
    },
  }
}

/** 单个端口的 TCP 探测。只证明"外面进得去"，不证明配置正确。 */
export function clampProbeOptions({ concurrency, timeout } = {}) {
  const t = Number(timeout)
  const c = Number(concurrency)
  return {
    timeout: Number.isFinite(t) ? Math.min(60000, Math.max(100, Math.round(t))) : 2500,
    concurrency: Number.isFinite(c) ? Math.min(32, Math.max(1, Math.round(c))) : 8,
  }
}

export function probePort(port, { host = GATEWAY, timeout = 2500 } = {}) {
  return new Promise((resolve) => {
    // socket.setTimeout 接受负数会直接抛 ERR_OUT_OF_RANGE，外部传进来的值必须夹紧
    const safeTimeout = Math.min(60000, Math.max(100, Number(timeout) || 2500))
    const startedAt = Date.now()
    const socket = net.connect({ host, port })
    let settled = false
    const done = (state, error) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ port, state, ms: Date.now() - startedAt, error: error || '' })
    }
    socket.setTimeout(safeTimeout)
    socket.once('connect', () => done('open'))
    socket.once('timeout', () => done('timeout'))
    socket.once('error', (err) => done(err.code === 'ECONNREFUSED' ? 'refused' : 'unreachable', err.code || err.message))
  })
}

/** 并发受控地探测，别一瞬间把路由器打成扫描现场 */
export async function probePorts(rows, opts = {}) {
  const { concurrency, timeout } = clampProbeOptions(opts)
  const ports = [...new Set(rows.map((r) => r.listenPort).filter((p) => Number.isFinite(p)))]
  const out = new Map()
  let at = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, ports.length)) }, async () => {
    while (at < ports.length) {
      const p = ports[at++]
      out.set(p, await probePort(p, { timeout }))
    }
  })
  await Promise.all(workers)
  return out
}

/** 把探测结果并回台账，给出人能直接用的结论 */
export function classifyLedger(ledger, probes = new Map()) {
  const rows = ledger.rows.map((row) => {
    const probe = probes.get(row.listenPort) || null
    let state = 'unprobed'
    let advice = ''
    if (probe) {
      if (probe.state === 'open') {
        state = 'open'
        advice = row.status === 'Running' ? '外部可达，容器在跑' : '外部可达，但容器状态是 ' + row.status
      } else if (probe.state === 'refused') {
        state = 'refused'
        advice = '端口有人应答但立刻拒绝 —— 转发通了，容器里 sshd 没起（体检有一项专查这个）'
      } else {
        state = 'closed'
        advice = row.listenMismatch
          ? `不通，而且 listen 是 ${row.listenHost}、本机内部地址是 ${row.host}：迁移后没改 listen 的可能性最大`
          : '不通：可能是路由器没做转发，或者该成员上没人监听这个端口'
      }
    }
    return { ...row, probe, state, advice }
  })

  const counts = rows.reduce((acc, r) => { acc[r.state] = (acc[r.state] || 0) + 1; return acc }, {})
  return { ...ledger, rows, counts }
}

/**
 * 外部不通时，去所在成员上确认 LXD 到底有没有在听这个端口。
 * 这一步才是"两处不同步"的定论依据：
 *   LXD 在听 + 外部不通 = 路由器缺转发（去 LuCI 网络-防火墙-端口转发）
 *   LXD 没在听        = proxy 设备没生效（listen 地址不对 / 容器或成员重启后没起来）
 */
export function buildListenCheckScript(ports) {
  const clean = ports.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
  if (clean.length === 0) return 'true'
  const lines = [
    'export LC_ALL=C',
    'ADDRS=$(ss -ltnH 2>/dev/null | awk \'{print $4}\' | tr "\n" " ")',
    'for p in ' + clean.join(' ') + '; do',
    '  found=0',
    '  for a in $ADDRS; do',
    '    case "$a" in *:"$p") found=1 ;; esac',
    '  done',
    '  if [ "$found" = "1" ]; then echo "LISTEN $p"; else echo "DOWN $p"; fi',
    'done',
  ]
  return lines.join('\n')
}

export function parseListenCheck(lines = []) {
  const out = new Map()
  for (const line of lines) {
    const m = line.match(/^(LISTEN|DOWN)\s+(\d+)$/)
    if (m) out.set(Number(m[2]), m[1] === 'LISTEN')
  }
  return out
}

/**
 * 对所有"外部不通"的行做本机确认。按成员分组，每台一条连接。
 * 返回 { port → { listening, checked, error } }
 */
export async function diagnosePorts(rows, records, { concurrency = 4 } = {}) {
  const { exec, withConnection } = await import('./ssh.mjs')
  const bad = rows.filter((r) => r.state !== 'open' && r.state !== 'unprobed' && r.listenPort)
  const byHost = new Map()
  for (const r of bad) {
    if (!byHost.has(r.host)) byHost.set(r.host, new Set())
    byHost.get(r.host).add(r.listenPort)
  }
  const hostRecord = new Map(records.map((x) => [x.id, x]))
  const out = new Map()
  let at = [...byHost.entries()]
  const workers = Array.from({ length: Math.min(concurrency, at.length) }, async () => {
    while (at.length) {
      const [host, portSet] = at.shift()
      const rec = hostRecord.get(host)
      const ports = [...portSet]
      const key = (p) => `${host}|${p}`
      if (!rec) {
        for (const p of ports) out.set(key(p), { listening: null, checked: false, error: `不知道 ${host} 怎么连` })
        continue
      }
      try {
        const { stdout } = await withConnection(rec, (conn) => exec(conn, buildListenCheckScript(ports), 30000))
        const found = parseListenCheck(stdout.split(/\r?\n/))
        for (const p of ports) out.set(key(p), { listening: found.get(p) ?? null, checked: found.has(p), error: found.has(p) ? '' : '这台没返回监听表' })
      } catch (err) {
        for (const p of ports) out.set(key(p), { listening: null, checked: false, error: err.message || String(err) })
      }
    }
  })
  await Promise.all(workers)
  return out
}

/** 把"外部探测 + 本机确认"合成最终结论 */
export function conclude(rows, diagnosis = new Map()) {
  return rows.map((row) => {
    if (row.state === 'open') return { ...row, verdict: 'ok' }
    if (row.state === 'unprobed') return { ...row, verdict: 'unknown' }
    // 键必须是 host|port：同一个外部端口可能出现在两个成员上（冲突场景），只按端口会串
    const d = diagnosis.get(`${row.host}|${row.listenPort}`)
    if (!d || d.listening == null) return { ...row, verdict: 'unknown', advice: `${row.advice}${d?.error ? `（本机确认失败：${d.error}）` : ''}` }
    const memberIp = row.listenHost
    if (d.listening) {
      return {
        ...row,
        localListening: true,
        verdict: 'no_forward',
        advice: `LXD 在 ${memberIp}:${row.listenPort} 确实在听，容器里也通，但 ${GATEWAY}:${row.listenPort} 从外面进不来 —— 差的是路由器那条转发（LuCI：网络-防火墙-端口转发）`,
        commands: [
          `# 路由器上加转发：${GATEWAY}:${row.listenPort} → ${memberIp}:${row.listenPort}`,
          `# 管理页 http://${GATEWAY}/cgi-bin/luci/  网络 → 防火墙 → 端口转发`,
          `# 顺手核对 LXD 这条：lxc config show ${row.container} | grep -A4 proxy`,
        ],
      }
    }
    return {
      ...row,
      localListening: false,
      verdict: 'no_listener',
      advice: `${memberIp}:${row.listenPort} 上根本没有进程在听 —— proxy 设备没生效（listen 地址写错、或者容器/成员重启后没起来）`,
      commands: [
        row.listenMismatch ? `# listen 应为该成员内部地址：lxc config edit ${row.container}` : `# 核对 proxy 设备：lxc config show ${row.container} --expanded`,
        `lxc list ${row.container}  # 看状态`,
        `# 必要时重启容器让 proxy 重新绑定：lxc restart ${row.container}`,
      ],
    }
  })
}

/* ------------------------------------------------------------------ *
 * 转发目标 IP vs 容器实际 IP
 *
 * 手册里的排查法：
 *   lxc config device show <容器>     看 proxy0 的 connect
 *   lxc exec <容器> -- hostname -I    看容器真实 IP
 * 两者不一致时，外部 SSH 会连到一个已经不存在的地址（迁移、重建、fan 网络重新分配都会导致）。
 * `hostname -I` 会带出 Docker 的 172.17.0.1，所以要按"成员集合里有没有这个地址"判断，不能整串比。
 * ------------------------------------------------------------------ */

const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g

export function extractIpv4(text) {
  const found = String(text || '').match(IPV4_RE) || []
  return [...new Set(found.filter((ip) => !ip.startsWith('127.') && !ip.startsWith('172.17.') && !ip.startsWith('0.')))]
}

/** 成员内部 IP 的末段就是它的 fan 网段：192.168.1.10 → 240.10.x.x */
export function expectedSegment(memberIp) {
  const m = String(memberIp || '').match(/\.(\d+)$/)
  return m ? Number(m[1]) : null
}

export function buildIpCheckScript(names) {
  const safe = (names || []).filter((n) => /^[A-Za-z0-9._-]+$/.test(n))
  if (safe.length === 0) return 'true'
  return [
    'export LC_ALL=C',
    'for n in ' + safe.join(' ') + '; do',
    // 注意：不要把 head 放进命令替换里，管道会吞掉 lxc exec 的退出码
    '  out=$(lxc exec "$n" -- sh -c \'hostname -I 2>/dev/null || ip -4 -o addr show scope global 2>/dev/null\' </dev/null 2>&1)',
    '  rc=$?',
    '  out=$(printf \'%s\' "$out" | head -1)',
    '  printf \'@@IP %s\\t%s\\t%s\\n\' "$n" "$rc" "$out"',
    'done',
  ].join('\n')
}

export function parseIpCheck(lines = []) {
  const out = new Map()
  for (const line of lines) {
    if (!line.startsWith('@@IP ')) continue
    const [name, rc, ...rest] = line.slice(5).split('\t')
    if (!name) continue
    out.set(name, { rc: Number(rc) || 0, raw: rest.join('\t').trim() })
  }
  return out
}

/**
 * 逐行判定：
 *   match     —— connect 的目标在容器实际 IP 里
 *   mismatch  —— 容器有 IP，但不包含 connect 的目标（迁移/重建后最常见的坑）
 *   segment   —— 没跑成 exec 时也能判：connect 的网段和所在成员对不上（240.<成员末段>.x）
 *   unknown   —— 容器没跑 / 读不到 IP
 */
export function evaluateIpChecks(ledger, ipMap = new Map(), memberIps = new Map()) {
  const rows = ledger.rows.map((row) => {
    const probe = ipMap.get(row.container)
    const actualIps = probe ? extractIpv4(probe.raw) : []
    const target = String(row.connectHost || '')
    const connectSegment = String(target).split('.')[1] || ''
    const expected = expectedSegment(memberIps.get(row.host))
    const segmentMismatch = Boolean(expected != null && connectSegment && Number(connectSegment) !== expected)
    const hasTarget = actualIps.includes(target)
    const primaryIp = actualIps.find((ip) => ip.startsWith('240.')) || actualIps[0] || ''

    let verdict = 'unknown'
    if (hasTarget) verdict = 'match'
    else if (actualIps.length > 0) verdict = 'mismatch'
    else if (probe && probe.rc === 0) verdict = 'no_ip' // 跑成功了但容器里没有全局 IPv4
    else if (segmentMismatch) verdict = 'segment'

    return {
      ...row,
      actualIps,
      primaryIp,
      ipVerdict: verdict,
      probeRc: probe ? probe.rc : null,
      segmentMismatch,
      ipDetail:
        verdict === 'match' ? `实际 IP ${actualIps.join(' / ')} 包含转发目标`
          : verdict === 'mismatch' ? `转发目标 ${target} 不在容器实际 IP（${actualIps.join(' / ')}）里 —— 外部 SSH 会连到一个不存在的地址`
            : verdict === 'no_ip' ? '容器里没有全局 IPv4（可能只有 lo）—— eth0 没起来或被摘掉，proxy 无从转发'
              : verdict === 'segment' ? `connect 在 240.${connectSegment}.x，但它在 ${row.host}（应为 240.${expected}.x）—— 像是迁移后没改`
                : probe ? `读不到 IP（容器可能没在跑）：${probe.raw.slice(0, 120)}` : '没核对过',
    }
  })

  // 交叉判据：目标地址其实是另一个容器
  const ipOwner = new Map()
  for (const r of rows) for (const ip of r.actualIps) if (!ipOwner.has(ip)) ipOwner.set(ip, r.container)
  const ownerOf = (r) => ipOwner.get(r.connectHost)
  for (const r of rows) {
    if (r.ipVerdict !== 'mismatch') continue
    const owner = ownerOf(r)
    if (!owner || owner === r.container) continue
    // 对方是不是也指着这边？两边互指才是"互换"，单边指着别人是"串到别人"
    const other = rows.find((x) => x.container === owner)
    // 互指：对方 connect 指向我的实际地址，我 connect 指向对方的实际地址。
    // 不能用 ipVerdict 判（它在循环里会被改掉），直接比地址。
    const mutual = Boolean(other && other.connectHost === r.primaryIp && other.primaryIp === r.connectHost)
    r.ipVerdict = mutual ? 'swap' : 'other'
    r.ipSwapWith = owner
    r.ipDetail = mutual
      ? `转发目标 ${r.connectHost} 是 ${owner} 的实际地址，而 ${owner} 的转发又指回 ${r.primaryIp} —— 两个容器的地址互换了，从 ${r.listenPort} 登进去会落到 ${owner}`
      : `转发目标 ${r.connectHost} 其实是 ${owner} 的实际地址 —— 从 ${r.listenPort} 登进去会落到 ${owner} 的容器里`
  }

  // 多个账户的转发打到同一个容器
  const byTarget = new Map()
  for (const r of rows) {
    if (!r.connectHost) continue
    const key = `${r.connectHost}:${r.connectPort}`
    if (!byTarget.has(key)) byTarget.set(key, new Set())
    byTarget.get(key).add(r.container)
  }
  for (const r of rows) {
    const key = `${r.connectHost}:${r.connectPort}`
    const owners = byTarget.get(key)
    if (owners && owners.size > 1 && r.ipVerdict !== 'match') {
      r.targetSharedWith = [...owners].filter((x) => x !== r.container)
    }
  }

  for (const r of rows) {
    const fixes = []
    if (['mismatch', 'swap', 'other', 'segment'].includes(r.ipVerdict)) {
      const fixTarget = r.primaryIp || (expectedSegment(memberIps.get(r.host)) != null ? `240.${expectedSegment(memberIps.get(r.host))}.0.<容器实际IP>` : '<容器实际IP>')
      fixes.push(
        `# ${r.container} 实际是 ${r.actualIps.join(' / ') || '（读不到）'}，proxy 指到 ${r.connectHost}`,
        `lxc config device show ${r.container}   # 确认 proxy 的 connect/listen`,
        `lxc config device set ${r.container} ${r.device} connect tcp:${fixTarget}:${r.connectPort}`,
        `# 改完从外部验证：ssh ubuntu@${GATEWAY} -p ${r.listenPort}`,
      )
      if (r.ipVerdict === 'swap' && r.ipSwapWith) {
        fixes.push(`# 注意：${r.ipSwapWith} 的转发也指着这边的旧地址，两边都要改（它现在拿的是 ${r.connectHost}）`)
      } else if (r.ipSwapWith) {
        fixes.push(`# 注意：${r.connectHost} 是 ${r.ipSwapWith} 的地址，改之前先和对方确认，别把别人的登录改坏`)
      }
      if (r.segmentMismatch) {
        fixes.push(
          `# 它在 ${r.host}，fan 网段应是 240.${expectedSegment(memberIps.get(r.host))}.x，listen 也应为该成员内部地址`,
          `lxc exec ${r.container} -- hostname -I`,
        )
      }
    } else if (r.ipVerdict === 'no_ip') {
      fixes.push(
        `lxc config show ${r.container} --expanded | grep -A3 eth0`,
        `lxc exec ${r.container} -- ip -4 -o addr show`,
        `# 网卡没了通常要重启容器：lxc restart ${r.container}`,
      )
    }
    r.ipFix = fixes
  }

  const counts = rows.reduce((acc, r) => { acc[r.ipVerdict] = (acc[r.ipVerdict] || 0) + 1; return acc }, {})
  return {
    rows,
    counts,
    ranAt: new Date().toISOString(),
    mismatches: rows.filter((r) => ['mismatch', 'swap', 'other', 'segment', 'no_ip'].includes(r.ipVerdict)),
  }
}

/**
 * 用当前台账校正"上次核对"的结论。
 *
 * 为什么需要：IP 核对结果会缓存，但 proxy 的 connect 和容器 IP 都可能在这之后变
 * （有人按提示改了配置、容器重建拿了新地址、账号被删）。直接拿旧结论配新台账，
 * 就会出现"转发目标和实际 IP 明明一样却报错"的自相矛盾。
 *
 * 规则：
 *   端口/容器已经不存在        → 丢掉这条结论
 *   当前 connect 变了、且等于上次记下的实际 IP → 判定为一致（标注是核对后改的）
 *   当前 connect 变了、但仍对不上        → 标成 stale，要求重新核对，不再算作错误
 *   connect 没变                        → 沿用上次结论
 */
export function reconcileIpCheck(cached, ledgerRows = []) {
  if (!cached || !Array.isArray(cached.rows)) return cached || { rows: [], counts: {}, mismatches: [] }
  const current = new Map(ledgerRows.map((r) => [`${r.container}|${r.listenPort}`, r]))
  const rows = []
  let dropped = 0
  let fixed = 0
  for (const c of cached.rows) {
    const now = current.get(`${c.container}|${c.listenPort}`)
    if (!now) { dropped += 1; continue } // 容器这一行已经没了（账号删了/端口摘了）
    let verdict = c.ipVerdict
    let detail = c.ipDetail
    let reconcile = ''
    if (now.connectHost !== c.connectHost) {
      if ((c.actualIps || []).includes(now.connectHost)) {
        verdict = 'match'
        reconcile = 'fixed'
        fixed += 1
        detail = `按上次核对：容器实际 IP ${(c.actualIps || []).join(' / ')}，现在的转发目标已经和它一致（核对之后改过配置）`
      } else {
        verdict = 'stale'
        reconcile = 'stale'
        detail = `配置在核对之后改过：上次 connect 是 ${c.connectHost}，现在是 ${now.connectHost} —— 需要重新核对`
      }
    }
    rows.push({ ...c, connectHost: now.connectHost, listenHost: now.listenHost, ipVerdict: verdict, ipDetail: detail, reconcile })
  }
  const counts = rows.reduce((acc, r) => { acc[r.ipVerdict] = (acc[r.ipVerdict] || 0) + 1; return acc }, {})
  return {
    ...cached,
    rows,
    counts,
    dropped,
    fixed,
    mismatches: rows.filter((r) => ['mismatch', 'swap', 'other', 'segment', 'no_ip'].includes(r.ipVerdict)),
  }
}

/** 按成员分组跑一次 IP 核对（每个成员一条连接，成员内串行） */
export async function runIpChecks(records, ledger, memberIps, { concurrency = 4 } = {}) {
  const { exec, withConnection } = await import('./ssh.mjs')
  const byHost = new Map()
  for (const row of ledger.rows) {
    if (!byHost.has(row.host)) byHost.set(row.host, new Set())
    byHost.get(row.host).add(row.container)
  }
  const hostRecord = new Map(records.map((x) => [x.id, x]))
  const ipMap = new Map()
  const errors = []
  const queue = [...byHost.entries()]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const [host, set] = queue.shift()
      const rec = hostRecord.get(host)
      if (!rec) { errors.push({ host, error: '不知道该成员的连接方式' }); continue }
      try {
        const { stdout } = await withConnection(rec, (conn) => exec(conn, buildIpCheckScript([...set]), 120000))
        for (const [name, v] of parseIpCheck(stdout.split(/\r?\n/))) ipMap.set(name, v)
      } catch (err) {
        errors.push({ host, error: err.message || String(err) })
      }
    }
  })
  await Promise.all(workers)
  const result = evaluateIpChecks(ledger, ipMap, memberIps)
  return { ...result, errors }
}

