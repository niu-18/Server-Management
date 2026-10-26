/**
 * 集群层：成员状态、角色与 quorum、LXD 版本一致性、时钟偏差、snap 是否 held。
 *
 * 这些都是"出事了才知道要看"的东西，而且全部非 root 可读：
 *   lxc query /1.0/cluster/members?recursion=1、snap list --all、timedatectl。
 *
 * 2026-10-18 实测基线：
 *   7 节点集群 s0 s3 s4 s5 s6 s7 s8 —— s8 = database-leader，s6/s7 是 database 投票者，
 *   s4/s5 是 database-standby，**s0 和 s3 不带任何角色**（不参与 quorum）。
 *   2 节点集群 s1 s2 —— s1 = leader，s2 = standby。
 *   手册里写的"s5 是 leader"已经过期，所以这里必须以实际查询为准。
 */

const TRUTHY = new Set(['yes', 'true', '1'])

export function parseClusterMembers(rawJson) {
  let arr
  try {
    arr = JSON.parse(String(rawJson || '').trim())
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  return arr.map((m) => ({
    name: m.server_name || '',
    roles: Array.isArray(m.roles) ? m.roles : [],
    // LXD 5.0：leader 的 roles 同时含 database-leader 和 database
    leader: Boolean(m.roles?.includes('database-leader')),
    voter: Boolean(m.roles?.includes('database')) || Boolean(m.roles?.includes('database-vote')),
    standby: Boolean(m.roles?.includes('database-standby')),
    database: Boolean(m.database),
    status: m.status || '',
    message: m.message || '',
    url: m.url || '',
    architecture: m.architecture || '',
    failureDomain: m.failure_domain || '',
  })).filter((m) => m.name)
}

export function parseSnap(lines = []) {
  const out = []
  for (const line of lines) {
    const f = line.trim().split(/\s+/)
    if (f.length < 6 || f[0] !== 'lxd') continue
    const notes = f.slice(5).join(',')
    out.push({
      version: f[1] || '',
      rev: f[2] || '',
      tracking: f[3] || '',
      publisher: f[4] || '',
      notes,
      disabled: /disabled/.test(notes),
      held: /held/.test(notes),
      inCohort: /in-cohort/.test(notes),
    })
  }
  return out
}

export function parseTimeFacts(lines = []) {
  const raw = {}
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq === -1) continue
    raw[line.slice(0, eq)] = line.slice(eq + 1).trim()
  }
  return {
    epoch: Number(raw.epoch) || null,
    tz: raw.tz || '',
    // timedatectl --value 直接输出 yes/no；读不到就留 null，别当成"没同步"
    ntpSynchronized: raw.ntp === '' || raw.ntp == null ? null : TRUTHY.has(raw.ntp),
    boot: raw.boot || '',
  }
}

/**
 * 把 9 台记录聚成"集群"。同一集群的多台机器会返回同一份成员表，
 * 按成员名字集合去重，再用各台自己那份记录补版本/时钟/snap。
 */
