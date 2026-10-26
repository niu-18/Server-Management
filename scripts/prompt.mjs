import readline from 'node:readline'

/** 交互式读一个不回显的密码；stdin 不是 TTY 时退化成普通行读取。 */
export function askHidden(text) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      rl.question(text, (a) => { rl.close(); resolve(a) })
      return
    }
    process.stdout.write(text)
    let buf = ''
    const prevRaw = process.stdin.isRaw
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    const onKey = (ch) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.removeListener('data', onKey)
        process.stdin.setRawMode(Boolean(prevRaw))
        process.stdin.pause()
        process.stdout.write('\n')
        resolve(buf)
      } else if (ch === '\u0003') {
        process.stdin.removeListener('data', onKey)
        process.stdin.setRawMode(Boolean(prevRaw))
        process.stdout.write('\n已取消\n')
        process.exit(130)
      } else if (ch === '\u007f' || ch === '\b') {
        buf = buf.slice(0, -1)
      } else if (ch.charCodeAt(0) >= 32) {
        buf += ch
        process.stdout.write('*')
      }
    }
    process.stdin.on('data', onKey)
  })
}

/**
 * 用密码或密钥建立一条 SSH 连接并跑一条命令。
 * stdin 会通过 SSH 通道喂给远端进程，所以密码既不上命令行、也不进远端进程列表。
 */
export async function sshRun(server, command, { password, privateKey, stdin, timeout = 25000 } = {}) {
  const { Client } = await import('ssh2')
  const conn = new Client()
  await new Promise((resolve, reject) => {
    conn.once('ready', resolve)
    conn.once('error', reject)
    conn.connect({
      host: server.host,
      port: server.port,
      username: server.user,
      password,
      privateKey,
      readyTimeout: timeout,
    })
  })
  try {
    return await new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(err)
        let out = ''
        let err2 = ''
        stream.on('data', (d) => (out += d))
        stream.stderr.on('data', (d) => (err2 += d))
        stream.on('close', (code) => resolve({ code, out: out.trim(), err: err2.trim() }))
        if (stdin != null) {
          stream.end(stdin)
        } else {
          stream.end()
        }
      })
    })
  } finally {
    conn.end()
  }
}
