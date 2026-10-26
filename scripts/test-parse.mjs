#!/usr/bin/env node
/**
 * 解析器回归测试：用真实的 df / repquota / du 输出样本喂给采集器，
 * 检查数值是否被正确解析。不需要连服务器。
 *
 *   npm test
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  splitSections,
  parseDf,
  parseRepquota,
  parseHomes,
  parseDepthOneScan,
  parseNasScans,
  parseUsers,
  buildServerRecord,
  buildSharedStorage,
} from '../server/collect.mjs'
import { buildRemoteScript } from '../server/remoteScript.mjs'
import {
  parsePoolResources,
  parseZfs,
  parseContainerDf,
  parseInstances,
  buildLxdView,
  applyContainerDf,
  buildContainerDfScript,
} from '../server/lxd.mjs'

const T = '\t'
let passed = 0
let failed = 0
// 允许异步用例（比如本地起个监听再探测端口）。同步的照旧立刻出结果，
// 异步的会排在最后，但都算进同一个 passed/failed。
const pending = []

function test(name, fn) {
  pending.push((async () => {
    try {
      await fn()
      passed++
      console.log(`  \x1b[32m✓\x1b[0m ${name}`)
    } catch (err) {
      failed++
      console.log(`  \x1b[31m✗\x1b[0m ${name}`)
      console.log(`      ${String(err && err.message ? err.message : err).split('\n').slice(0, 6).join('\n      ')}`)
    }
  })())
}

const DF = [
  'Filesystem     Type                 1024-blocks      Used Available Capacity Mounted on',
  'overlay        overlay                 307024832 224183520  67187712      77% /',
  'tmpfs          tmpfs                       65536         0     65536       0% /dev/shm',
  '/dev/nvme0n1p1 ext4                    1861521328 1204514204 561881836     69% /home',
  'proc           proc                            0         0         0        - /proc',
  '/dev/loop0     squashfs                  128512    128512         0    100% /snap/bare/5',
  '//192.168.1.100/server_shared cifs 1800000000 1500000000 300000000 84% /mnt/nas',
]

/* ------------------------------------------------------------------ */
console.log('\ndf 解析')
const mounts = parseDf(DF)
test('表头剔除、blocks=0 丢弃，剩 5 条', () => {
  assert.equal(mounts.length, 5, `实际 ${mounts.length}`)
})
test('取到 type 列与三个数值列', () => {
  const home = mounts.find((m) => m.mount === '/home')
  assert.equal(home.type, 'ext4')
  assert.equal(home.totalBytes, 1861521328 * 1024)
})
test('使用率按 total 计算', () => {
  assert.equal(mounts.find((m) => m.mount === '/home').usedPercent, 64.7)
})
test('cifs 标为网络挂载', () => {
  const nas = mounts.find((m) => m.mount === '/mnt/nas')
  assert.equal(nas.network, true)
  assert.equal(nas.source, '//192.168.1.100/server_shared')
})
test('本地挂载不带 network 标记', () => {
  assert.equal(mounts.find((m) => m.mount === '/home').network, false)
})
test('tmpfs / squashfs 标为伪文件系统', () => {
  assert.equal(mounts.find((m) => m.mount === '/dev/shm').pseudo, true)
  assert.equal(mounts.find((m) => m.mount.startsWith('/snap')).pseudo, true)
})

/* ------------------------------------------------------------------ */
console.log('\ndu --max-depth=1 解析')
const HOME_LINES = [
  `1024${T}/home/zhang.wei/datasets`,
  `2048${T}/home/zhang.wei/miniconda3`,
  `64${T}/home/zhang.wei/miniconda3/pkgs/cache`,
  `4096${T}/home/zhang.wei`,
]
const scan = parseDepthOneScan(HOME_LINES, '/home/zhang.wei')
test('总量取等于 home 自身那一行', () => {
  assert.equal(scan.totalBytes, 4096 * 1024)
})
test('只留直属子项，孙子项不单独列', () => {
  assert.deepEqual(scan.children.map((c) => c.name), ['miniconda3', 'datasets'])
})
test('子项按大小降序', () => {
  assert.equal(scan.children[0].bytes, 2048 * 1024)
})
test('缺少总量行时用子项之和兜底', () => {
  const s = parseDepthOneScan([`10${T}/root/a`, `20${T}/root/b`], '/root')
  assert.equal(s.totalBytes, 30 * 1024)
})
test('空格路径按 tab 切分', () => {
  const s = parseDepthOneScan([`7${T}/home/x/my dir`], '/home/x')
  assert.equal(s.children[0].name, 'my dir')
})

console.log('\nDU 分块（@@HOME 标记）')
const homes = parseHomes([
  '@@HOME/home/s0',
  `512${T}/home/s0/cache`,
  `9000${T}/home/s0`,
  '@@HOME/root',
  `4${T}/root`,
])
test('按 home 分块', () => {
  assert.deepEqual([...homes.keys()], ['/home/s0', '/root'])
})
test('每块各自算总量与子项', () => {
  assert.equal(homes.get('/home/s0').totalBytes, 9000 * 1024)
  assert.equal(homes.get('/home/s0').children.length, 1)
  assert.equal(homes.get('/root').children.length, 0)
})

/* ------------------------------------------------------------------ */
console.log('\nrepquota 解析')
const quota = parseRepquota([
  '*** Report for user quotas on device /dev/nvme0n1p1',
  'Block grace time: 7days; Inode grace time: 7days',
  '                        Space limits                File limits',
  'User            used    soft    hard  status    used  disk  files',
  `root${T}--${T}    45672       0       0             7     0     0`,
  `zhang.wei${T}--${T} 1048576 2097152 4194304        1234     0     0`,
  '*** Report for group quotas on device /dev/nvme0n1p1',
  'sudo      --  9999999       0       0             1     0     0',
])
test('解析用户配额，忽略组配额', () => {
  assert.equal(quota.size, 2, `实际 ${quota.size}`)
  assert.equal(quota.has('sudo'), false)
})
test('KB -> bytes 并记录设备', () => {
  assert.equal(quota.get('zhang.wei').usedBytes, 1048576 * 1024)
  assert.equal(quota.get('zhang.wei').device, '/dev/nvme0n1p1')
})

/* ------------------------------------------------------------------ */
console.log('\n单台记录合并')
const sections = {
  HOST: ['gpu-s0'],
  KERNEL: ['Linux 5.15.0-119-generic'],
  DATE: ['2026-10-09T13:00:00Z'],
  UPTIME: ['1296000'],
  IDENTITY: ['0', 'user=root'],
  DF: DF,
  USERS: [`root${T}0${T}/root${T}/bin/bash`, `zhang.wei${T}1001${T}/home/zhang.wei${T}/bin/bash`],
  QUOTA: [],
  DU: ['@@HOME/home/zhang.wei', ...HOME_LINES.slice(0, 3), HOME_LINES[3], '@@HOME/root', `4${T}/root`],
  NASDU: [
    `140000000${T}/mnt/nas/CUDA`,
    `105000000${T}/mnt/nas/shared`,
    `9000${T}/mnt/nas/tools`,
    `252000000${T}/mnt/nas`,
  ],
}
const rec = buildServerRecord({ id: 's0', host: 'h', port: 2222, user: 's0' }, sections, { scanNas: true })
test('primary 选本地 /home，不是 NAS', () => {
  assert.equal(rec.primary.mount, '/home')
})
test('mounts 只含本地，networkMounts 单独列出', () => {
  assert.deepEqual(rec.mounts.map((m) => m.mount), ['/', '/home'])
  assert.deepEqual(rec.networkMounts.map((m) => m.mount), ['/mnt/nas'])
})
test('账户带 home 子目录', () => {
  const z = rec.accounts.find((a) => a.name === 'zhang.wei')
  assert.equal(z.source, 'du')
  assert.equal(z.usedBytes, 4096 * 1024)
  assert.deepEqual(z.children.map((c) => c.name), ['miniconda3', 'datasets'])
})
test('零散文件 = 总量 - 直属子项之和', () => {
  const z = rec.accounts.find((a) => a.name === 'zhang.wei')
  assert.equal(z.looseBytes, (4096 - 1024 - 2048) * 1024)
})
test('NAS 扫描结果挂在 nasScans', () => {
  assert.equal(rec.nasScans.length, 1)
  assert.equal(rec.nasScans[0].totalBytes, 252000000 * 1024)
  assert.deepEqual(rec.nasScans[0].children.map((c) => c.name), ['CUDA', 'shared', 'tools'])
})
test('root 识别 + 汇总计数', () => {
  assert.equal(rec.isRoot, true)
  assert.equal(rec.scannedNas, true)
  assert.equal(rec.totals.homeDirCount, 2)
})

console.log('\n不扫描 NAS 的机器')
const rec2 = buildServerRecord({ id: 's3', host: 'h', port: 322, user: 's3' }, {
  ...sections,
  NASDU: ['SKIPPED:not-scanner'],
}, {})
test('SKIPPED 不产生 nas 明细', () => {
  assert.deepEqual(rec2.nasScans, [])
  assert.equal(rec2.scannedNas, false)
})
test('但网络挂载信息仍然记录', () => {
  assert.deepEqual(rec2.networkMounts.map((m) => m.mount), ['/mnt/nas'])
})

