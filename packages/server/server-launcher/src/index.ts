/**
 * @deepseek-ai/dsh-server-launcher — client-side single-server launcher.
 *
 * Desktop and VSCode both connect to one shared `dsh` web-server process. This
 * library is the client half of that contract: read `~/.dsh/web.lock`, health
 * check the recorded server, take over a stale lock, otherwise claim the lock
 * with an exclusive (`wx`) write and spawn a detached server, wait for it to
 * publish its real port, then return the URL to attach to. It is a plain Node
 * library (no Cordis) so both the Electron main process and the VSCode
 * extension host can use it directly.
 *
 * The lock shape mirrors what `dsh-server-single-instance` publishes:
 * `{ version: 1, pid, port, url }` (see that package for the server side).
 */

import { spawn } from 'node:child_process'
import { access, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { SERVER_PROFILE_BUNDLES, SERVER_PROFILE_NAME } from '@deepseek-ai/dsh-server-app'

/** One server-identity lock record, as published by the server side. */
export interface ServerLock {
  /** Format version; readers reject unknown versions. */
  version: 1
  /** The server process id (the claimer's pid while a claim is in flight). */
  pid: number
  /** The bound port; `null` while a claim has not yet published. */
  port: number | null
  /** Canonical loopback URL; `null` while a claim has not yet published. */
  url: string | null
}

/** Wire version of {@link ServerLock}. */
export const SERVER_LOCK_VERSION = 1 as const

/** Lock-file basename under the harness home. */
export const WEB_LOCK_FILE = 'web.lock'

/** Default detached-server log path under the harness home. */
export const SERVER_LOG_FILE = 'logs/server.log'

/** Resolve the lock-file path; a caller-supplied path wins over the home default. */
export function resolveWebLock(lockFile?: string): string {
  return lockFile ?? dshHomePath(WEB_LOCK_FILE)
}

/** Resolve the detached-server log path; a caller-supplied path wins over the home default. */
export function resolveServerLog(logFile?: string): string {
  return logFile ?? dshHomePath(SERVER_LOG_FILE)
}

/** Profile manifest template, mirroring `initProfile` in `dsh-app-boot`. */
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/** pnpm settings out-of-tree plugins need, mirroring `initProfile`. */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/**
 * Bootstrap the shared `server` profile under the harness home so
 * `ensureServer` can spawn `dsh --profile server`. Mirrors `initProfile`
 * (`packages/boot/app-boot/src/profile.ts`): writes the manifest (bundle
 * stack), the empty user patch layer, and the pnpm settings, and never
 * touches files that already exist — re-running is a no-op.
 * @param home - the harness home (defaults to `resolveDshHome()`).
 */
export async function bootstrapServerProfile(home: string = resolveDshHome()): Promise<void> {
  const dir = join(home, 'profiles', SERVER_PROFILE_NAME)
  await mkdir(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  try {
    await access(manifestPath)
  } catch {
    await writeFile(manifestPath, `${JSON.stringify({
      name: `dsh-profile-${basename(dir)}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...SERVER_PROFILE_BUNDLES] } },
    }, undefined, 2)}\n`)
  }
  const patchPath = join(dir, 'cordis.patch.yml')
  try {
    await access(patchPath)
  } catch {
    await writeFile(patchPath, PROFILE_PATCH_TEMPLATE)
  }
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  try {
    await access(workspacePath)
  } catch {
    await writeFile(workspacePath, PROFILE_PNPM_WORKSPACE)
  }
}

/** Options for {@link ensureServer}. */
export interface EnsureServerOptions {
  /**
   * The detached command that starts the server, e.g.
   * `['dsh', '--profile', 'server', '--port', '0']`. The launcher is generic;
   * the caller decides which server (and profile) to spawn.
   */
  command: string[]
  /** Working directory for the spawned server. */
  cwd?: string
  /** Detached-server stdout/stderr log path (default `~/.dsh/logs/server.log`). */
  logFile?: string
  /** Lock-file path (default `~/.dsh/web.lock`). */
  lockFile?: string
  /** How long to wait for a claimed server to publish, in ms (default 30s). */
  claimTimeoutMs?: number
  /** Health-probe timeout per attempt, in ms (default 500). */
  healthTimeoutMs?: number
  /**
   * Bootstrap the `server` profile under the harness home before spawning
   * (idempotent; existing profile files are never touched).
   */
  bootstrap?: boolean
}

/** The attachable server. */
export interface EnsureServerResult {
  /** Canonical loopback URL, e.g. `http://127.0.0.1:41983`. */
  url: string
  /** The bound port. */
  port: number
  /** The server process id. */
  pid: number
  /** Whether an already-running server was reused rather than spawned. */
  attached: boolean
}

