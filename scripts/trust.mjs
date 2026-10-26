#!/usr/bin/env node
/**
 * 管理 SSH 主机密钥记录（TOFU：首次连接记录指纹，之后不一致就拒绝连接）。
 *
 *   npm run trust                 # 看已记录的主机指纹
 *   npm run trust -- --forget s3@10.0.0.13:322
 *   npm run trust -- --forget '*'  # 全部清掉（下次连接重新记录）
 *
 * 什么时候需要 --forget：重装系统、换机器、或者确认主机密钥变更是正常的之后。
 */
import { listKnownHosts, forgetKnownHost } from '../server/ssh.mjs'

const args = process.argv.slice(2)

if (args[0] === '--forget') {
  const id = args[1]
  if (!id) {
    console.error('用法：npm run trust -- --forget <host:port>  或  --forget "*"')
    process.exit(2)
  }
  const n = forgetKnownHost(id)
  console.log(n ? `已清除 ${n} 条记录：${id}` : `没有找到记录：${id}`)
  process.exit(0)
}

const store = listKnownHosts()
const ids = Object.keys(store).sort()
if (ids.length === 0) {
  console.log('还没有记录任何主机指纹。第一次成功连接时会自动记下来（存在 .cache/known_hosts.json）。')
  process.exit(0)
}
console.log('已记录的主机指纹（.cache/known_hosts.json）：')
for (const id of ids) console.log(`  ${id}\t${store[id].fingerprint}\t${store[id].at || ''}`)
console.log('\n要清掉某个主机的记录：npm run trust -- --forget ' + ids[0])