export function buildClusterView(records = []) {
  const byCluster = new Map()

  for (const r of records) {
    const members = r.lxd?.clusterMembers || []
    if (members.length === 0) {
      if (!byCluster.has(`solo:${r.id}`)) {
        byCluster.set(`solo:${r.id}`, { key: `solo:${r.id}`, members: [], hosts: [] })
      }
      byCluster.get(`solo:${r.id}`).hosts.push(r)
      continue
    }
    const key = [...members.map((m) => m.name)].sort().join(',')
    if (!byCluster.has(key)) byCluster.set(key, { key, members: [], hosts: [] })
    const bucket = byCluster.get(key)
    bucket.hosts.push(r)
    // 取信息最全的那份成员表（都读得到时内容其实一样）
    if (members.length > bucket.members.length) bucket.members = members
  }

  const clusters = [...byCluster.values()].map((bucket) => {
    // 同一个集群里每台都会带回同一份成员表。哪一台说某个成员不 Online，就按不 Online 处理
    // —— leader 挂掉时宁可吵一点，也不能漏（手册 2025.9.6 就是整集群 lxc 命令无响应）。
    const merged = new Map()
    for (const host of bucket.hosts) {
      for (const m of host.lxd?.clusterMembers || []) {
        const prev = merged.get(m.name)
        if (!prev || (prev.status === 'Online' && m.status !== 'Online')) merged.set(m.name, m)
      }
    }
    const memberList = [...merged.values()]
    if (memberList.length === 0) {
      // 这台没加入任何集群（或读不到成员表），按单机展示，不套 leader/quorum 那套判据
      memberList.push(...bucket.hosts.map((h) => ({
        name: h.id,
        roles: [],
        leader: false,
        voter: false,
        standby: false,
        database: false,
        status: 'Online',
        message: '',
        url: '',
        architecture: '',
        failureDomain: '',
      })))
    }
    const memberRows = memberList.map((m) => {
      const host = bucket.hosts.find((h) => h.id === m.name) || null
      const snap = host?.snap || []
      const active = snap.find((s) => !s.disabled) || null
      return {
        ...m,
        // 从这台自己采到的信息；没采到（比如集群里有机器不在我们清单里）就留空
        collected: Boolean(host),
        lxdVersion: host?.lxd?.lxcVersion || '',
        driverVersion: host?.gpu?.driverVersion || '',
        gpuCount: host?.gpu?.gpus?.length ?? null,
        uptimeSeconds: host?.uptimeSeconds ?? null,
        // 本机时钟相对标准时间的偏差（Node 在 exec 那一刻的 epoch 作参照）
        clockSkew: Number.isFinite(host?.clockSkewSeconds) ? host.clockSkewSeconds : null,
        ntpSynchronized: host?.time?.ntpSynchronized ?? null,
        tz: host?.time?.tz || '',
        snapVersion: active?.version || '',
        snapHeld: active ? active.held : null,
        snapTracking: active?.tracking || '',
      }
    })

    const voters = memberRows.filter((m) => m.voter)
    const aliveVoters = voters.filter((m) => m.status === 'Online')
    const leader = memberRows.find((m) => m.leader) || null
    const skews = memberRows.map((m) => m.clockSkew).filter((n) => Number.isFinite(n))
    const worstSkew = skews.length ? skews.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0) : null
    const clockSpreadSeconds = skews.length > 1 ? Math.max(...skews) - Math.min(...skews) : null
    const versions = [...new Set(memberRows.map((m) => m.lxdVersion).filter(Boolean))]
    const drivers = [...new Set(memberRows.map((m) => m.driverVersion).filter(Boolean))]
    const unheld = memberRows.filter((m) => m.collected && m.snapHeld === false)
    const unreachable = memberRows.filter((m) => m.status !== 'Online')

    const alerts = []
    const clustered = (bucket.hosts[0]?.lxd?.clusterMembers?.length || 0) > 0
    if (clustered) {
      // 单机（没加入任何集群）不套 leader/quorum 判据，只保留版本、时钟、snap 这些通用检查
      if (!leader) {
        alerts.push({ level: 'critical', text: '这个集群读不到 database-leader，lxc 命令很可能整片无响应' })
      } else if (leader.status !== 'Online') {
        alerts.push({ level: 'critical', text: `leader ${leader.name} 状态是 ${leader.status || '未知'}，集群随时会瘫（手册 2025.9.6）` })
      }
      if (voters.length && aliveVoters.length < Math.floor(voters.length / 2) + 1) {
        alerts.push({ level: 'critical', text: `投票者只剩 ${aliveVoters.length}/${voters.length}，不足多数，数据库无法写入` })
      }
    }
    if (clustered && versions.length > 1) alerts.push({ level: 'warn', text: `集群内 LXD 版本不一致：${versions.join(' / ')}（手册修复方案 4）` })
    if (clustered && drivers.length > 1) {
      alerts.push({
        level: 'warn',
        text: `同一个集群里宿主驱动有 ${drivers.length} 套：${drivers.join(' / ')}。容器一旦迁到版本不同的成员就会 NVML 版本不一致（nvidia-smi 直接坏），这是手册里最常见的一类故障`,
      })
    }
    if (worstSkew != null && Math.abs(worstSkew) > 2) {
      alerts.push({ level: 'warn', text: `时钟偏差最大 ${worstSkew > 0 ? '+' : ''}${worstSkew} 秒 —— 集群里时间不一致会出现莫名 error（手册修复方案 5：装 chrony 后 chronyc makestep，再重启 snap.lxd.daemon）` })
    }
    if (clockSpreadSeconds != null && clockSpreadSeconds > 2) {
      alerts.push({ level: 'warn', text: `成员之间时钟相差 ${clockSpreadSeconds} 秒` })
    }
    for (const m of memberRows) {
      if (m.collected && m.ntpSynchronized === false) alerts.push({ level: 'warn', text: `${m.name} 没在同步时间（NTPSynchronized=no）` })
      if (m.collected && m.snapHeld === false) alerts.push({ level: 'warn', text: `${m.name} 的 lxd snap 没有 held，自动更新可能把集群打挂（手册强制要求）` })
      if (m.collected && m.status === 'Online' && m.message && !/fully operational/i.test(m.message)) {
        alerts.push({ level: 'warn', text: `${m.name} 报 "${m.message}"` })
      }
    }

    return {
      key: bucket.key,
      clustered,
      members: memberRows.sort((a, b) => a.name.localeCompare(b.name)),
      memberCount: memberRows.length,
      leader: leader?.name || '',
      voters: voters.map((v) => v.name),
      aliveVoters: aliveVoters.length,
      unreachable: unreachable.map((u) => u.name),
      versions,
      drivers,
      driverConsistent: drivers.length <= 1,
      worstSkew,
      clockSpreadSeconds,
      snapUnheld: unheld.map((u) => u.name),
      alerts,
    }
  })

  // 成员多的集群排前面，看着顺手
  clusters.sort((a, b) => b.memberCount - a.memberCount)
  return clusters
}
