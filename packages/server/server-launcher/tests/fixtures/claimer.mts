// Concurrency driver: runs ensureServer from a child process and prints the
// result as one JSON line on stdout. Exactly one concurrent claimer may claim
// the lock and spawn the fake server; the rest attach to it.

import { fileURLToPath } from 'node:url'
import { ensureServer } from '../../src/index.ts'

const fakeServer = fileURLToPath(new URL('./fake-server.mjs', import.meta.url))

const result = await ensureServer({
  command: ['node', fakeServer],
  bootstrap: true,
  claimTimeoutMs: 20_000,
})
console.log(JSON.stringify(result))
