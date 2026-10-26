#!/usr/bin/env node
/**
 * 数据正确性审计。
 *
 * 存在的理由：采集器按 location 过滤实例、再在同一台上 join local/containers/<name>。
 * 这个设计会漏掉一类真实占用 —— 容器迁移后留在旧机器上的数据集。它不在任何人的
 * 账上，只会混进每台的“未归属”残差里，界面上看不出来。
 *
 * 审计做七件事：
 *   1. 孤儿数据集   机器上有数据集，但没有实例落在这台（迁移残留 / 已删未清）
 *   2. 缺失数据集   实例落在这台，却没有对应数据集
 *   3. 同名跨机重复 同一个容器名在多台机器上都有数据集
 *   4. 对账         池已用 vs 容器数据集之和 vs 界面归因之和，残差要能解释
 *   5. 口径核对     界面值 vs 现场直读 zfs，抓 join 错位
 *   6. 版本漂移     同集群里宿主驱动 / LXD 版本不是多数的那种
 *   7. 端口台账     外部端口撞车、proxy 的 listen 地址不是所在成员的内部地址
 *
 *   npm run audit
 *   npm run audit -- --json      机器可读输出
 */
import fs from 'node:fs'
import { Client } from 'ssh2'
import { buildPortLedger } from '../server/ports.mjs'
import { CONFIG, loadServers } from '../server/config.mjs'
import { collectAll } from '../server/collect.mjs'

const asJson = process.argv.includes('--json')
const GiB = (n) => (n == null ? '—' : (n / 1024 ** 3).toFixed(1) + ' GiB')

const GROUND_SCRIPT = String.raw`
ZBIN=""
for c in /sbin/zfs /usr/sbin/zfs /usr/local/sbin/srvman-zfs; do
  [ -x "$c" ] && { ZBIN="$c"; break; }
done
zcmd() {
  [ -n "$ZBIN" ] || return 1
  if "$ZBIN" "$@" >/dev/null 2>&1; then "$ZBIN" "$@" 2>/dev/null
  elif sudo -n "$ZBIN" "$@" >/dev/null 2>&1; then sudo -n "$ZBIN" "$@" 2>/dev/null
  else return 1; fi
}
echo "@@ZBIN=$ZBIN"
echo "@@POOL"
zcmd list -H -p -o name,used,available 2>&1 | head -1
echo "@@ZPOOL"
if [ -n "$ZBIN" ]; then
  ZP="$(dirname "$ZBIN")/zpool"
  [ -x "$ZP" ] || ZP=/sbin/zpool
  if "$ZP" list -H -p -o name,size,alloc,free,cap >/dev/null 2>&1; then "$ZP" list -H -p -o name,size,alloc,free,cap 2>/dev/null
  else sudo -n "$ZP" list -H -p -o name,size,alloc,free,cap 2>/dev/null; fi
fi
echo "@@LXDRES"
for p in $(lxc query /1.0/storage-pools 2>/dev/null | tr ',' '\n' | sed -n 's#.*/1.0/storage-pools/##p' | tr -d '[\"] '); do
  for t in "$(hostname)" ""; do
    if [ -n "$t" ]; then O=$(lxc query "/1.0/storage-pools/$p/resources?target=$t" 2>/dev/null)
    else O=$(lxc query "/1.0/storage-pools/$p/resources" 2>/dev/null); fi
    [ -n "$O" ] && { printf '%s %s\t' "$p" "$t"; printf '%s' "$O" | tr -d '\n\t '; echo ""; break; }
  done
done
echo "@@DS"
zcmd list -H -p -o name,used,refer,quota,creation 2>/dev/null | grep "/containers/"
echo "@@BIG"
zcmd list -H -p -o name,used 2>/dev/null | sort -k2 -rn | head -8
echo "@@INST"
lxc list --format=json 2>/dev/null | tr -d '\n'
echo ""
echo "@@END"
`

function connect(server) {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    const key = CONFIG.apiKey && fs.existsSync(CONFIG.apiKey) ? fs.readFileSync(CONFIG.apiKey) : null
    conn.once('ready', () => resolve(conn))
    conn.once('error', reject)
    conn.connect({
      host: server.host,
      port: server.port,
      username: server.user,
      privateKey: key || undefined,
      readyTimeout: CONFIG.connectTimeout,
    })
  })
}

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      let e = ''
      stream.on('data', (d) => (out += d))
      stream.stderr.on('data', (d) => (e += d))
      stream.on('close', () => resolve({ out, e }))
    })
  })
}