/* ------------------------------------------------------------------ */
console.log('\n跨机共享去重')
const mk = (id, { scan = false, used = 1500000000 } = {}) => buildServerRecord(
  { id, host: 'h', port: 1, user: id },
  { ...sections, NASDU: scan ? sections.NASDU : ['SKIPPED:x'] },
  { scanNas: scan },
)
const group = buildSharedStorage([mk('s0', { scan: true }), mk('s1'), mk('s2'), mk('s3')])
test('9 台同一个共享 → 只有一份', () => {
  assert.equal(group.length, 1)
})
test('记录挂在哪些机器上', () => {
  assert.deepEqual(group[0].seenOn, ['s0', 's1', 's2', 's3'])
})
test('df 是整设备量，du 是共享内容量，两者分开', () => {
  assert.equal(group[0].usedBytes, 1500000000 * 1024)
  assert.equal(group[0].contentBytes, 252000000 * 1024)
})
test('内容明细挂在真正扫描它的那台上', () => {
  assert.equal(group[0].scannedBy, 's0')
  assert.equal(group[0].children.length, 3)
})
test('离线机器不参与去重', () => {
  const dead = { id: 's9', status: 'error', networkMounts: [], nasScans: [] }
  assert.equal(buildSharedStorage([dead, mk('s0', { scan: true })]).length, 1)
})

/* ------------------------------------------------------------------ */
console.log('\n异常输入')
test('空 section 不崩', () => {
  const r = buildServerRecord({ id: 'x', host: 'h', port: 1, user: 'x' }, {}, {})
  assert.equal(r.hostname, '')
  assert.equal(r.primary, null)
  assert.deepEqual(r.accounts, [])
  assert.deepEqual(r.networkMounts, [])
})
test('repquota 权限报错行被忽略', () => {
  assert.equal(parseRepquota(['repquota: /dev/sda1: cannot open quotafile - Permission denied']).size, 0)
})
test('users 解析容忍缺列', () => {
  assert.deepEqual(parseUsers([`a${T}1000`])[0].home, '')
})
test('无 Type 列的 df 字段位移正确', () => {
  const m = parseDf([
    'Filesystem     1024-blocks      Used Available Capacity Mounted on',
    '/dev/sda1          51506892  36320212  12558656      75% /',
    '/dev/sdb1        1024000000 102400000 921600000     11% /data',
  ])
  assert.equal(m.length, 2)
  assert.equal(m[0].totalBytes, 51506892 * 1024)
  assert.equal(m[1].mount, '/data')
  assert.equal(m[1].network, false)
})