const CLAIM_RETRIES = 15
const CLAIM_RETRY_MS = 150
const ATTACH_POLL_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Read and parse the server lock.
 * @param lockFile - the lock-file path.
 * @returns the parsed lock, or `undefined` when the file is missing, corrupt,
 * or carries an unknown format version.
 */
export async function readServerLock(lockFile: string): Promise<ServerLock | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockFile, 'utf8')) as Partial<ServerLock>
    if (parsed.version !== SERVER_LOCK_VERSION) return undefined
    return parsed as ServerLock
  } catch {
    return undefined
  }
}

/**
 * Probe a server URL for readiness by invoking `host.describe`.
 * @param url - the server origin, e.g. `http://127.0.0.1:41983`.
 * @param timeoutMs - per-attempt timeout.
 * @returns whether the server answered a healthy `host.describe`.
 */
export async function checkServerHealth(url: string, timeoutMs = 500): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Whether a process id is alive. `process.kill(pid, 0)` probes without
 * signalling; `ESRCH` means no such process, `EPERM` means the process exists
 * but is owned by another user (still alive).
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    /* v8 ignore next 1 -- the non-ESRCH arm needs a cross-user pid probe, not reachable in unit tests */
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Exclusive-claim the lock with the caller's pid and an unpublished (null
 * port) body. This is the single-instance arbitration step: at most one
 * concurrent caller's `wx` write succeeds.
 * @param lockFile - the lock-file path.
 * @param pid - the claimer's process id recorded in the claim.
 * @returns whether this caller won the claim; `false` when the lock already
 * exists (another client is starting the server).
 */
export async function claimLock(lockFile: string, pid: number): Promise<boolean> {
  await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 })
  try {
    await writeFile(
      lockFile,
      JSON.stringify({ version: SERVER_LOCK_VERSION, pid, port: null, url: null } satisfies ServerLock),
      { flag: 'wx', mode: 0o600 },
    )
    return true
  } catch (error) {
    /* v8 ignore start -- contention (EEXIST → false) is pinned by the direct test; the writeFile non-EEXIST arm is platform-specific */
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
    /* v8 ignore stop */
  }
}

/**
 * Remove a stale lock only when it is still the very record observed, so a
 * takeover never clobbers a claim or publish that raced in since the read.
 * @param lockFile - the lock-file path.
 * @param observed - the record that was deemed stale.
 */
export async function takeoverStaleLock(lockFile: string, observed: ServerLock): Promise<void> {
  const current = await readServerLock(lockFile)
  if (current === undefined) return
  if (current.pid !== observed.pid || current.port !== observed.port) return
  await rm(lockFile, { force: true })
}

/**
 * Remove a lock this process owns (matching pid); a newer owner's record is
 * never clobbered.
 * @param lockFile - the lock-file path.
 * @param pid - the owning process id the removal is limited to.
 */
export async function releaseOwnedLock(lockFile: string, pid: number): Promise<void> {
  const lock = await readServerLock(lockFile)
  if (lock === undefined || lock.pid !== pid) return
  await rm(lockFile, { force: true })
}

