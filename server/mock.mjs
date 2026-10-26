const GB = 1024 ** 3
const TB = 1024 ** 4

/**
 * 假数据，结构和真实采集完全一致（LXD 池 + 容器数据集 + 宿主系统盘 + 共享 NAS）。
 * 数量级照抄 2026-10-10 的实测结果，用来在没有 SSH/root 时调 UI。
 * MOCK=1 时使用；真实数据里不会出现 mock 标记。
 */

// [池已用字节, 池总字节, 容器数, 容器名前缀]
const POOLS = {
  s0: [2.0 * TB, 2.9 * TB, 17],
  s1: [400 * GB, 1.8 * TB, 10],
  s2: [632 * GB, 3.5 * TB, 11],
  s3: [1.4 * TB, 3.5 * TB, 4],
  s4: [566 * GB, 3.5 * TB, 7],
  s5: [614 * GB, 3.5 * TB, 3],
  s6: [188 * GB, 899 * GB, 2],
  s7: [905 * GB, 1.8 * TB, 5],
  s8: [887 * GB, 1.8 * TB, 5],
}

const NAMES = ['student01', 'student02', 'student03', 'student04', 'student05', 'student06', 'student07', 'student08', 'student09', 'student10', 'student11', 'student12', 'student13', 'student14', 'student15', 'student16', 'student17', 'student18', 'student19', 'student20', 'student21', 'student22', 'student23']

const NAS_CHILDREN = [
  { name: 'CUDA', path: '/mnt/nas/CUDA', bytes: Math.round(136.4 * GB) },
  { name: 'shared', path: '/mnt/nas/shared', bytes: Math.round(103.2 * GB) },
  { name: 'tools', path: '/mnt/nas/tools', bytes: Math.round(89.5 * 1024 * 1024) },
]

/* ---- 基础设施层（2026-10-18 实测的规模，用来在没有 SSH 时调 UI）---- */

// [宿主驱动, 卡型, 张数, 单卡显存 MiB]（2026-10-18 真机核对过型号）
const GPUS = {
  s0: ['580.126.09', 'Tesla V100-PCIE-16GB', 8, 16384],
  s1: ['550.100', 'NVIDIA GeForce RTX 4080 SUPER', 2, 16376],
  s2: ['550.100', 'NVIDIA GeForce RTX 3090', 2, 24576],
  s3: ['580.142', 'NVIDIA GeForce RTX 3090', 1, 24576],
  s4: ['580.142', 'NVIDIA GeForce RTX 3090', 2, 24576],
  s5: ['550.100', 'NVIDIA GeForce RTX 4080 SUPER', 2, 16376],
  s6: ['580.142', 'NVIDIA GeForce RTX 4080 SUPER', 2, 16376],
  s7: ['580.142', 'NVIDIA GeForce RTX 3090', 2, 24576],
  s8: ['580.142', 'NVIDIA GeForce RTX 4090', 1, 24564],
}

const LXD_VERSIONS = { s0: '5.0.4', s1: '5.0.3', s2: '5.0.3', s3: '5.0.4', s4: '5.0.4', s5: '5.0.4', s6: '5.0.4', s7: '5.0.4', s8: '5.0.4' }

// 实测角色：s8 = leader，s6/s7/s8 投票，s4/s5 standby，s0 与 s3 不带角色
const SEVEN = [
  ['s0', [], false], ['s3', [], false],
  ['s4', ['database-standby'], false], ['s5', ['database-standby'], false],
  ['s6', ['database'], false], ['s7', ['database'], false],
  ['s8', ['database-leader', 'database'], false],
]
const PAIR = [['s1', ['database-leader', 'database'], false], ['s2', ['database-standby'], false]]

function membersFor(id) {
  const list = id === 's1' || id === 's2' ? PAIR : SEVEN
  return list.map(([name, roles]) => ({
    name,
    roles,
    leader: roles.includes('database-leader'),
    voter: roles.includes('database'),
    standby: roles.includes('database-standby'),
    database: roles.length > 0,
    status: 'Online',
    message: 'Fully operational',
    url: `https://192.168.1.${10 + Number(name.slice(1))}:8443`,
    architecture: 'x86_64',
    failureDomain: 'default',
  }))
}

