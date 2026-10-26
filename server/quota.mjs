/**
 * 配额建议。
 *
 * 手册里有一次事故的根因就是"500GB 配额写满了"，而当时是先发现容器报错、再回头查谁占着。
 * 这里反过来：把快满的容器、没空间的池、以及扩容命令一次摆出来。
 * 所有命令都**只生成不代执行**，改完还要 `lxc list` 看一眼是否真的生效（zfs 那层偶尔有延迟）。
 */
const GiB = 1024 ** 3

export const QUOTA_THRESHOLDS = { warn: 80, high: 90 }

export function quotaLevel(percent, { warn = QUOTA_THRESHOLDS.warn, high = QUOTA_THRESHOLDS.high } = {}) {
  if (percent == null) return 'unknown'
  if (percent >= high) return 'critical'
  if (percent >= warn) return 'warn'
  return 'ok'
}

/** 往上进到 50 GiB 的整数倍，且至少比当前用量多 30% —— 免得三个月后又满一次 */
export function suggestQuotaGiB(usedBytes, currentQuotaBytes) {
  const target = Math.max((usedBytes || 0) * 1.3, (currentQuotaBytes || 0) * 1.25, GiB)
  return Math.max(50, Math.ceil(target / (50 * GiB)) * 50)
}

export function buildQuotaAdvice(records = [], thresholds = {}) {
  const rows = []
  const pools = []

  for (const r of records) {
    if (r.status !== 'ok') continue
    const pool = r.lxd?.pool || null
    if (pool) {
      pools.push({
        host: r.id,
        pool: pool.name,
        totalBytes: pool.totalBytes,
        usedBytes: pool.usedBytes,
        availBytes: pool.availBytes,
        usedPercent: pool.usedPercent,
        level: quotaLevel(pool.usedPercent, thresholds),
        containers: r.lxd.containers.length,
        orphans: r.lxd.orphanDatasets?.length || 0,
        orphanBytes: r.lxd.totals?.orphanSumBytes || 0,
      })
    }
    for (const c of r.lxd?.containers || []) {
      const percent = c.usedPercent
      if (c.usedBytes == null && percent == null) continue
      const level = quotaLevel(percent, thresholds)
      const quotaBytes = c.quotaBytes || null
      const suggestedGiB = quotaBytes ? suggestQuotaGiB(c.usedBytes || 0, quotaBytes) : null
      const growBytes = suggestedGiB != null ? suggestedGiB * GiB - (quotaBytes || 0) : 0
      const poolAvail = pool?.availBytes ?? null
      // 只有真到了该动的程度才给扩容命令，别让 73% 的行也在暗示"快扩"
      const actionable = level === 'warn' || level === 'critical'
      rows.push({
        container: c.name,
        owner: c.owner,
        host: c.location || r.id,
        status: c.status,
        usedBytes: c.usedBytes ?? null,
        quotaBytes,
        usedPercent: percent ?? null,
        level,
        source: c.source,
        suggestedGiB: actionable ? suggestedGiB : null,
        growBytes: actionable ? growBytes : 0,
        // 池里剩多少决定了这个扩容到底能不能生效
        fitsInPool: actionable && poolAvail != null ? growBytes <= poolAvail : null,
        poolAvailBytes: poolAvail,
        commands: actionable && suggestedGiB != null ? [
          `lxc config device set ${c.name} root size=${suggestedGiB}GiB`,
          `# 改完确认一下（手册用的是 lxc config edit，等价）`,
          `lxc storage volume info local container/${c.name} --target ${c.location || r.id}`,
        ] : [],
        inspectCommands: [
          `lxc storage volume info local container/${c.name} --target ${c.location || r.id}`,
          `lxc storage info local --target ${c.location || r.id}`,
        ],
      })
    }
  }

  rows.sort((a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1))
  pools.sort((a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1))

  const hot = rows.filter((x) => x.level === 'critical' || x.level === 'warn')
  const blocked = hot.filter((x) => x.fitsInPool === false)

  return {
    rows,
    pools,
    hot,
    blocked,
    thresholds: { warn: thresholds.warn ?? QUOTA_THRESHOLDS.warn, high: thresholds.high ?? QUOTA_THRESHOLDS.high },
    summary: {
      containers: rows.length,
      withQuota: rows.filter((x) => x.quotaBytes).length,
      critical: rows.filter((x) => x.level === 'critical').length,
      warn: rows.filter((x) => x.level === 'warn').length,
      unknown: rows.filter((x) => x.level === 'unknown').length,
      worstPool: pools[0] || null,
    },
  }
}
