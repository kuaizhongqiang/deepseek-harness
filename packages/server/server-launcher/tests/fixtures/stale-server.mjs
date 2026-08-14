// Fake server that publishes a lock but answers every request with 500, so
// the launcher's health probe observes a reachable-but-unhealthy server
// (response.ok === false) — the trigger for stale-lock takeover.

import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'

const home = process.env.DSH_HOME
if (!home) throw new Error('DSH_HOME is required for the stale server')

const server = createServer((req, res) => {
  res.writeHead(500)
  res.end()
})

server.listen(0, '127.0.0.1', async () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const url = `http://127.0.0.1:${port}`
  await writeFile(join(home, 'web.lock'), JSON.stringify({ version: 1, pid: process.pid, port, url }))
})