/** Spawn the server detached, inheriting its console-free stdio into the log file. */
async function spawnDetached(command: string[], cwd: string | undefined, logFile: string): Promise<void> {
  const commandName = command[0]
  if (commandName === undefined) throw new Error('dsh-server-launcher: server command must not be empty')
  const args = command.slice(1)
  await mkdir(dirname(logFile), { recursive: true, mode: 0o700 })
  const fd = await open(logFile, 'a')
  try {
    const child = spawn(commandName, args, {
      cwd,
      detached: true,
      stdio: ['ignore', fd.fd, fd.fd],
      windowsHide: true,
    })
    child.unref()
  } finally {
    await fd.close()
  }
}

/** Poll the lock until a healthy server is published, or the deadline passes. */
async function waitForPublish(lockFile: string, timeoutMs: number): Promise<ServerLock | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lock = await readServerLock(lockFile)
    // A claimed-but-unpublished lock carries port null; the port-set-but-url-null
    // arm below is unreachable because renderServerLock publishes both together.
    /* v8 ignore next 1 -- the port-set-but-url-null arm is unreachable from the published contract */
    if (lock?.port != null && lock.url != null && await checkServerHealth(lock.url)) return lock
    if (Date.now() >= deadline) return undefined
    await sleep(ATTACH_POLL_MS)
  }
}

function attach(lock: ServerLock): EnsureServerResult {
  return { url: lock.url as string, port: lock.port as number, pid: lock.pid, attached: true }
}

/**
 * Ensure a shared server is running and attach to it.
 *
 * Algorithm, per iteration of a bounded retry loop:
 * 1. Read the lock. A healthy recorded server is reused.
 * 2. An unpublished lock (port `null`) means a claim is in flight: wait while
 *    the claimer is alive, take over if the claimer died.
 * 3. A stale lock (recorded server failing health) is removed, then the lock
 *    is exclusive-claimed (`wx`). Losing the claim means another client is
 *    starting the server — wait and retry attach.
 * 4. Having claimed, spawn the server detached and wait for its publish.
 *    Whoever publishes a healthy lock first wins; the caller attaches to it.
 *
 * @param options - the server command and timing knobs.
 * @returns the attachable server.
 * @throws when no server could be reached or started within the retry budget.
 */
export async function ensureServer(options: EnsureServerOptions): Promise<EnsureServerResult> {
  const lockFile = resolveWebLock(options.lockFile)
  const logFile = resolveServerLog(options.logFile)
  const claimTimeoutMs = options.claimTimeoutMs ?? 30_000
  if (options.bootstrap === true) await bootstrapServerProfile()
  for (let attempt = 0; attempt < CLAIM_RETRIES; attempt++) {
    const lock = await readServerLock(lockFile)
    if (lock !== undefined && lock.port != null && lock.url != null) {
      if (await checkServerHealth(lock.url, options.healthTimeoutMs)) return attach(lock)
      // port is set but the health check failed: the server crashed or hung —
      // the record is stale and falls through to takeover.
    } else if (lock !== undefined) {
      // A claim is in flight (port not yet published). If its owner died, the
      // claim is stale; otherwise wait and retry.
      if (pidAlive(lock.pid)) {
        await sleep(CLAIM_RETRY_MS)
        continue
      }
    }
    if (lock !== undefined) await takeoverStaleLock(lockFile, lock)
    if (await claimLock(lockFile, process.pid)) {
      try {
        await spawnDetached(options.command, options.cwd, logFile)
        const published = await waitForPublish(lockFile, claimTimeoutMs)
        if (published !== undefined) return attach(published)
        throw new Error(`dsh-server-launcher: server did not publish a healthy lock within ${claimTimeoutMs}ms`)
      } catch (error) {
        await releaseOwnedLock(lockFile, process.pid)
        throw error
      }
    }
    /* v8 ignore next 1 -- the lost-claim wait is exercised by the subprocess concurrency test, invisible to parent coverage */
    await sleep(CLAIM_RETRY_MS)
  }
  throw new Error('dsh-server-launcher: could not acquire the shared server lock')
}