function gpuFor(id, r) {
  const [driver, name, count, memMiB] = GPUS[id]
  const gpus = Array.from({ length: count }, (_, i) => ({
    index: i,
    uuid: `GPU-mock-${id}-${i}`,
    name,
    driverVersion: driver,
    memoryTotalBytes: memMiB * 1024 * 1024,
    memoryUsedBytes: Math.round(r() * 0.4 * memMiB) * 1024 * 1024,
    utilPercent: Math.round(r() * 60),
    temperatureC: 28 + Math.round(r() * 40),
    powerWatts: Math.round(30 + r() * 200),
  }))
  return {
    gpus,
    driverVersion: driver,
    totalMemoryBytes: gpus.reduce((s, g) => s + g.memoryTotalBytes, 0),
    usedMemoryBytes: gpus.reduce((s, g) => s + g.memoryUsedBytes, 0),
    maxUtilPercent: gpus.reduce((m, g) => Math.max(m, g.utilPercent), 0),
    maxTempC: gpus.reduce((m, g) => Math.max(m, g.temperatureC), 0),
    compute: [],
    users: [],
    hostBroken: false,
    hostError: '',
    uvmProcMajor: 506 + (Number(id.slice(1)) % 3) * 2,
    uvmNodeMajor: 506 + (Number(id.slice(1)) % 3) * 2,
    uvmConsistent: true,
  }
}

const PROFILE_ISSUE = {
  level: 'warn',
  title: 'profile default 的 gpu 写的是 gputype: physcial',
  detail: 'LXD 认的值是 physical。现在还能透传是因为未知属性被忽略、退化成"全部卡"，但这是配置错误。',
  commands: ['#   gputype: physcial   →   gputype: physical', 'lxc profile edit default'],
}

function rng(seed) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

function containersFor(id, count, r) {
  const out = []
  for (let i = 0; i < count; i++) {
    const owner = NAMES[(i * 3 + id.charCodeAt(1)) % NAMES.length]
    const name = `${owner}-${24000 + Math.floor(r() * 2000)}`
    const quota = [200, 300, 500, 800, 1500][Math.floor(r() * 5)] * GB
    const used = Math.min(quota * 0.97, quota * (0.02 + r() * 0.75))
    out.push({
      name,
      owner,
      suffix: String(24000 + i),
      location: id,
      status: r() > 0.08 ? 'Running' : 'Stopped',
      ipv4: `240.10.0.${10 + i}`,
      project: 'default',
      dataset: `local/containers/${name}`,
      usedBytes: Math.round(used),
      quotaBytes: Math.round(quota),
      availBytes: Math.round(quota - used),
      usedPercent: Math.round((used / quota) * 1000) / 10,
      source: r() > 0.5 ? 'zfs' : 'df',
    })
  }
  return out.sort((a, b) => b.usedBytes - a.usedBytes)
}