console.log('\n远端脚本本身')
test('没有残留的 JS 插值（String.raw 仍会求值 ${}）', () => {
  for (const scan of [true, false]) {
    const s = buildRemoteScript({ scanNas: scan })
    assert.equal(s.includes('${'), false, '脚本里还有 ${...}')
    assert.equal(s.includes('undefined'), false, '脚本里出现 undefined')
  }
})
test('shell 注释里没有反引号（会截断 String.raw 模板）', () => {
  for (const s of [buildRemoteScript({ scanNas: true }), buildContainerDfScript(['a-1'])]) {
    for (const line of s.split('\n')) {
      if (!/^\s*#/.test(line)) continue
      assert.equal(line.includes('`'), false, `注释里有反引号: ${line.trim()}`)
    }
  }
})
test('扫 NAS 和不扫 NAS 的脚本不同', () => {
  const a = buildRemoteScript({ scanNas: true })
  const b = buildRemoteScript({ scanNas: false })
  assert.equal(a.includes('findmnt'), true)
  assert.equal(b.includes('SKIPPED:not-scanner'), true)
})
test('findmnt 不带与 --raw 冲突的 --list', () => {
  const s = buildRemoteScript({ scanNas: true })
  assert.equal(/findmnt[^|\n]*-l\b/.test(s), false, 'findmnt 用了 -l，会和 -r 互斥报错')
})

/* ------------------------------------------------------------------ *
 * LXD 层：真实采样数据
 * ------------------------------------------------------------------ */
const GB = 1024 ** 3
const TB = 1024 ** 4

console.log('\nLXD 池资源（lxc query 输出）')
const poolRes = parsePoolResources([
  '@@P local s0\t{"inodes":{"total":0,"used":0},"space":{"total":3195992539136,"used":2152911171584}}',
])
test('解析出字节级 total/used', () => {
  const r = poolRes.get('local')
  assert.equal(r.totalBytes, 3195992539136)
  assert.equal(r.usedBytes, 2152911171584)
  assert.equal(r.usedPercent, 67.4)
})
test('坏 JSON 不炸', () => {
  assert.equal(parsePoolResources(['@@P local s0\tnot json']).size, 0)
})

console.log('\nzfs list -H -p')
const zfsMap = parseZfs([
  `local\tfilesystem\t971869679616\t1020994969600\t98304\tnone\t-`.replace(/\t/g, '\t'),
  `local/containers/xuwei-24506\tfilesystem\t${522874740736}\t336272224256\t${522874740736}\t${858993459200}\tlegacy`,
  `local/containers/niuqi-25701\tfilesystem\t${88321957888}\t${449634631680}\t${88772276224}\t${536870912000}\tlegacy`,
  'local/snapshots\tsnapshot\t0\t-\t0\t-\t-',
])
test('数据集按 name 索引', () => {
  assert.equal(zfsMap.size, 3)
})
test('quota 转字节', () => {
  assert.equal(zfsMap.get('local/containers/xuwei-24506').quotaBytes, 858993459200)
})
test('quota=none 视为无配额', () => {
  assert.equal(zfsMap.get('local').quotaBytes, null)
})

console.log('\n容器内 df 兜底')
const dfs = parseContainerDf([
  '@@C teacher-demo\tlocal/containers/teacher-demo   525428224 42047488 483380736       9% /',
  'SKIPPED:zfs-available',
])
test('解析出配额和已用（KB→字节）', () => {
  const d = dfs.get('teacher-demo')
  assert.equal(d.totalBytes, 525428224 * 1024)
  assert.equal(d.usedBytes, 42047488 * 1024)
  assert.equal(d.usedPercent, 8)
})

console.log('\n实例清单与 location 过滤')
const instancesJson = JSON.stringify([
  { name: 'xuwei-24506', location: 's7', status: 'Running', project: 'default', state: { status: 'Running' }, config: {} },
  { name: 'niuqi-25701', location: 's7', status: 'Running', project: 'default', state: {}, config: {} },
  { name: 'studentE-24508', location: 's0', status: 'Running', project: 'default', state: {}, config: {} },
])
const insts = parseInstances(instancesJson)
test('解析出 3 个实例', () => {
  assert.equal(insts.length, 3)
})
test('坏 JSON 返回空而不是抛', () => {
  assert.deepEqual(parseInstances('{"truncated'), [])
})

const lxdSections = {
  LXDMETA: ['member=s7', 'zfs_bin=/sbin/zfs', 'zfs_ok=1', 'cluster={"enabled": true}'],
  POOLNAMES: ['local'],
  POOLRES: ['@@P local s7\t{"inodes":{"total":0,"used":0},"space":{"total":1931124670464,"used":971870756864}}'],
  INSTANCES: [instancesJson],
  ZPOOL: [],
  ZFS: [
    `local/containers/xuwei-24506\tfilesystem\t${522874740736}\t336272224256\t${522874740736}\t${858993459200}\tlegacy`,
    `local/containers/niuqi-25701\tfilesystem\t${88321957888}\t${449634631680}\t${88772276224}\t${536870912000}\tlegacy`,
  ],
}
const view = buildLxdView(lxdSections, null)
test('member 从 LXDMETA 取', () => {
  assert.equal(view.member, 's7')
})
test('只保留本成员的容器', () => {
  assert.deepEqual(view.containers.map((c) => c.name), ['xuwei-24506', 'niuqi-25701'])
})
test('池容量来自 LXD API', () => {
  assert.equal(view.pool.totalBytes, 1931124670464)
  assert.equal(view.pool.source, 'lxd-api')
})
test('容器用量与配额来自 zfs 数据集', () => {
  const x = view.containers[0]
  assert.equal(x.usedBytes, 522874740736)
  assert.equal(x.quotaBytes, 858993459200)
  assert.equal(x.source, 'zfs')
  assert.equal(x.usedPercent, 60.9)
})
test('容器名拆出姓名和学号', () => {
  assert.equal(view.containers[0].owner, 'xuwei')
  assert.equal(view.containers[0].suffix, '24506')
})
test('未归属部分 = 池已用 - 容器合计', () => {
  assert.equal(view.totals.unattributedBytes, 971870756864 - 522874740736 - 88321957888)
})

console.log('\ndf 兜底回填')
const view2 = buildLxdView({
  ...lxdSections,
  LXDMETA: ['member=s7', 'zfs_bin=', 'zfs_ok=0', 'cluster='],
  ZFS: [],
}, null)
test('zfs 不可用时容器先标未取到', () => {
  assert.deepEqual(view2.containers.map((c) => c.source), ['none', 'none'])
})
applyContainerDf(view2, ['@@C niuqi-25701\tlocal/containers/niuqi-25701 524288000 104857600 419430400 20% /'])
test('回填后该容器有数据', () => {
  const n = view2.containers.find((c) => c.name === 'niuqi-25701')
  assert.equal(n.source, 'df')
  assert.equal(n.usedBytes, 104857600 * 1024)
  assert.equal(n.quotaBytes, 524288000 * 1024)
})
test('另一个仍是未取到（停着的容器就是这个情况）', () => {
  assert.equal(view2.containers.find((c) => c.name === 'xuwei-24506').source, 'none')
})

console.log('\n脚本段名不冲突')
test('容器 df 段叫 CDF，不覆盖宿主 DF 段', () => {
  const s = buildRemoteScript({ scanNas: false, withLxd: true })
  const dfMarkers = s.match(/echo "\$S:DF"/g) || []
  const cdfMarkers = s.match(/echo "\$S:CDF"/g) || []
  assert.equal(dfMarkers.length, 1, `DF 段出现 ${dfMarkers.length} 次`)
  assert.equal(cdfMarkers.length, 1, 'CDF 段应存在且只一次')
  const off = buildRemoteScript({ scanNas: false, withLxd: false })
  assert.equal(off.includes('LXDMETA'), false, '关掉 withLxd 不应有 LXD 段')
})
test('第二阶段脚本只 exec 指定名字', () => {
  const s = buildContainerDfScript(['xuwei-24506', 'niuqi-25701'])
  assert.equal(s.includes('lxc list'), false, '不该再列全集群')
  assert.equal(s.includes('xuwei-24506'), true)
  assert.equal(s.includes('@@SEC:CDF'), true)
})
test('第二阶段脚本拒绝可疑名字', () => {
  const s = buildContainerDfScript(['ok-1', '; rm -rf /', '$(whoami)'])
  assert.equal(s.includes('ok-1'), true)
  assert.equal(s.includes('rm -rf'), false)
  assert.equal(s.includes('whoami'), false)
})

console.log('\n迁移残留数据集（用户报的 example-24501 那类问题）')
const orphanSections = {
  LXDMETA: ['member=s0', 'zfs_bin=/sbin/zfs', 'zfs_ok=1', 'cluster='],
  POOLNAMES: ['local'],
  POOLRES: ['@@P local s0\t{"space":{"total":3195992539136,"used":2161900000000}}'],
  INSTANCES: [JSON.stringify([
    { name: 'live-1001', location: 's0', status: 'Running' },
    { name: 'example-24501', location: 's8', status: 'Running' },
  ])],
  ZPOOL: [],
  ZFS: [
    `local/containers/live-1001\tfilesystem\t${100 * GB}\t0\t0\t${500 * GB}\tlegacy`,
    `local/containers/example-24501\tfilesystem\t${247 * GB}\t0\t0\t${500 * GB}\tlegacy`,
    `local/images/abc123\tfilesystem\t${2 * GB}\t0\t0\tnone\tlegacy`,
  ],
}
const ov = buildLxdView(orphanSections, null)
test('本机实例只算落在这台上的那个', () => {
  assert.deepEqual(ov.containers.map((c) => c.name), ['live-1001'])
})
test('迁移走的容器在本台被识别为残留数据集', () => {
  assert.equal(ov.orphanDatasets.length, 1)
  assert.equal(ov.orphanDatasets[0].name, 'example-24501')
  assert.equal(ov.orphanDatasets[0].usedBytes, 247 * GB)
})
test('残留量单独汇总，不被“残差”吞掉', () => {
  assert.equal(ov.totals.orphanCount, 1)
  assert.equal(ov.totals.orphanSumBytes, 247 * GB)
})
test('池已用扣掉容器和残留之后才是镜像/元数据开销', () => {
  assert.equal(ov.totals.unattributedBytes, 2161900000000 - 100 * GB)
  assert.equal(ov.totals.poolOverheadBytes, 2161900000000 - 100 * GB - 247 * GB)
})
test('images 数据集不算作迁移残留', () => {
  assert.equal(ov.orphanDatasets.some((o) => o.name.startsWith('abc')), false)
})

console.log('\n样式表合法性（主题变量必须成套）')
const css = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
const cssExtra = fs.readFileSync(new URL('../src/v2.css', import.meta.url), 'utf8')
test('没有写死的颜色，全部走 var()', () => {
  // :root / [data-theme] 两个变量定义块里当然写死，其余地方不允许
  const body = (css + '\n' + cssExtra).replace(/:root,\s*\[data-theme='dark'\]\s*\{[\s\S]*?\n\}/, '')
    .replace(/\[data-theme='light'\]\s*\{[\s\S]*?\n\}/, '')
  const offenders = body.split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => !l.trim().startsWith('/*') && /#[0-9a-fA-F]{3,8}\b/.test(l) && !/var\(/.test(l))
  assert.deepEqual(offenders.map(({ l }) => l.trim()), [], `有硬编码颜色:\n${offenders.map(o => o.l.trim()).join('\n')}`)
})
test('十六进制色值格式合法（防手滑打错）', () => {
  // 只看声明的值部分，避开 #root 这类选择器
  const values = [...(css + '\n' + cssExtra).matchAll(/:[^;{}]*;/g)].map((m) => m[0])
  const bad = values.flatMap((v) => [...v.matchAll(/#[0-9a-zA-Z]{1,9}\b/g)].map((m) => m[0]))
    .filter((v) => !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v))
  assert.deepEqual(bad, [], `非法色值: ${bad.join(' ')}`)
})
test('浅色主题覆盖了深色定义的所有颜色变量', () => {
  const darkBlock = css.match(/:root,\s*\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)[1]
  const lightBlock = css.match(/\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/)[1]
  const entries = (block) => [...block.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()])
  const light = new Map(entries(lightBlock))
  // 只要求颜色类变量成套；--radius / --mono 这类结构变量本来就两主题共用
  const colorVars = entries(darkBlock).filter(([, v]) => /^#|^(rgb|hsl)a?\(/.test(v)).map(([k]) => k)
  const missing = colorVars.filter((v) => !light.has(v))
  assert.deepEqual(missing, [], `浅色缺颜色变量: ${missing.join(' ')}`)
  const extra = [...light.keys()].filter((v) => !colorVars.includes(v))
  assert.deepEqual(extra, [], `浅色多出未在深色定义的颜色变量: ${extra.join(' ')}`)
})

console.log('\n两套主题的 WCAG 对比度')
function cssThemeVars(block) {
  const out = {}
  for (const m of block.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) out[m[1]] = m[2].trim()
  return out
}
function toRGB(v) {
  const h = typeof v === 'string' && v.match(/^#([0-9a-fA-F]{6})$/)
  if (h) {
    const s = h[1]
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), 1]
  }
  const rgb = typeof v === 'string' && v.match(/rgba?\(([^)]+)\)/)
  if (rgb) {
    const p = rgb[1].split(/[\s,/]+/).map(Number)
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
  }
  return null
}
function luminance(rgb) {
  const [r, g, b] = rgb.length === 4 ? rgb.slice(0, 3) : rgb
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

const darkVars = cssThemeVars(css.match(/:root,\s*\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)[1])
const lightVars = { ...darkVars, ...cssThemeVars(css.match(/\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/)[1]) }

// 背景可以是一叠（页面底色 → 半透明面板色），必须自下而上合成后再比
function bgStack(vars, chain) {
  let base = toRGB(vars[chain[0]])
  assert.ok(base, `无法解析背景 ${chain[0]}`)
  base = [base[0], base[1], base[2], 1]
  for (let i = 1; i < chain.length; i++) {
    const l = toRGB(vars[chain[i]])
    assert.ok(l, `无法解析背景 ${chain[i]}`)
    const a = l[3]
    base = [0, 1, 2].map((k) => l[k] * a + base[k] * (1 - a)).concat([1])
  }
  return base
}
function contrastOn(vars, fgVar, chain) {
  const fg = toRGB(vars[fgVar])
  const bg = bgStack(vars, chain)
  if (!fg) return 0
  const eff = [0, 1, 2].map((k) => fg[k] * fg[3] + bg[k] * (1 - fg[3]))
  const l1 = luminance(eff)
  const l2 = luminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

// [前景, 背景层(自下而上), 最低要求]：4.5 正文，3.0 大字/图形
const PAIRS = [
  ['--text', ['--bg'], 4.5],
  ['--text', ['--panel'], 4.5],
  ['--text', ['--bg-2'], 4.5],
  ['--muted', ['--bg'], 4.5],
  ['--muted', ['--panel'], 4.5],
  ['--faint', ['--bg'], 3.0],
  ['--heading', ['--bg-2'], 4.5],
  ['--accent', ['--panel'], 3.0],
  ['--low', ['--panel'], 3.0],
  ['--mid', ['--panel'], 3.0],
  ['--high', ['--panel'], 3.0],
  ['--critical', ['--panel'], 3.0],
  ['--danger-text', ['--bg', '--danger-bg'], 4.5],
  ['--warn-text', ['--bg', '--warn-bg'], 4.5],
  ['--orphan-text', ['--bg', '--orphan-bg'], 4.5],
]
for (const [name, vars] of [['深色', darkVars], ['浅色', lightVars]]) {
  test(`${name}主题 ${PAIRS.length} 组文字/背景达标`, () => {
    const fails = []
    for (const [fgV, chain, min] of PAIRS) {
      const c = contrastOn(vars, fgV, chain)
      if (c < min) fails.push(`${fgV} on ${chain.join(' + ')} = ${c.toFixed(2)} (需 ≥${min})`)
    }
    assert.deepEqual(fails, [], `\n      ${fails.join('\n      ')}`)
  })
}
test('浅色主题的正文底色确实比文字浅（防止两套值写反）', () => {
  assert.ok(luminance(toRGB(lightVars['--bg'])) > luminance(toRGB(lightVars['--text'])))
  assert.ok(luminance(toRGB(darkVars['--bg'])) < luminance(toRGB(darkVars['--text'])))
})

console.log('\n账户体检（检查项注册表 + 判定）')
const {
  CHECKS,
  buildCheckScript,
  parseCheckOutput,
  parseFacts,
  judgeCheck,
  pickInstaller,
  rollUp,
} = await import('../server/checks.mjs')
const BY_ID = new Map(CHECKS.map((c) => [c.id, c]))

// 2026-10-18 从 s8 上真机抓的原始输出（teacher-demo 的库是 550.100，宿主 580.142）
const FX_BROKEN = `@@SEC:FACTS
member=s8
kernel=5.15.0-198-generic
driver=580.142
gpu_count=1
gpu_names=NVIDIA GeForce RTX 4090;
uvm_major=510
uvm_node=1fe
nvml_error=580.142
lxd=5.0.4
@@SEC:INSTALLERS
/home/ubuntu/shared/NVIDIA-Linux-x86_64-2.run
/home/ubuntu/shared/NVIDIA-Linux-x86_64-570.211.01.run
/home/ubuntu/shared/NVIDIA-Linux-x86_64-580.142.run
/home/ubuntu/shared/NVIDIA-Linux-x86_64-V100.run
/home/ubuntu/shared/NVIDIA-Linux-x86_64.run
@@SEC:gpu
Failed to initialize NVML: Driver/library version mismatch
NVML library version: 550.100
@@RC=18
@@SEC:nodes
/dev/nvidia0 c3
/dev/nvidiactl c3
/dev/nvidia-uvm 1fe
@@RC=0
@@SEC:cuda
OK /usr/local/cuda-11.6
OK /usr/local/cuda-12.6
@@RC=0
@@SEC:disk
Filesystem                    1024-blocks     Used Available Capacity Mounted on
local/containers/teacher-demo   525428224 42047488 483380736       9% /
@@RC=0
@@SEC:ssh
RUN=1
passwordauthentication yes
@@RC=0
@@SEC:tmux
/usr/bin/tmux
@@RC=0
@@SEC:net
DNS=ok
HTTP=200
@@RC=0
@@SEC:proc
ZOMBIE=0
PYTHON=0
TOTAL=30
@@RC=0
@@SEC:END`

const ctxOf = (over = {}) => ({
  container: 'teacher-demo',
  containerStatus: 'Running',
  member: 's8',
  hostDriver: '580.142',
  hostUvmMajor: 510,
  gpuCount: 1,
  installers: [
    '/home/ubuntu/shared/NVIDIA-Linux-x86_64-2.run',
    '/home/ubuntu/shared/NVIDIA-Linux-x86_64-570.211.01.run',
    '/home/ubuntu/shared/NVIDIA-Linux-x86_64-580.142.run',
    '/home/ubuntu/shared/NVIDIA-Linux-x86_64-V100.run',
  ],
  ...over,
})

test('检查项注册表：id 唯一，每项都有命令和手册出处', () => {
  const ids = CHECKS.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, 'id 重复')
  for (const c of CHECKS) {
    assert.ok(c.title && c.cmd && c.manual && c.timeout > 0, `${c.id} 字段不全`)
    assert.ok(!c.cmd.includes('\n'), `${c.id} 的命令不该有换行`)
  }
})

test('体检脚本：段齐全，每条检查都带退出码', () => {
  const s = buildCheckScript('teacher-demo')
  assert.ok(s.includes('@@SEC:FACTS') && s.includes('@@SEC:INSTALLERS'))
  for (const c of CHECKS) {
    if (c.optIn) assert.equal(s.includes(`@@SEC:${c.id}`), false, `${c.id} 是慢检查，不该默认跑`)
    else assert.ok(s.includes(`@@SEC:${c.id}`), `缺段 ${c.id}`)
  }
  assert.equal((s.match(/@@RC=\$\?/g) || []).length, CHECKS.filter((c) => !c.optIn).length)
  assert.equal(s.includes('undefined'), false)
  assert.ok(buildCheckScript('x', { includeSlow: true }).includes('@@SEC:torch'))
})

test('体检脚本：可疑容器名直接拒绝', () => {
  for (const bad of ['a;rm -rf /', 'a b', '$(id)', "a'b", '']) {
    assert.throws(() => buildCheckScript(bad), /非法容器名/, `${bad} 竟然放过了`)
  }
})

test('体检脚本：命令里的单引号被正确转义', () => {
  const s = buildCheckScript('c1')
  assert.ok(s.includes(`sh -c 'stat -c '\\''%n %t'\\'' /dev/nvidia0`), 'nodes 项转义不对')
  assert.equal(s.includes("sh -c 'stat -c '%n %t'"), false)
  const slow = buildCheckScript('c1', { ids: ['torch'] })
  assert.ok(slow.includes(`'python3 -c '\\''import torch`), 'torch 项转义不对')
})

const FX = parseCheckOutput(FX_BROKEN)
const FACTS = parseFacts(FX.FACTS.lines)

test('真机输出解析：段、退出码、宿主事实', () => {
  assert.equal(FACTS.member, 's8')
  assert.equal(FACTS.driver, '580.142')
  assert.equal(FACTS.uvmMajor, 510, 'uvm 主编号要从十进制文本读出来')
  assert.equal(FACTS.uvmNodeMajor, 510, '%t 是十六进制，要转成 510')
  assert.equal(FX.gpu.rc, 18)
  assert.equal(FX.nodes.rc, 0)
  assert.equal(FX.END.lines.length, 0)
})

test('驱动不一致：判 fail，报出库版本，并给容器里确实存在的那份安装器', () => {
  const r = judgeCheck(BY_ID.get('gpu'), FX.gpu, ctxOf())
  assert.equal(r.status, 'fail')
  assert.match(r.detail, /550\.100/)
  assert.match(r.detail, /580\.142/)
  assert.equal(r.commands[0], 'bash /home/ubuntu/shared/NVIDIA-Linux-x86_64-580.142.run --no-kernel-module --silent')
  assert.ok(r.commands[0].includes('--no-kernel-module'), '容器里装驱动必须不装内核模块')
  assert.ok(!r.commands.some((c) => c.includes('cuda_')), '不能把 CUDA 工具包安装器当驱动')
})

test('跨成员比对：容器在 s8 就和 s8 比，不是和发起连接的那台比', () => {
  const ok = { rc: 0, out: '580.142', lines: ['580.142'] }
  assert.equal(judgeCheck(BY_ID.get('gpu'), ok, ctxOf({ hostDriver: '580.142' })).status, 'pass')
  // 同一份输出，如果宿主是 s0 的 580.126.09 就是 fail —— 这正是之前手工排查犯的错
  assert.equal(judgeCheck(BY_ID.get('gpu'), ok, ctxOf({ hostDriver: '580.126.09', member: 's0' })).status, 'fail')
})

test('宿主自己读不到卡时归因宿主，不冤枉容器', () => {
  const r = judgeCheck(BY_ID.get('gpu'), FX.gpu, ctxOf({ hostDriver: '', hostDriverBroken: true, hostNvmlError: 'Unable to determine the device handle for GPU0000:1F:00.0: Unknown Error' }))
  assert.equal(r.status, 'fail')
  assert.match(r.detail, /宿主机自己/)
  assert.ok(r.commands.some((c) => /reboot/.test(c)))
})

test('uvm 主编号：和所在成员一致就通过（teacher-demo 的 510 = s8 的 510）', () => {
  assert.equal(judgeCheck(BY_ID.get('nodes'), FX.nodes, ctxOf()).status, 'pass')
  const stale = judgeCheck(BY_ID.get('nodes'), FX.nodes, ctxOf({ hostUvmMajor: 508 }))
  assert.equal(stale.status, 'fail')
  assert.match(stale.detail, /510/)
  assert.ok(stale.commands.some((c) => c.includes('mknod -m 666 /dev/nvidia-uvm c 508 0')), '要给当前主编号')
  assert.ok(stale.commands.some((c) => c.includes('lxc device add teacher-demo nvidia-uvm')))
})

test('CUDA 目录空 = NAS 没挂上，报出来要指向成员', () => {
  const r = judgeCheck(BY_ID.get('cuda'), { rc: 0, lines: ['OK /usr/local/cuda-11.6', 'EMPTY /usr/local/cuda-12.6'] }, ctxOf())
  assert.equal(r.status, 'fail')
  assert.match(r.detail, /cuda-12\.6/)
  assert.match(r.detail, /s8/)
})

test('根盘 91.6% 判 fail 并给扩容命令', () => {
  const line = 'local/containers/x 525428224 481249280 44178944 92% /'
  const r = judgeCheck(BY_ID.get('disk'), { rc: 0, lines: line.split(/\s+/).length ? [line] : [] }, ctxOf({ quotaBytes: 500 * 1024 ** 3, quotaPercent: 91.6 }))
  assert.equal(r.status, 'fail')
  assert.equal(r.commands[0], 'lxc config device set teacher-demo root size=625GiB')
})

test('停着的容器一律 skip，不算故障', () => {
  const r = judgeCheck(BY_ID.get('gpu'), { rc: 1, lines: ['Error: Instance is not running'] }, ctxOf({ containerStatus: 'Stopped' }))
  assert.equal(r.status, 'skip')
  assert.match(r.detail, /lxc start/)
})

test('出网不通给手册那两行代理命令', () => {
  const r = judgeCheck(BY_ID.get('net'), { rc: 0, lines: ['DNS=ok', 'HTTP=fail', 'curl: (60) SSL certificate problem'] }, ctxOf())
  assert.equal(r.status, 'fail')
  assert.ok(r.commands.some((c) => c.includes('export http_proxy="http://192.168.1.18:7899"')))
  assert.ok(r.commands.some((c) => c.includes('unset http_proxy')))
})

test('sshd 没跑 / PasswordAuthentication 不是 yes', () => {
  assert.equal(judgeCheck(BY_ID.get('ssh'), { rc: 0, lines: ['RUN=0', 'PASSAUTH=unknown'] }, ctxOf()).status, 'fail')
  const warn = judgeCheck(BY_ID.get('ssh'), { rc: 0, lines: ['RUN=2', 'passwordauthentication no'] }, ctxOf())
  assert.equal(warn.status, 'warn')
})

test('判定汇总：一项都没跑时不能算通过', () => {
  assert.equal(rollUp([]), 'skip')
})

test('判定汇总：fail 优先于 warn，全 skip 才是 skip', () => {
  assert.equal(rollUp([{ status: 'warn' }, { status: 'fail' }]), 'fail')
  assert.equal(rollUp([{ status: 'pass' }, { status: 'warn' }]), 'warn')
  assert.equal(rollUp([{ status: 'skip' }]), 'skip')
  assert.equal(rollUp([{ status: 'pass' }]), 'pass')
})

test('安装器挑选：s0 走 V100，其余按宿主版本，绝不清空', () => {
  assert.equal(pickInstaller({ member: 's0', hostDriver: '580.126.09', installers: ctxOf().installers }), '/home/ubuntu/shared/NVIDIA-Linux-x86_64-V100.run')
  assert.equal(pickInstaller({ member: 's5', hostDriver: '550.100', installers: ctxOf().installers }), '/home/ubuntu/shared/NVIDIA-Linux-x86_64-2.run')
  assert.equal(pickInstaller({ member: 's8', hostDriver: '580.142', installers: ctxOf().installers }), '/home/ubuntu/shared/NVIDIA-Linux-x86_64-580.142.run')
  assert.equal(pickInstaller({ member: 's8', hostDriver: '580.142', installers: [] }), null)
})

test('真机整份输出跑完：GPU fail、其余 pass', () => {
  const ctx = ctxOf()
  const results = CHECKS.filter((c) => !c.optIn).map((c) => ({ id: c.id, ...judgeCheck(c, FX[c.id] || { rc: null, lines: [] }, ctx) }))
  assert.equal(results.find((r) => r.id === 'gpu').status, 'fail')
  for (const r of results.filter((x) => x.id !== 'gpu')) {
    assert.equal(r.status, 'pass', `${r.id} 期望 pass，实际 ${r.status}: ${r.detail}`)
  }
  assert.equal(rollUp(results), 'fail')
})

console.log('\n集群与显卡（增量 2 的解析与聚合）')
const {
  parseClusterMembers, parseSnap, parseTimeFacts, buildClusterView,
} = await import('../server/cluster.mjs')
const {
  parseGpuDevices, parseComputeApps, parseHostUvm, parseProfileSources, parseProfiles,
  buildProfileAudit, buildGpuView, buildDriverMatrix,
} = await import('../server/gpu.mjs')
const { parseProtoAddr, proxyPortsOf } = await import('../server/lxd.mjs')

// 2026-10-18 真机样本（s0，7 节点集群）
const MEMBERS_JSON = '[{"architecture":"x86_64","database":false,"message":"Fully operational","roles":[],"server_name":"s3","status":"Online","url":"https://192.168.1.13:8443"},'
  + '{"architecture":"x86_64","database":true,"message":"Fully operational","roles":["database-standby"],"server_name":"s4","status":"Online","url":"https://192.168.1.14:8443"},'
  + '{"architecture":"x86_64","database":true,"message":"Fully operational","roles":["database"],"server_name":"s6","status":"Online","url":"https://192.168.1.16:8443"},'
  + '{"architecture":"x86_64","database":true,"message":"Fully operational","roles":["database-leader","database"],"server_name":"s8","status":"Online","url":"https://192.168.1.18:8443"},'
  + '{"architecture":"x86_64","database":false,"message":"Fully operational","roles":[],"server_name":"s0","status":"Online","url":"https://192.168.1.10:8443"}]'

test('成员表：leader、投票者、standby、无角色都分得清', () => {
  const ms = parseClusterMembers(MEMBERS_JSON)
  assert.equal(ms.length, 5)
  const byName = new Map(ms.map((m) => [m.name, m]))
  assert.equal(byName.get('s8').leader, true)
  assert.equal(byName.get('s8').voter, true, 'leader 同时应是投票者')
  assert.equal(byName.get('s6').voter, true)
  assert.equal(byName.get('s4').standby, true)
  assert.equal(byName.get('s0').voter, false, 's0 不带角色，不参与 quorum')
  assert.equal(byName.get('s0').roles.length, 0)
  assert.equal(parseClusterMembers('{坏的 json').length, 0, '读不到要返回空，别抛')
})

test('snap 解析：只认没 disabled 的那份，且能看出有没有 held', () => {
  const rows = parseSnap([
    'lxd     5.0.2-838e1b2  24322  5.0/stable     canonical**  disabled,held',
    'lxd     5.0.4-497fe1e  31333  5.0/stable     canonical**  held',
    'core20  20230622       1974   latest/stable  canonical**  base',
  ])
  assert.equal(rows.length, 2, '非 lxd 的行不能进来')
  const active = rows.find((s) => !s.disabled)
  assert.equal(active.version, '5.0.4-497fe1e')
  assert.equal(active.held, true)
  assert.equal(rows.find((s) => s.disabled).held, true)
})

test('时间事实：读不到时留 null，不当成"没同步"', () => {
  assert.equal(parseTimeFacts(['epoch=1792329797', 'tz=CST', 'ntp=yes', 'boot=2026-10-18 12:05:22']).ntpSynchronized, true)
  assert.equal(parseTimeFacts(['epoch=1', 'ntp=no']).ntpSynchronized, false)
  assert.equal(parseTimeFacts(['epoch=1']).ntpSynchronized, null)
})

test('nvidia-smi 每张卡一行都能解析', () => {
  const g = parseGpuDevices([
    '0, GPU-5cf8, Tesla V100-PCIE-16GB, 580.126.09, 16384 MiB, 1617 MiB, 18 %, 28, 40.45 W',
    '1, GPU-22ed, Tesla V100-PCIE-16GB, 580.126.09, 16384 MiB, 5 MiB, 0 %, 24, N/A',
  ])
  assert.equal(g.length, 2)
  assert.equal(g[0].driverVersion, '580.126.09')
  assert.equal(g[0].memoryTotalBytes, 16384 * 1024 * 1024)
  assert.equal(g[0].memoryUsedBytes, 1617 * 1024 * 1024)
  assert.equal(g[0].utilPercent, 18)
  assert.equal(g[0].temperatureC, 28)
  assert.equal(g[0].powerWatts, 40.45)
  assert.equal(g[1].powerWatts, null, 'N/A 不能变成 0')
})

test('GPU 进程归属：cgroup 里的 lxc.payload 就是容器名', () => {
  const rows = parseComputeApps([
    '@@A 633366| GPU-5cf8| 1608 MiB|/lxc.payload.studentB-26002/user.slice/user-1000.slice/session-37.scope',
    '@@A 777| GPU-22ed| 512 MiB|/system.slice/docker-abc.scope',
  ])
  assert.equal(rows[0].container, 'studentB-26002')
  assert.equal(rows[0].usedBytes, 1608 * 1024 * 1024)
  assert.equal(rows[1].container, null, '不在容器里的进程不能乱归给别人')
})

test('buildGpuView：同容器多进程合成一行，宿主坏了要标出来', () => {
  const view = buildGpuView({
    GPUDEV: ['0, GPU-a, Tesla V100, 580.126.09, 16384 MiB, 1617 MiB, 30 %, 31, 60.00 W',
      '1, GPU-b, Tesla V100, 580.126.09, 16384 MiB, 1617 MiB, 20 %, 30, 50.00 W'],
    GPUCOMPUTE: [
      '@@A 11| GPU-a| 800 MiB|/lxc.payload.foo-1/user.slice',
      '@@A 22| GPU-b| 900 MiB|/lxc.payload.foo-1/user.slice',
    ],
    HOSTUVM: ['508 nvidia-uvm', '/dev/nvidia-uvm 1fc'],
  })
  assert.equal(view.driverVersion, '580.126.09')
  assert.equal(view.hostBroken, false)
  assert.equal(view.users.length, 1, '两个进程同属一个容器，只算一个使用者')
  assert.equal(view.users[0].container, 'foo-1')
  assert.deepEqual(view.users[0].gpuIndexes, [0, 1])
  assert.equal(view.uvmProcMajor, 508)
  assert.equal(view.uvmNodeMajor, 0x1fc, 'stat 的 %t 是十六进制')
  assert.equal(view.uvmConsistent, true)

  const broken = buildGpuView({ GPUDEV: ['Unable to determine the device handle for GPU0000:1F:00.0: Unknown Error'], GPUCOMPUTE: [], HOSTUVM: [] })
  assert.equal(broken.hostBroken, true, '宿主 nvidia-smi 坏了必须标出来，否则会上面所有容器都被冤枉')
  assert.equal(broken.gpus.length, 0)
})

test('profile 体检：gputype 拼写错误和缺失挂载源都能抓到', () => {
  const profiles = parseProfiles('[{"name":"default","config":{"limits.cpu.allowance":"90%"},"description":"","devices":{"gpu":{"type":"gpu","gputype":"physcial"},"cuda126":{"type":"disk","source":"/mnt/nas/CUDA/cuda-12.6"}},"used_by":["/1.0/instances/a"]}]')
  const sources = parseProfileSources(['@@S /mnt/nas/CUDA/cuda-12.6\tOK', '@@S /mnt/nas/shared\tMISS'])
  const audit = buildProfileAudit(profiles, sources)
  assert.ok(audit.issues.some((i) => /physcial/.test(i.title)), '拼写错误要报')
  assert.ok(audit.issues.some((i) => i.level === 'critical' && /mnt\/nas\/shared/.test(i.detail)), '缺挂载源要报严重')
  assert.deepEqual(audit.missingSources, ['/mnt/nas/shared'])
  assert.ok(audit.info.some((i) => /limits.cpu.allowance/.test(i.title)))
  // 写对了就不该报
  const good = buildProfileAudit([{ name: 'default', config: {}, devices: { gpu: { type: 'gpu', gputype: 'physical' } } }], [{ path: '/x', exists: true }])
  assert.equal(good.issues.length, 0)
})

const fakeHost = (id, over = {}) => ({
  id,
  status: 'ok',
  uptimeSeconds: 3600,
  clockSkewSeconds: 0,
  time: { epoch: 1792329797, tz: 'CST', ntpSynchronized: true },
  snap: [{ version: '5.0.4-x', disabled: false, held: true }],
  lxd: { lxcVersion: '5.0.4', clusterMembers: parseClusterMembers(MEMBERS_JSON) },
  gpu: { driverVersion: '580.142', gpus: [{ index: 0 }], users: [] },
  ...over,
})

test('集群聚合：三套驱动会告警，leader 掉线报严重', () => {
  const recs = [
    fakeHost('s0'),
    fakeHost('s3', { gpu: { driverVersion: '550.100', gpus: [], users: [] } }),
    fakeHost('s8', { lxd: { lxcVersion: '5.0.3', clusterMembers: parseClusterMembers(MEMBERS_JSON) } }),
  ]
  const [c] = buildClusterView(recs)
  assert.equal(c.members.length, 5, '成员表以集群为准，不是以采到的台数为准')
  assert.equal(c.leader, 's8')
  assert.equal(c.voters.length, 2, 's6 和 s8 是投票者')
  assert.deepEqual(c.drivers.sort(), ['550.100', '580.142'])
  assert.ok(c.alerts.some((a) => /驱动有 2 套/.test(a.text)), '同集群多驱动要告警')
  assert.ok(c.alerts.some((a) => /LXD 版本不一致/.test(a.text)))

  const offline = [fakeHost('s0'), fakeHost('s8', { lxd: { lxcVersion: '5.0.4', clusterMembers: parseClusterMembers(MEMBERS_JSON).map((m) => (m.name === 's8' ? { ...m, status: 'Offline' } : m)) } })]
  const [c2] = buildClusterView(offline)
  assert.ok(c2.alerts.some((a) => a.level === 'critical'), 'leader 不在线必须是严重')

  const unheld = [fakeHost('s0', { snap: [{ version: '5.0.4', disabled: false, held: false }], time: { epoch: 1, ntpSynchronized: false } })]
  const [c3] = buildClusterView(unheld)
  assert.ok(c3.alerts.some((a) => /held/.test(a.text)))
  assert.ok(c3.alerts.some((a) => /没在同步时间/.test(a.text)))
})

test('时钟偏差用"和本机同一时刻比"，不是各台自报时间互减', () => {
  const recs = [fakeHost('s0', { clockSkewSeconds: 0 }), fakeHost('s3', { clockSkewSeconds: 8 })]
  const [c] = buildClusterView(recs)
  assert.equal(c.worstSkew, 8)
  assert.equal(c.clockSpreadSeconds, 8)
  assert.ok(c.alerts.some((a) => /时钟偏差最大 \+8 秒/.test(a.text)))
})

test('驱动矩阵：跨台汇总版本集合与一致性', () => {
  const m = buildDriverMatrix([
    fakeHost('s0', { gpu: { driverVersion: '580.126.09', gpus: [{ index: 0 }, { index: 1 }], users: [{ container: 'a-1' }] } }),
    fakeHost('s3', { gpu: { driverVersion: '580.142', gpus: [{ index: 0 }], users: [] } }),
    { id: 's9', status: 'error', gpu: null, lxd: null },
  ])
  assert.deepEqual(m.versions, ['580.126.09', '580.142'])
  assert.equal(m.consistent, false)
  assert.equal(m.rows.length, 3)
  assert.equal(m.rows.find((r) => r.id === 's0').gpuCount, 2)
  assert.equal(m.rows.find((r) => r.id === 's0').busyContainers, 1)
})

test('proxy 设备解析出监听/目标地址，供端口台账用', () => {
  assert.deepEqual(parseProtoAddr('tcp:192.168.1.18:1018'), { host: '192.168.1.18', port: 1018 })
  assert.deepEqual(parseProtoAddr('tcp:[::1]:8080'), { host: '::1', port: 8080 })
  assert.equal(parseProtoAddr('乱七八糟'), null)
  const ports = proxyPortsOf({
    proxy0: { type: 'proxy', bind: 'host', listen: 'tcp:192.168.1.18:1018', connect: 'tcp:240.18.0.179:22' },
    root: { type: 'disk', pool: 'local' },
  })
  assert.equal(ports.length, 1)
  assert.deepEqual({ ...ports[0] }, { device: 'proxy0', bind: 'host', listenHost: '192.168.1.18', listenPort: 1018, connectHost: '240.18.0.179', connectPort: 22 })
})

test('实例 JSON 里的 devices / last_used_at 被保留下来', () => {
  const [inst] = parseInstances('[{"name":"a-1","location":"s0","status":"Running","last_used_at":"2026-10-18T04:00:00Z","devices":{"proxy0":{"type":"proxy","listen":"tcp:192.168.1.10:24001","connect":"tcp:240.10.0.9:22"}},"expanded_devices":{"proxy0":{"type":"proxy","listen":"tcp:192.168.1.10:24001","connect":"tcp:240.10.0.9:22"},"gpu":{"type":"gpu"}},"config":{},"expanded_config":{"limits.cpu.allowance":"90%"},"state":{}}]')
  assert.equal(inst.lastUsedAt, '2026-10-18T04:00:00Z')
  assert.equal(Object.keys(inst.devices).length, 1)
  assert.equal(inst.limits.cpuAllowance, '90%')
})

test('采集脚本新增了集群/显卡这些段，且仍然没有 JS 插值残留', () => {
  const s = buildRemoteScript({ scanNas: false, withLxd: true, execFallback: true })
  for (const sec of ['CLUSTERMEM', 'PROFILES', 'PROFSRC', 'SNAP', 'TIME', 'HOSTUVM', 'GPUDEV', 'GPUCOMPUTE']) {
    assert.ok(s.includes(`echo "$S:${sec}"`), `缺段 ${sec}`)
  }
  assert.equal(s.includes('undefined'), false)
  assert.equal(/\$\{(?!\()/.test(s.replace(/\\$/g, '')), false, '不该有 JS 插值痕迹')
  assert.ok(s.includes('sed -n \'s/^[Ss]erver version:'), 'LXD 版本要从文本里取，不能用 --format=json')
})

test('采集脚本：每个段的输出必须自带换行（printf 不带换行会把下一段的标记粘过来）', () => {
  const s = buildRemoteScript({ scanNas: false, withLxd: false, execFallback: false })
  assert.equal(/printf "%d", \$1\}' \/proc\/uptime/.test(s), false, 'UPTIME 不能用不带换行的 printf')
  assert.ok(/echo "\$S:UPTIME"; awk '\{print int\(\$1\)\}' \/proc\/uptime/.test(s), 'UPTIME 要用会换行的 print')
  // 逐个检查：紧跟在 echo "$S:X" 之后的命令，不允许出现 printf 不带 \n 的写法
  const bad = (s.match(/echo "\$S:[A-Z]+";[^\n]*printf "(?!.*\\n)[^"]*"/g) || []).filter((m) => !m.includes('\\n'))
  assert.deepEqual(bad, [], `这些段的输出不带换行：${bad.join(' | ')}`)
})

test('段的输出被粘住时的表现（回归当时那个 bug 的形状）', () => {
  const glued = '@@SEC:UPTIME\n34486@@SEC:IDENTITY\n0\nuser=s0\n'
  const sections = splitSections(glued)
  assert.equal(sections.IDENTITY, undefined, '标记被粘住时下一段确实会丢 —— 所以必须换行')
  assert.equal(Number(sections.UPTIME[0]), NaN)
  const clean = splitSections('@@SEC:UPTIME\n34486\n@@SEC:IDENTITY\n0\nuser=s0\n')
  assert.equal(Number(clean.UPTIME[0]), 34486)
  assert.deepEqual(clean.IDENTITY, ['0', 'user=s0'])
})

console.log('\n端口台账与配额建议（增量 3）')
const net = await import('node:net')
const {
  buildPortLedger, buildListenCheckScript, parseListenCheck, classifyLedger, conclude,
  memberIpMap, probePort, extractIpv4, expectedSegment, buildIpCheckScript, parseIpCheck,
  evaluateIpChecks, reconcileIpCheck,
} = await import('../server/ports.mjs')
const { quotaLevel, suggestQuotaGiB, buildQuotaAdvice } = await import('../server/quota.mjs')

const GiB = 1024 ** 3
const portRec = (id, ip, containers) => ({
  id,
  status: 'ok',
  lxd: {
    pool: { name: 'local', totalBytes: 1000 * GiB, usedBytes: 700 * GiB, availBytes: 300 * GiB, usedPercent: 70 },
    containers,
    clusterMembers: [{ name: id, url: `https://${ip}:8443`, status: 'Online', roles: [] }],
    clusterKey: id,
    orphanDatasets: [],
    totals: { orphanSumBytes: 0 },
  },
})
const ctn = (name, host, ports, over = {}) => ({
  name, owner: name.split('-')[0], location: host, status: 'Running',
  usedBytes: over.usedBytes ?? 10 * GiB, quotaBytes: over.quotaBytes ?? 500 * GiB,
  usedPercent: over.usedPercent ?? 2, source: 'zfs',
  proxyPorts: ports.map(([device, listenPort, connectPort]) => ({
    device, bind: 'host', listenHost: '', listenPort, connectHost: '240.10.0.9', connectPort: connectPort || 22,
  })).map((p) => ({ ...p, listenHost: host === 's0' ? '192.168.1.10' : '192.168.1.18' })),
})

test('台账：SSH 端口给 ubuntu 登录命令，多端口容器逐条列，没端口的单独列出来', () => {
  const recs = [
    portRec('s0', '192.168.1.10', [
      ctn('a-1', 's0', [['proxy0', 24001]]),
      ctn('a-2', 's0', [['proxy0', 24002], ['proxy1', 34508, 34508]]),
      ctn('template', 's0', []),
    ]),
  ]
  const led = buildPortLedger(recs, { expected: [], memberIps: memberIpMap(recs) })
  assert.equal(led.summary.total, 3)
  assert.equal(led.summary.ssh, 2)
  assert.equal(led.summary.service, 1, 'connect 端口不是 22 的算服务')
  assert.deepEqual(led.containersWithoutPort.map((c) => c.container), ['template'])
  assert.equal(led.rows[0].sshCmd, 'ssh ubuntu@10.0.0.10 -p 24001')
  assert.equal(led.conflicts.length, 0)
})

test('台账：外部端口撞车与 listen 地址不符都能判出来', () => {
  const recs = [portRec('s0', '192.168.1.10', [
    ctn('a-1', 's0', [['proxy0', 25000]]),
    ctn('b-2', 's0', [['proxy0', 25000]]),
  ])]
  const led = buildPortLedger(recs, { expected: [], memberIps: memberIpMap(recs) })
  assert.equal(led.conflicts.length, 1)
  assert.equal(led.conflicts[0].port, 25000)
  assert.equal(led.conflicts[0].containers.length, 2)

  // 人已经迁到 s8，listen 还写着 s0 的内部地址（手册特别提醒过的那个坑）
  const stale = ctn('a-1', 's8', [['proxy0', 24001]])
  stale.location = 's8'
  stale.proxyPorts[0].listenHost = '192.168.1.10'
  const moved = portRec('s8', '192.168.1.18', [stale])
  const led2 = buildPortLedger([moved], { expected: [], memberIps: memberIpMap([moved]) })
  assert.equal(led2.rows[0].listenMismatch, true, 'listen 地址与新成员不符要标出来（手册：迁移后 listen/connect 都要改）')
})

test('成员侧监听表脚本：只接受合法端口，输出能解析', () => {
  const script = buildListenCheckScript([23034, 24002, '坏东西; rm -rf /', 0])
  assert.ok(script.includes('for p in 23034 24002; do'), '非法端口不能进脚本')
  assert.equal(script.includes('rm'), false)
  const found = parseListenCheck(['LISTEN 23034', 'DOWN 24002', '噪声行'])
  assert.equal(found.get(23034), true)
  assert.equal(found.get(24002), false)
  assert.equal(found.size, 2)
})

test('定责：外部不通 + LXD 在听 = 缺路由器转发；外部不通 + LXD 没听 = proxy 没生效', () => {
  const base = { container: 'x-1', host: 's0', listenHost: '192.168.1.10', listenPort: 23034, connectPort: 22, status: 'Running', kind: 'ssh' }
  const rows = [
    { ...base, state: 'refused' },
    { ...base, container: 'y-1', listenPort: 24001, state: 'closed' },
    { ...base, container: 'z-1', listenPort: 24002, state: 'open' },
  ]
  const diag = new Map([['s0|23034', { listening: true, checked: true }], ['s0|24001', { listening: false, checked: true }]])
  const out = conclude(rows, diag)
  assert.equal(out[0].verdict, 'no_forward')
  assert.match(out[0].advice, /转发/)
  assert.ok(out[0].commands.some((c) => /luci/.test(c)), '要给出转发改哪儿的指引')
  assert.equal(out[1].verdict, 'no_listener')
  assert.match(out[1].advice, /根本没有进程在听/)
  assert.equal(out[2].verdict, 'ok')
})

test('探测：本地起个监听就能测出 open，关掉就是 refused/unreachable', async () => {
  const server = net.createServer()
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const port = server.address().port
  const open = await probePort(port, { host: '127.0.0.1', timeout: 2000 })
  assert.equal(open.state, 'open')
  assert.ok(open.ms < 2000)
  await new Promise((res) => server.close(res))
  const closed = await probePort(port, { host: '127.0.0.1', timeout: 2000 })
  assert.ok(['refused', 'unreachable', 'timeout'].includes(closed.state), `端口关了不该报 open，实际 ${closed.state}`)
})

test('classifyLedger 把探测状态并回台账并计数', () => {
  const led = { rows: [{ container: 'a', listenPort: 1, state: undefined }], summary: {} }
  const probes = new Map([[1, { port: 1, state: 'open', ms: 5 }]])
  const out = classifyLedger(led, probes)
  assert.equal(out.rows[0].state, 'open')
  assert.equal(out.counts.open, 1)
})

test('配额：阈值分级、建议向上取整到 50GiB', () => {
  assert.equal(quotaLevel(91.6), 'critical')
  assert.equal(quotaLevel(89.6), 'warn')
  assert.equal(quotaLevel(73), 'ok')
  assert.equal(quotaLevel(null), 'unknown')
  assert.equal(suggestQuotaGiB(458 * GiB, 500 * GiB), 650, '458GiB/500GiB → 至少 650')
  assert.equal(suggestQuotaGiB(10 * GiB, 50 * GiB), 100, '一律向上取到 50GiB 的整数倍（配额是上限，不是预占，取整无所谓浪费）')
  assert.equal(suggestQuotaGiB(0, 0), 50, '下限 50GiB')
})

test('配额建议：只有到线的行才给扩容命令，池不够时会标出来', () => {
  const recs = [portRec('s0', '192.168.1.10', [
    ctn('full-1', 's0', [['proxy0', 1]], { usedPercent: 92, usedBytes: 460 * GiB }),
    ctn('warn-2', 's0', [['proxy0', 2]], { usedPercent: 85, usedBytes: 425 * GiB }),
    ctn('fine-3', 's0', [['proxy0', 3]], { usedPercent: 40, usedBytes: 200 * GiB }),
  ])]
  const advice = buildQuotaAdvice(recs)
  assert.equal(advice.summary.critical, 1)
  assert.equal(advice.summary.warn, 1)
  const full = advice.rows.find((r) => r.container === 'full-1')
  assert.equal(full.commands[0], 'lxc config device set full-1 root size=650GiB')
  assert.equal(advice.rows.find((r) => r.container === 'fine-3').commands.length, 0, '没到线不该给命令')
  assert.equal(advice.rows.find((r) => r.container === 'fine-3').suggestedGiB, null)

  // 池只剩 100GiB 时，+150GiB 的扩容装不下
  const tight = portRec('s8', '192.168.1.18', [ctn('full-9', 's8', [['proxy0', 9]], { usedPercent: 95, usedBytes: 475 * GiB })])
  tight.lxd.pool.availBytes = 100 * GiB
  const a2 = buildQuotaAdvice([tight])
  const row = a2.rows.find((r) => r.container === 'full-9')
  assert.equal(row.fitsInPool, false)
  assert.equal(a2.blocked.length, 1, '要列出扩不动的那些')

  assert.equal(advice.pools[0].host, 's0')
  assert.equal(advice.pools[0].usedPercent, 70)
})

console.log('\n转发目标 IP 与容器实际 IP 核对')

test('IP 提取会滤掉回环和 Docker 网桥，只留业务地址', () => {
  assert.deepEqual(extractIpv4('172.17.0.1 240.10.0.211 127.0.0.1'), ['240.10.0.211'])
  assert.deepEqual(extractIpv4(''), [])
  assert.deepEqual(extractIpv4('Error: instance is not running'), [])
  assert.equal(expectedSegment('192.168.1.18'), 18)
  assert.equal(expectedSegment(''), null)
})

test('IP 核对脚本：名字白名单，且退出码不被管道吞掉', () => {
  const sh = buildIpCheckScript(['a-1', 'b-2', '坏名字; rm -rf /'])
  assert.ok(sh.includes('for n in a-1 b-2; do'), '非法名字不能进脚本')
  assert.equal(sh.includes('rm'), false)
  assert.ok(sh.includes('  rc=$?'), '必须保留 lxc exec 的退出码')
  assert.equal(/out=\$\(lxc exec[^\n]*\| head/.test(sh), false, 'head 不能放在命令替换里')
  assert.ok(sh.includes('head -1'), '取第一行要在赋值之后做')
  assert.equal(buildIpCheckScript([]), 'true')
})

test('IP 输出解析：名字/退出码/内容三段，空内容也算一条', () => {
  const m = parseIpCheck(['@@IP bravo-26004\t0\t240.18.0.17 ', '@@IP demo-516\t0\t', '@@IP gone-1\t1\tError: instance is not running', '噪声'])
  assert.equal(m.size, 3)
  assert.equal(m.get('bravo-26004').raw, '240.18.0.17')
  assert.equal(m.get('demo-516').raw, '')
  assert.equal(m.get('gone-1').rc, 1)
})

const ipLedger = (rows) => ({ rows: rows.map((r) => ({ device: 'proxy0', listenPort: r.listenPort, connectPort: 22, host: r.host, ...r })) })

test('IP 判定：一致 / 不一致 / 容器没 IP / 读不到', () => {
  const led = ipLedger([
    { container: 'ok-1', host: 's0', connectHost: '240.10.0.9', listenPort: 24001 },
    { container: 'bad-1', host: 's0', connectHost: '240.10.0.10', listenPort: 24002 },
    { container: 'noip-1', host: 's0', connectHost: '240.10.0.11', listenPort: 24003 },
    { container: 'gone-1', host: 's0', connectHost: '240.10.0.12', listenPort: 24004 },
  ])
  const ipMap = new Map([
    ['ok-1', { rc: 0, raw: '172.17.0.1 240.10.0.9' }],
    ['bad-1', { rc: 0, raw: '240.10.0.77' }],
    ['noip-1', { rc: 0, raw: '' }],
    ['gone-1', { rc: 1, raw: 'Error: instance is not running' }],
  ])
  const out = evaluateIpChecks(led, ipMap, new Map([['s0', '192.168.1.10']]))
  const by = new Map(out.rows.map((r) => [r.container, r]))
  assert.equal(by.get('ok-1').ipVerdict, 'match')
  assert.equal(by.get('bad-1').ipVerdict, 'mismatch')
  assert.match(by.get('bad-1').ipDetail, /240\.10\.0\.77/)
  assert.ok(by.get('bad-1').ipFix.some((c) => c.includes('lxc config device set bad-1 proxy0 connect tcp:240.10.0.77:22')))
  assert.equal(by.get('noip-1').ipVerdict, 'no_ip')
  assert.match(by.get('noip-1').ipDetail, /没有全局 IPv4/)
  assert.equal(by.get('gone-1').ipVerdict, 'unknown')
  assert.equal(out.counts.match, 1)
  assert.equal(out.mismatches.length, 2)
})

test('IP 判定：两个容器地址互换时能指出来，两边都要改', () => {
  const led = ipLedger([
    { container: 'a-1', host: 's0', connectHost: '240.10.0.76', listenPort: 23802 },
    { container: 'b-2', host: 's0', connectHost: '240.10.0.77', listenPort: 26004 },
  ])
  const ipMap = new Map([
    ['a-1', { rc: 0, raw: '240.10.0.77' }],
    ['b-2', { rc: 0, raw: '240.10.0.76' }],
  ])
  const out = evaluateIpChecks(led, ipMap, new Map([['s0', '192.168.1.10']]))
  const a = out.rows.find((r) => r.container === 'a-1')
  const b = out.rows.find((r) => r.container === 'b-2')
  assert.equal(a.ipVerdict, 'swap')
  assert.equal(a.ipSwapWith, 'b-2')
  assert.equal(b.ipSwapWith, 'a-1')
  assert.ok(a.ipFix.some((c) => /b-2/.test(c)), '要提醒对方也指着旧地址')
  assert.equal(out.counts.swap, 2)
})

test('IP 判定：同一目标被两个账户共用时要标出来', () => {
  const led = ipLedger([
    { container: 'right-1', host: 's2', connectHost: '240.12.0.251', listenPort: 26201 },
    { container: 'wrong-1', host: 's2', connectHost: '240.12.0.251', listenPort: 23216 },
  ])
  const ipMap = new Map([
    ['right-1', { rc: 0, raw: '240.12.0.251' }],
    ['wrong-1', { rc: 0, raw: '240.12.0.252' }],
  ])
  const out = evaluateIpChecks(led, ipMap, new Map([['s2', '192.168.1.12']]))
  const wrong = out.rows.find((r) => r.container === 'wrong-1')
  // 目标地址属于另一个容器、但对方没指回来 —— 不是"互换"，是"串到别人"
  assert.equal(wrong.ipVerdict, 'other')
  assert.equal(wrong.ipSwapWith, 'right-1')
  assert.deepEqual(wrong.targetSharedWith, ['right-1'])
})

test('IP 判定：没跑过 exec 时靠网段也能看出迁移没改 connect', () => {
  const led = ipLedger([{ container: 'moved-1', host: 's3', connectHost: '240.10.0.5', listenPort: 25010 }])
  const out = evaluateIpChecks(led, new Map(), new Map([['s3', '192.168.1.13']]))
  assert.equal(out.rows[0].ipVerdict, 'segment')
  assert.match(out.rows[0].ipDetail, /240\.10\.x/)
  assert.ok(out.rows[0].ipFix.some((c) => c.includes('hostname -I')))
})

test('核对结论要按当前台账校正：改好的算一致、改坏的算过期、删掉的丢弃', () => {
  const cached = {
    ranAt: '2026-10-24T16:33:50.262Z',
    rows: [
      { container: 'fixed-1', listenPort: 1, connectHost: '240.10.0.76', actualIps: ['240.10.0.77'], ipVerdict: 'swap', ipDetail: '旧结论', ipFix: ['x'] },
      { container: 'same-1', listenPort: 2, connectHost: '240.10.0.9', actualIps: ['240.10.0.9'], ipVerdict: 'match', ipDetail: '一致' },
      { container: 'stale-1', listenPort: 3, connectHost: '240.10.0.5', actualIps: ['240.10.0.6'], ipVerdict: 'mismatch', ipDetail: '旧结论' },
      { container: 'gone-1', listenPort: 4, connectHost: '240.10.0.7', actualIps: ['240.10.0.8'], ipVerdict: 'mismatch', ipDetail: '已删' },
    ],
    counts: { swap: 1, match: 1, mismatch: 2 },
    mismatches: [{}, {}, {}],
  }
  const current = [
    { container: 'fixed-1', listenPort: 1, connectHost: '240.10.0.77', listenHost: '192.168.1.10' },
    { container: 'same-1', listenPort: 2, connectHost: '240.10.0.9', listenHost: '192.168.1.10' },
    { container: 'stale-1', listenPort: 3, connectHost: '240.10.0.99', listenHost: '192.168.1.10' },
  ]
  const out = reconcileIpCheck(cached, current)
  const by = new Map(out.rows.map((r) => [r.container, r]))
  // 按提示改过的：现在是实际 IP，判一致并说明是核对后改的
  assert.equal(by.get('fixed-1').ipVerdict, 'match')
  assert.equal(by.get('fixed-1').reconcile, 'fixed')
  assert.match(by.get('fixed-1').ipDetail, /核对之后改过/)
  assert.equal(by.get('same-1').ipVerdict, 'match')
  // 又改坏了：不算错，但要求重新核对
  assert.equal(by.get('stale-1').ipVerdict, 'stale')
  assert.match(by.get('stale-1').ipDetail, /需要重新核对/)
  // 容器没了：结论直接丢掉
  assert.equal(by.has('gone-1'), false)
  assert.equal(out.dropped, 1)
  assert.equal(out.fixed, 1)
  // 只有真正的错误才进 mismatches —— 这正是"明明一致却报错"的根因
  assert.equal(out.mismatches.length, 0)
  assert.equal(out.counts.stale, 1)
  assert.equal(out.counts.match, 2)
})

test('没有缓存时原样返回，不会把界面搞崩', () => {
  assert.deepEqual(reconcileIpCheck(null, []), { rows: [], counts: {}, mismatches: [] })
  const empty = reconcileIpCheck({ rows: [] }, [{ container: 'a', listenPort: 1 }])
  assert.deepEqual(empty.rows, [])
})

console.log('审查修复的回归断言')

test('只允许本机 Host/Origin（挡 DNS rebinding 和第三方网页）', async () => {
  const { hostAllowed, originAllowed } = await import('../server/guard.mjs')
  assert.equal(hostAllowed('127.0.0.1:8787'), true)
  assert.equal(hostAllowed('localhost:5173'), true)
  assert.equal(hostAllowed('[::1]:8787'), true)
  assert.equal(hostAllowed('evil.example.com:8787'), false)
  assert.equal(hostAllowed(''), false)
  assert.equal(originAllowed('http://localhost:5173'), true)
  assert.equal(originAllowed('http://127.0.0.1:8787'), true)
  assert.equal(originAllowed('http://evil.example.com'), false)
  assert.equal(originAllowed(undefined), true, '命令行工具不带 Origin，要放行（Host 已经挡过一轮）')
})

test('探测参数会被夹紧，负 timeout 不会把后端搞崩', async () => {
  const { clampProbeOptions } = await import('../server/ports.mjs')
  assert.deepEqual(clampProbeOptions({ timeout: -1, concurrency: 0 }), { timeout: 100, concurrency: 1 })
  assert.deepEqual(clampProbeOptions({ timeout: 999999, concurrency: 999 }), { timeout: 60000, concurrency: 32 })
  assert.deepEqual(clampProbeOptions({}), { timeout: 2500, concurrency: 8 })
})

test('未知的检查 id 要被拒绝，不能静默变成"没检查=通过"', async () => {
  const { unknownCheckIds, rollUp: roll } = await import('../server/checks.mjs')
  assert.deepEqual(unknownCheckIds(['gpu', 'bogus']), ['bogus'])
  assert.deepEqual(unknownCheckIds(undefined), [])
  assert.equal(roll([]), 'skip')
})

test('cuda 检查命令没跑成要报 error，不能算正常', () => {
  const r = judgeCheck(BY_ID.get('cuda'), { rc: 127, lines: ['sh: 1: lxc: not found'] }, ctxOf())
  assert.equal(r.status, 'error')
  assert.match(r.detail, /rc=127|没跑成/)
})

test('宿主 uvm 读不到时判"没法判断"，不能宣称一致', () => {
  const r = judgeCheck(BY_ID.get('nodes'), FX.nodes, ctxOf({ hostUvmMajor: null }))
  assert.equal(r.status, 'warn')
  assert.match(r.detail, /读不到|没法判断/)
})

test('驱动安装器路径按不可信输入过滤（防分号注入）', () => {
  const evil = '/home/ubuntu/shared/NVIDIA-Linux-x86_64-2.run; touch /tmp/pwn'
  assert.equal(pickInstaller({ member: 's8', hostDriver: '580.142', installers: [evil] }), null)
  assert.equal(pickInstaller({ member: 's8', hostDriver: '580.142', installers: ['NVIDIA-Linux-x86_64-580.142.run'] }), null, '相对路径也不收')
})

test('单台刷新要带回 cluster/drivers/summary（否则集群面板是旧值）', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf("'/api/refresh/:id'"), src.indexOf("snapshot.shared") + 400)
  for (const key of ['cluster:', 'drivers:', 'summary:']) assert.ok(seg.includes(key), `单台刷新响应缺 ${key}`)
})

await Promise.all(pending)
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}通过 ${passed}，失败 ${failed}\x1b[0m\n`)
process.exit(failed === 0 ? 0 : 1)
