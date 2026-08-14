// Fake shared server for launcher tests: binds a dynamic loopback port,
// answers POST /api/host.describe with 200 (the launcher's readiness probe),
// publishes the web.lock under DSH_HOME, and records its pid in spawned.log
// so tests can count how many servers were actually spawned.

import { appendFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'

const home = process.env.DSH_HOME
if (!home) throw new Error('DSH_HOME is required for the fake server')

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/host.describe') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(0, '127.0.0.1', async () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const url = `http://127.0.0.1:${port}`
  await writeFile(join(home, 'web.lock'), JSON.stringify({ version: 1, pid: process.pid, port, url }))
  await appendFile(join(home, 'spawned.log'), `${process.pid}\n`)
})