function section(raw, name) {
  const marker = `@@${name}`
  const start = raw.indexOf(marker)
  if (start === -1) return []
  const rest = raw.slice(start + marker.length)
  const next = rest.search(/\n@@/)
  const body = next === -1 ? rest : rest.slice(0, next)
  return body.split('\n').map((l) => l.trim()).filter(Boolean)
}

function parseDs(lines) {
  const out = new Map()
  for (const line of lines) {
    const f = line.split('\t')
    if (f.length < 4) continue
    const name = f[0]
    const short = name.split('/').pop()
    const used = Number(f[1])
    const quota = Number(f[3])
    out.set(short, {
      dataset: name,
      usedBytes: Number.isFinite(used) ? used : null,
      referBytes: Number(f[2]) ? Number(f[2]) : null,
      quotaBytes: Number.isFinite(quota) && quota > 0 ? quota : null,
      created: Number(f[4]) ? new Date(Number(f[4]) * 1000).toISOString().slice(0, 10) : '',
    })
  }
  return out
}

function parseInstances(rawLines) {
  try {
    const arr = JSON.parse(rawLines.join(''))
    return arr.map((i) => ({ name: i.name, location: i.location || '', status: i.status || '' }))
  } catch {
    return []
  }
}

async function main() {
  const servers = loadServers()
  const [ui, ground] = await Promise.all([
    collectAll(servers),
    (async () => {
      const out = new Map()
      for (const s of servers) {
        try {
          const conn = await connect(s)
          const { out: raw, e } = await exec(conn, GROUND_SCRIPT)
          conn.end()
          out.set(s.id, { raw, err: e })
        } catch (err) {
          out.set(s.id, { raw: '', err: err.message })
        }
      }
      return out
    })(),
  ])

  const findings = []
  const perHost = new Map()

  for (const s of servers) {
    const g = ground.get(s.id)
    const raw = g?.raw || ''
    const datasets = parseDs(section(raw, 'DS'))
    const instances = parseInstances(section(raw, 'INST'))
    const mine = instances.filter((i) => !i.location || i.location === s.id)
    const mineNames = new Set(mine.map((i) => i.name))
    const poolLine = section(raw, 'POOL')[0]?.split('\t') || []

    // 探测失败时绝不能把数据集一律当成无主 —— 那正是假阳性的来源。
    const instancesReadable = instances.length > 0
    const datasetsReadable = datasets.size > 0

    perHost.set(s.id, {
      datasets,
      instances: mine,
      totalInstancesHere: mine.length,
      totalDatasetsHere: datasets.size,
      clusterInstances: instances.length,
      poolUsedBytes: Number(poolLine[1]) || null,
      poolAvailBytes: Number(poolLine[2]) || null,
      zbin: (raw.match(/@@ZBIN=(.*)/) || [])[1]?.trim() || '',
      skipReason: !instancesReadable
        ? 'lxc 实例清单读取失败'
        : !datasetsReadable
          ? 'zfs 数据集读取失败'
          : '',
    })

    if (!instancesReadable || !datasetsReadable) continue

    for (const [name, ds] of datasets) {
      if (!mineNames.has(name)) {
        findings.push({ kind: 'ORPHAN_DATASET', host: s.id, name, usedBytes: ds.usedBytes, quotaBytes: ds.quotaBytes, created: ds.created })
      }
    }
    for (const i of mine) {
      if (!datasets.has(i.name)) {
        findings.push({ kind: 'MISSING_DATASET', host: s.id, name: i.name, status: i.status })
      }
    }
  }

  // 同名数据集出现在多台机器上
  const nameToHosts = new Map()
  for (const [host, h] of perHost) {
    for (const [name, ds] of h.datasets) {
      if (!nameToHosts.has(name)) nameToHosts.set(name, [])
      nameToHosts.get(name).push({ host, ...ds })
    }
  }
  for (const [name, list] of nameToHosts) {
    if (list.length > 1) {
      findings.push({ kind: 'DUPLICATE_ACROSS_HOSTS', name, copies: list.map((l) => `${l.host}:${GiB(l.usedBytes)}`).join(' ') })
    }
  }

  // 界面归因 vs 现场直读
  for (const uiRec of ui) {
    const h = perHost.get(uiRec.id)
    if (!h || h.skipReason) continue
    for (const c of uiRec.accounts) {
      const ds = h.datasets.get(c.name)
      if (!ds && c.usedBytes != null) {
        findings.push({ kind: 'UI_HAS_NO_GROUND_DATASET', host: uiRec.id, name: c.name, uiBytes: c.usedBytes })
      } else if (ds && c.usedBytes != null && Math.abs(ds.usedBytes - c.usedBytes) > 0.02 * Math.max(ds.usedBytes, 1)) {
        findings.push({ kind: 'UI_VALUE_MISMATCH', host: uiRec.id, name: c.name, uiBytes: c.usedBytes, groundBytes: ds.usedBytes })
      } else if (ds && c.usedBytes == null) {
        findings.push({ kind: 'UI_MISSING_VALUE', host: uiRec.id, name: c.name, groundBytes: ds.usedBytes })
      }
    }
  }

  // 同一台的池容量，LXD API 与 zpool 两个来源是否一致
  for (const s of servers) {
    const g = ground.get(s.id)
    const raw = g?.raw || ''
    const zp = (section(raw, 'ZPOOL')[0] || '').split('\t')
    const zpoolRec = zp.length >= 4 ? { sizeBytes: Number(zp[1]), allocBytes: Number(zp[2]) } : null
    const lxdLine = (section(raw, 'LXDRES')[0] || '').split('\t')
    let lxdRec = null
    if (lxdLine[1]) {
      try {
        const j = JSON.parse(lxdLine.slice(1).join('\t'))
        lxdRec = { totalBytes: j?.space?.total, usedBytes: j?.space?.used }
      } catch { /* 解析不了就不比 */ }
    }
    if (!zpoolRec || !lxdRec) continue
    const usedGap = Math.abs((lxdRec.usedBytes || 0) - (zpoolRec.allocBytes || 0))
    if (usedGap > 0.02 * (zpoolRec.allocBytes || 1)) {
      findings.push({ kind: 'POOL_USED_DISAGREES', host: s.id, uiBytes: lxdRec.usedBytes, groundBytes: zpoolRec.allocBytes })
    }
    const totalGap = Math.abs((lxdRec.totalBytes || 0) - (zpoolRec.sizeBytes || 0))
    if (totalGap > 0.02 * (zpoolRec.sizeBytes || 1)) {
      findings.push({ kind: 'POOL_TOTAL_DEFINITION', host: s.id, lxdTotal: lxdRec.totalBytes, zpoolSize: zpoolRec.sizeBytes })
    }
  }

  /* ---------------- 基础设施一致性（直接用这次采集的结果，不再多连一次机器） ---------------- */

  const memberIp = new Map()
  const clusters = new Map()
  for (const r of ui) {
    if (r.status !== 'ok' || !r.lxd) continue
    for (const m of r.lxd.clusterMembers || []) {
      const ip = (String(m.url).match(/\/\/([\d.]+):/) || [])[1]
      if (ip) memberIp.set(m.name, ip)
    }
    const key = r.lxd.clusterKey || `solo:${r.id}`
    if (!clusters.has(key)) clusters.set(key, [])
    clusters.get(key).push(r)
  }

  for (const [key, hosts] of clusters) {
    if (hosts.length < 2) continue
    const drivers = new Map()
    const versions = new Map()
    for (const h of hosts) {
      if (h.gpu?.driverVersion) drivers.set(h.gpu.driverVersion, (drivers.get(h.gpu.driverVersion) || []).concat(h.id))
      if (h.lxd.lxcVersion) versions.set(h.lxd.lxcVersion, (versions.get(h.lxd.lxcVersion) || []).concat(h.id))
    }
    if (drivers.size > 1) {
      const sorted = [...drivers.entries()].sort((a, b) => b[1].length - a[1].length)
      const [major, majorHosts] = sorted[0]
      for (const [drv, list] of sorted.slice(1)) {
        findings.push({ kind: 'DRIVER_DRIFT', host: list.join(','), note: `集群 ${key} 多数是 ${major}（${majorHosts.join('、')}），这几台是 ${drv}` })
      }
    }
    if (versions.size > 1) {
      for (const [v, list] of versions) findings.push({ kind: 'LXD_VERSION_DRIFT', host: list.join(','), note: `集群 ${key} 里 LXD 版本 ${v}` })
    }
  }

  // 端口台账：与 UI 用同一套逻辑（server/ports.mjs），别再各写一份
  const ledger = buildPortLedger(ui, { memberIps: memberIp })
  for (const c of ledger.conflicts) {
    findings.push({ kind: 'PORT_CONFLICT', host: `:${c.port}`, note: c.containers.join(' ') })
  }
  for (const m of ledger.listenMismatches) {
    findings.push({ kind: 'PROXY_LISTEN_MISMATCH', host: m.split(' ')[0] || '', note: m })
  }

  const report = { perHost, findings, ui }
  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log('=== 每台对账（池已用 vs 容器数据集 vs 界面归因）===\n')
  console.log('主机  实例/数据集  池已用        数据集之和    界面归因      残差')
  let ghostTotal = 0
  for (const uiRec of ui) {
    const h = perHost.get(uiRec.id)
    if (h.skipReason) {
      console.log(`${uiRec.id.padEnd(4)} ${'—'.padEnd(12)}  跳过审计：${h.skipReason}（zfs=${h.zbin || '未发现'}）`)
      continue
    }
    const dsSum = [...h.datasets.values()].reduce((a, d) => a + (d.usedBytes || 0), 0)
    const uiSum = uiRec.accounts.reduce((a, c) => a + (c.usedBytes || 0), 0)
    const poolUsed = h.poolUsedBytes ?? uiRec.capacity?.usedBytes
    const residual = (poolUsed ?? 0) - dsSum
    const ghosts = [...h.datasets.entries()].filter(([n]) => !h.instances.some((i) => i.name === n))
    ghostTotal += ghosts.reduce((a, [, d]) => a + (d.usedBytes || 0), 0)
    console.log(
      `${uiRec.id.padEnd(4)} ${(h.totalInstancesHere + '/' + h.totalDatasetsHere).padEnd(12)} ` +
        `${GiB(poolUsed).padStart(11)} ${GiB(dsSum).padStart(12)} ${GiB(uiSum).padStart(12)} ${GiB(residual).padStart(11)}` +
        (ghosts.length ? `   ← ${ghosts.length} 个无主数据集` : ''),
    )
  }
  console.log(`\n无主数据集合计（真实占盘但不在任何账户账上）: ${GiB(ghostTotal)}`)

  const byKind = new Map()
  for (const f of findings) byKind.set(f.kind, (byKind.get(f.kind) || 0) + 1)
  console.log('\n=== 发现 ===\n')
  if (findings.length === 0) {
    console.log('没有发现不一致。')
  } else {
    for (const [k, n] of byKind) console.log(`  ${k.padEnd(24)} ${n}`)
    console.log('')
    for (const f of findings) {
      if (f.kind === 'ORPHAN_DATASET') {
        console.log(`  [无主数据集] ${f.host}/${f.name}  占 ${GiB(f.usedBytes)}  配额 ${GiB(f.quotaBytes)}  建于 ${f.created}`)
      } else if (f.kind === 'DUPLICATE_ACROSS_HOSTS') {
        console.log(`  [同名跨机] ${f.name}  →  ${f.copies}`)
      } else if (f.kind === 'MISSING_DATASET') {
        console.log(`  [缺数据集] ${f.host}/${f.name}  状态 ${f.status}`)
      } else if (f.kind === 'POOL_USED_DISAGREES') {
        console.log(`  [池已用不一致] ${f.host}  LXD ${GiB(f.uiBytes)} vs zpool ${GiB(f.groundBytes)}`)
      } else if (f.kind === 'POOL_TOTAL_DEFINITION') {
        console.log(`  [池容量口径] ${f.host}  LXD total ${GiB(f.lxdTotal)} vs zpool size ${GiB(f.zpoolSize)}（差 ${GiB(Math.abs(f.zpoolSize - f.lxdTotal))}，ZFS 元数据/预留）`)
      } else if (f.note) {
        const label = {
          DRIVER_DRIFT: '驱动不一致',
          LXD_VERSION_DRIFT: 'LXD 版本不一致',
          PORT_CONFLICT: '外部端口撞车',
          PROXY_LISTEN_MISMATCH: 'proxy 监听地址不符',
        }[f.kind] || f.kind
        console.log(`  [${label}] ${f.host}  ${f.note}`)
      } else {
        console.log(`  [${f.kind}] ${f.host}/${f.name}  界面 ${GiB(f.uiBytes)}  现场 ${GiB(f.groundBytes)}`)
      }
    }
  }
  const errs = [...perHost.entries()].filter(([, h]) => h.skipReason)
  if (errs.length) {
    console.log('\n=== 读取异常 ===')
    for (const [id, h] of errs) console.log(`  ${id}: ${h.skipReason}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
