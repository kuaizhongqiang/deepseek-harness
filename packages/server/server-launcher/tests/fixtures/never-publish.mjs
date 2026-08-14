// Fake server that never publishes a lock, so the launcher's waitForPublish
// times out. Exits on its own so a timed-out test leaves no orphan behind.

import { createServer } from 'node:http'

const server = createServer(() => {})
server.listen(0, '127.0.0.1', () => {})
setTimeout(() => process.exit(0), 4000)
