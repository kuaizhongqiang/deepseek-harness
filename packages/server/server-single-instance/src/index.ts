/**
 * @deepseek-ai/dsh-server-single-instance — shared-server identity.
 *
 * In the "single server" composition the desktop and VSCode clients both share
 * one `dsh` web-server process. This plugin is the server side of that
 * contract: as a Service it initializes after the injected web server has
 * bound, publishes the lock file (`~/.dsh/web.lock` by default) recording
 * `{ version, pid, port, url }`, and removes the lock on dispose. Because the
 * publish happens inside `[Service.init]`, the Loader tree only settles after
 * the lock is durable — a client that reads the lock after the server reports
 * ready is guaranteed a complete record. Clients discover the port and
 * liveness through `dsh-server-launcher`.
 */

import { unlink } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

declare module '@deepseek-ai/cordis' {
  interface Context {
    serverSingleInstance: ServerSingleInstance
  }
}

/** One published server-identity lock record. */
export interface ServerLockV1 {
  /** Format version, so future fields can be added without breaking readers. */
  version: 1
  /** The server process id. */
  pid: number
  /** The bound port; zero-port webservers report the OS-assigned value. */
  port: number
  /** Canonical loopback URL clients connect to. */
  url: string
}

/** Wire version of {@link ServerLockV1}. */
export const SERVER_LOCK_VERSION = 1 as const

/** The loopback host all shared servers bind, matching the web profile default. */
export const LOOPBACK_HOST = '127.0.0.1'

/** Default lock-file path under the harness home. */
export function defaultLockFile(): string {
  return dshHomePath('web.lock')
}

/**
 * Render the published lock body for a bound port.
 * @param port - the listening port.
 * @param pid - the owning process id (the current process by default).
 * @returns the JSON lock body, as parsed by {@link ServerLockV1}.
 */
export function renderServerLock(port: number, pid: number = process.pid): string {
  return JSON.stringify({
    version: SERVER_LOCK_VERSION,
    pid,
    port,
    url: `http://${LOOPBACK_HOST}:${port}`,
  } satisfies ServerLockV1)
}

/** Configuration for the lock publication. */
export interface Config {
  /** Lock-file path; defaults to `~/.dsh/web.lock`. */
  lockFile?: string
}

/**
 * The shared-server identity service. Its `[Service.init]` runs after the
 * injected web server has bound, so the recorded port is the real one and the
 * Loader settles only once the lock is on disk.
 */
export class ServerSingleInstance extends Service {
  /** Schema for {@link Config}; `z.object` keys are optional unless `.required()`. */
  static Config: z<Config> = z.object({
    lockFile: z.string(),
  })

  /** The web server must be bound before the lock can carry a real port. */
  static inject = ['webServer'] as const

  /** The lock-file path this service manages. */
  readonly lockFile: string

  constructor(ctx: Context, config: Config) {
    super(ctx, 'serverSingleInstance')
    this.lockFile = config.lockFile ?? defaultLockFile()
  }

  async [Service.init](): Promise<void> {
    // The webserver's own init (bind) completes before this service init by
    // injection order, so the recorded port is always the real bound port.
    const server: WebServer = this.ctx.webServer
    await writeFileAtomic(this.lockFile, renderServerLock(server.port), { mode: 0o600, dirMode: 0o700 })
    this.ctx.effect(() => () => {
      void unlink(this.lockFile).catch(() => {})
    }, 'server-single-instance.lock-cleanup')
  }
}

export default ServerSingleInstance