export function mockServers() {
  const ids = Object.keys(POOLS)
  return ids.map((id, k) => {
    const r = rng(700 + k * 53)
    const [usedBytes, totalBytes, count] = POOLS[id]
    const pool = {
      name: 'local',
      driver: 'zfs',
      totalBytes: Math.round(totalBytes),
      usedBytes: Math.round(usedBytes),
      availBytes: Math.round(totalBytes - usedBytes),
      usedPercent: Math.round((usedBytes / totalBytes) * 1000) / 10,
      source: 'lxd-api',
    }
    const containers = containersFor(id, count, r)
    const containerSum = containers.reduce((s, c) => s + c.usedBytes, 0)
    const sysTotal = [492, 227, 467, 467, 467, 467, 227, 227, 227][k] * GB
    const sysUsed = sysTotal * (0.04 + r() * 0.14)
    const sys = {
      source: '/dev/sda2', type: 'ext4', mount: '/',
      totalBytes: Math.round(sysTotal), usedBytes: Math.round(sysUsed),
      availBytes: Math.round(sysTotal - sysUsed),
      usedPercent: Math.round((sysUsed / sysTotal) * 1000) / 10,
      pseudo: false, network: false,
    }
    const nas = {
      source: '//192.168.1.100/server_shared', type: 'cifs', mount: '/mnt/nas',
      totalBytes: Math.round(1.8 * TB), usedBytes: Math.round(1.5 * TB),
      availBytes: Math.round(283 * GB), usedPercent: 84.8,
      pseudo: false, network: true,
    }
    const scannedNas = id === 's0'
    const home = {
      name: id, uid: 1000, home: `/home/${id}`,
      usedBytes: Math.round((0.05 + r() * 6) * GB),
      duBytes: Math.round((0.05 + r() * 6) * GB),
      looseBytes: Math.round(r() * 2 * GB),
      children: [
        { name: 'cuda-11.6', path: `/home/${id}/cuda-11.6`, bytes: Math.round(2.4 * GB) },
        { name: '.vscode-server', path: `/home/${id}/.vscode-server`, bytes: Math.round(0.4 * GB) },
        { name: '.cache', path: `/home/${id}/.cache`, bytes: Math.round(0.1 * GB) },
      ],
      quotaUsedBytes: null, softBytes: null, hardBytes: null,
      source: 'du', percentOfQuota: null,
    }

    return {
      id,
      host: '10.0.0.10',
      port: id === 's0' ? 2222 : Number(id.slice(1)) * 100 + 22,
      user: id,
      status: 'ok',
      error: null,
      hostname: id,
      kernel: 'Linux 5.15.0-119-generic',
      probedAt: new Date().toISOString(),
      uptimeSeconds: 3600 * (40 + k * 9),
      isRoot: false,
      scannedNas,
      capacity: pool,
      capacityKind: 'lxd-pool',
      primary: sys,
      hostEpoch: Math.round(Date.now() / 1000),
      clockSkewSeconds: k % 2 === 0 ? 0 : 1,
      gpu: (() => {
        const g = gpuFor(id, r)
        if (id === 's0' && containers.length) {
          g.users = [{ container: containers[0].name, pids: [633366, 637830], usedBytes: Math.round(1.6 * GB), gpuIndexes: [0, 1] }]
          g.compute = g.users[0].pids.map((pid, i) => ({ pid, gpuUuid: g.gpus[i].uuid, gpuIndex: i, usedBytes: Math.round(0.8 * GB), container: containers[0].name, cgroup: `/lxc.payload.${containers[0].name}/user.slice` }))
          for (const i of g.users[0].gpuIndexes) g.gpus[i].memoryUsedBytes = Math.round(1.6 * GB)
        }
        return g
      })(),
      profiles: [{ name: 'default', description: 'Default LXD profile', config: { 'limits.cpu.allowance': '90%' }, devices: { gpu: { type: 'gpu', gputype: 'physcial' }, root: { type: 'disk', pool: 'local', size: '500GiB', path: '/' } }, usedBy: containers.length }],
      profileAudit: { issues: [PROFILE_ISSUE], info: [{ title: 'profile default 限了 CPU：limits.cpu.allowance=90%', detail: '每个容器都吃这条，不是每台机器单独的配额。' }], missingSources: [] },
      snap: [{ version: `${LXD_VERSIONS[id]}-mock`, rev: '31333', tracking: '5.0/stable', publisher: 'canonical**', notes: 'held', disabled: false, held: true, inCohort: false }],
      time: { epoch: Math.round(Date.now() / 1000), tz: 'CST', ntpSynchronized: true, boot: '2026-10-18 12:05:22' },
      lxd: {
        member: id,
        pool,
        pools: ['local'],
        zpools: [{ name: 'local', totalBytes: pool.totalBytes, allocBytes: pool.usedBytes, freeBytes: pool.availBytes, capPercent: Math.round(pool.usedPercent), health: 'ONLINE' }],
        zfsAvailable: k % 2 === 0,
        zfsBin: '/usr/local/sbin/srvman-zfs',
        lxcVersion: LXD_VERSIONS[id],
        clusterEnabled: id !== 's1' && id !== 's2',
        clusterMembers: membersFor(id),
        clusterKey: membersFor(id).map((m) => m.name).sort().join(','),
        containers,
        orphanDatasets: id === 's3'
          ? [{ name: 'example-24501', dataset: 'local/containers/example-24501', usedBytes: Math.round(247 * GB), quotaBytes: Math.round(500 * GB), availableBytes: 0, referBytes: 0, mountpoint: '' }]
          : [],
        totals: {
          containerCount: containers.length,
          runningCount: containers.filter((c) => c.status === 'Running').length,
          containerSumBytes: containerSum,
          orphanCount: id === 's3' ? 1 : 0,
          orphanSumBytes: id === 's3' ? Math.round(247 * GB) : 0,
          unattributedBytes: Math.max(0, pool.usedBytes - containerSum),
          poolOverheadBytes: Math.max(0, pool.usedBytes - containerSum - (id === 's3' ? 247 * GB : 0)),
          quotaBacked: containers.filter((c) => c.quotaBytes).length,
          accountCount: containers.filter((c) => c.usedBytes > 0).length,
        },
        datasets: containers.map((c) => ({ dataset: c.dataset, usedBytes: c.usedBytes, quotaBytes: c.quotaBytes })),
      },
      mounts: [sys],
      localMounts: [sys],
      networkMounts: [nas],
      nasScans: scannedNas ? [{ mount: '/mnt/nas', source: nas.source, totalBytes: Math.round(240.8 * GB), children: NAS_CHILDREN }] : [],
      allMounts: [sys, nas],
      accounts: containers,
      homeAccounts: [home],
      totals: {
        accountCount: containers.length,
        accountSumBytes: containerSum,
        containerCount: containers.length,
        runningCount: containers.filter((c) => c.status === 'Running').length,
        homeSumBytes: home.usedBytes,
        quotaSourceCount: 0,
        homeDirCount: 1,
        zfsAvailable: k % 2 === 0,
      },
      durationMs: 1200 + Math.round(r() * 2600),
    }
  })
}
