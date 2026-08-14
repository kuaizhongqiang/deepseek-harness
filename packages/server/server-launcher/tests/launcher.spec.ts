/**
 * Launcher contract coverage: lock read/health/claim semantics, detached
 * spawn + publish + attach, stale takeover, claimer-crash recovery, timeout
 * release, profile bootstrap, and a real multi-process concurrent-claim race.
 * The "servers" are tiny Node fixtures (see tests/fixtures/) so no harness or
 * API key is involved.
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  SERVER_LOCK_VERSION,
  WEB_LOCK_FILE,
  SERVER_LOG_FILE,
  bootstrapServerProfile,
  checkServerHealth,
  claimLock,
  ensureServer,
  pidAlive,
  readServerLock,
  releaseOwnedLock,
  resolveServerLog,
  resolveWebLock,
  takeoverStaleLock,
} from '../src/index.ts'
import type { EnsureServerResult, ServerLock } from '../src/index.ts'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const fakeServer = join(FIXTURES, 'fake-server.mjs')
const neverPublish = join(FIXTURES, 'never-publish.mjs')
const staleServer = join(FIXTURES, 'stale-server.mjs')
const claimer = join(FIXTURES, 'claimer.mts')

let home: string | undefined
let previousDshHome: string | undefined
const stray: import('node:child_process').ChildProcess[] = []

function setDshHome(dir: string): void {
  previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-launcher-'))
}

function lockPath(dir = home as string): string {
  return join(dir, WEB_LOCK_FILE)
}

function spawnedLog(dir = home as string): string {
  return join(dir, 'spawned.log')
}

/** Kill every fake-server pid recorded in spawned.log (detached survivors). */
async function killSpawnedServers(dir = home as string): Promise<void> {
  try {
    const raw = await readFile(spawnedLog(dir), 'utf8')
    for (const line of raw.trim().split('\n')) {
      if (line === '') continue
      try { process.kill(Number(line)) } catch { /* already gone */ }
    }
  } catch { /* no spawned.log yet */ }
}

afterEach(async () => {
  await killSpawnedServers()
  for (const child of stray.splice(0)) {
    try { child.kill() } catch { /* already exited */ }
  }
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  previousDshHome = undefined
})

/** Start a fixture server directly (not through the launcher) and wait for its lock. */
async function startDirectFixture(script: string): Promise<ServerLock> {
  home = await scratch()
  setDshHome(home)
  const child = spawn('node', [script], { cwd: ROOT, env: { ...process.env, DSH_HOME: home }, stdio: 'ignore' })
  stray.push(child)
  for (let i = 0; i < 100; i++) {
    const lock = await readServerLock(lockPath())
    if (lock?.port != null) return lock
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('fixture server did not publish a lock in time')
}

describe('readServerLock', () => {
  it('returns undefined for a missing lock', async () => {
    const dir = await scratch()
    expect(await readServerLock(join(dir, 'web.lock'))).toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })

  it('parses a valid lock', async () => {
    const dir = await scratch()
    await writeFile(join(dir, 'web.lock'), JSON.stringify({ version: 1, pid: 1, port: 2, url: 'http://x' }))
    expect(await readServerLock(join(dir, 'web.lock'))).toEqual({ version: 1, pid: 1, port: 2, url: 'http://x' })
    await rm(dir, { recursive: true, force: true })
  })

  it('returns undefined for a corrupt lock', async () => {
    const dir = await scratch()
    await writeFile(join(dir, 'web.lock'), 'not json')
    expect(await readServerLock(join(dir, 'web.lock'))).toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects an unknown format version', async () => {
    const dir = await scratch()
    await writeFile(join(dir, 'web.lock'), JSON.stringify({ version: 2, pid: 1, port: 2, url: 'http://x' }))
    expect(await readServerLock(join(dir, 'web.lock'))).toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('path resolution', () => {
  it('defaults to the harness home', async () => {
    home = await scratch()
    setDshHome(home)
    expect(resolveWebLock()).toBe(join(home, WEB_LOCK_FILE))
    expect(resolveServerLog()).toBe(join(home, SERVER_LOG_FILE))
  })

  it('honors caller overrides', async () => {
    expect(resolveWebLock('/tmp/lock')).toBe('/tmp/lock')
    expect(resolveServerLog('/tmp/log')).toBe('/tmp/log')
  })
})

describe('checkServerHealth', () => {
  it('reports a healthy server', async () => {
    const lock = await startDirectFixture(fakeServer)
    expect(await checkServerHealth(lock.url as string)).toBe(true)
  })

  it('reports a reachable-but-unhealthy server as unhealthy', async () => {
    const lock = await startDirectFixture(staleServer)
    expect(await checkServerHealth(lock.url as string)).toBe(false)
  })

  it('reports an unreachable URL as unhealthy', async () => {
    expect(await checkServerHealth('http://127.0.0.1:1')).toBe(false)
  })
})

describe('pidAlive', () => {
  it('reports the current process as alive', () => {
    expect(pidAlive(process.pid)).toBe(true)
  })

  it('reports a nonexistent process as dead', () => {
    expect(pidAlive(999_999_999)).toBe(false)
  })
})

describe('bootstrapServerProfile', () => {
  it('creates the profile manifest, patch layer, and pnpm workspace', async () => {
    home = await scratch()
    const dir = join(home, 'profiles', 'server')
    await bootstrapServerProfile(home)
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({
      name: 'dsh-profile-server',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-server-app'] } },
    })
    expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('[]')
    expect(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')
  })

  it('never overwrites an existing profile', async () => {
    home = await scratch()
    const dir = join(home, 'profiles', 'server')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'kept' }))
    await bootstrapServerProfile(home)
    expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))).toEqual({ name: 'kept' })
  })
})

describe('claim / takeover / release primitives', () => {
  it('claimLock wins an exclusive claim and loses to an existing one', async () => {
    const dir = await scratch()
    const file = join(dir, 'web.lock')
    expect(await claimLock(file, 1)).toBe(true)
    expect(await claimLock(file, 2)).toBe(false) // EEXIST → contention lost
    expect(await readServerLock(file)).toEqual({ version: 1, pid: 1, port: null, url: null })
    await rm(dir, { recursive: true, force: true })
  })

  it('claimLock propagates a non-contention failure', async () => {
    const dir = await scratch()
    await writeFile(join(dir, 'parent'), 'not a directory')
    const file = join(dir, 'parent', 'web.lock')
    // The parent is a file, so the recursive mkdir cannot create it — a real
    // failure, not an EEXIST contention, on every platform.
    await expect(claimLock(file, 1)).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
  })

  it('releaseOwnedLock removes only its own claim', async () => {
    const dir = await scratch()
    const file = join(dir, 'web.lock')
    await writeFile(file, JSON.stringify({ version: 1, pid: 1, port: null, url: null }))
    await releaseOwnedLock(file, 999) // not ours → untouched
    expect(await readServerLock(file)).toEqual({ version: 1, pid: 1, port: null, url: null })
    await releaseOwnedLock(file, 1) // ours → removed
    expect(await readServerLock(file)).toBeUndefined()
    await releaseOwnedLock(file, 1) // already gone → no-op
    await rm(dir, { recursive: true, force: true })
  })

  it('takeoverStaleLock removes only the exact stale record', async () => {
    const dir = await scratch()
    const file = join(dir, 'web.lock')
    const observed = { version: 1 as const, pid: 1, port: 2, url: 'http://x' }
    // The record changed under us (a newer owner published) → untouched.
    await writeFile(file, JSON.stringify({ version: 1, pid: 9, port: 3, url: 'http://y' }))
    await takeoverStaleLock(file, observed)
    expect(await readServerLock(file)).toMatchObject({ pid: 9 })
    // Same pid but a different port also means the record moved on → untouched.
    await writeFile(file, JSON.stringify({ version: 1, pid: 1, port: 5, url: 'http://z' }))
    await takeoverStaleLock(file, observed)
    expect(await readServerLock(file)).toMatchObject({ port: 5 })
    // The record is still the stale one → removed.
    await writeFile(file, JSON.stringify(observed))
    await takeoverStaleLock(file, observed)
    expect(await readServerLock(file)).toBeUndefined()
    // The record vanished meanwhile → no-op.
    await takeoverStaleLock(file, observed)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('ensureServer', () => {
  it('lazily starts a detached server and attaches to its published lock', async () => {
    home = await scratch()
    setDshHome(home)
    // No claimTimeoutMs: exercises the 30s default and the fast-publish path.
    const result = await ensureServer({ command: ['node', fakeServer] })
    expect(result.attached).toBe(true)
    expect(result.url).toBe(`http://127.0.0.1:${result.port}`)
    const lock = await readServerLock(lockPath())
    expect(lock).toMatchObject({ version: SERVER_LOCK_VERSION, port: result.port, url: result.url })
    expect(lock?.pid).toBe(result.pid)
    expect(await checkServerHealth(result.url)).toBe(true)
    expect(pidAlive(result.pid)).toBe(true)
    expect((await readdir(home)).includes('web.lock')).toBe(true)
    // exactly one server process was spawned
    expect((await readFile(spawnedLog(), 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('reuses an already-running server instead of spawning another', async () => {
    const lock = await startDirectFixture(fakeServer)
    const before = (await readFile(spawnedLog(), 'utf8')).trim().split('\n').length
    const result = await ensureServer({ command: ['node', fakeServer], claimTimeoutMs: 5_000 })
    expect(result.url).toBe(lock.url)
    expect(result.pid).toBe(lock.pid)
    expect((await readFile(spawnedLog(), 'utf8')).trim().split('\n')).toHaveLength(before)
  })

  it('takes over a stale lock whose server failed health and starts a fresh one', async () => {
    home = await scratch()
    setDshHome(home)
    await writeFile(lockPath(), JSON.stringify({ version: 1, pid: 999_999_999, port: 1, url: 'http://127.0.0.1:1' }))
    const result = await ensureServer({ command: ['node', fakeServer], claimTimeoutMs: 10_000 })
    expect(result.attached).toBe(true)
    expect(await checkServerHealth(result.url)).toBe(true)
    const lock = await readServerLock(lockPath())
    expect(lock?.pid).toBe(result.pid)
    expect((await readFile(spawnedLog(), 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('takes over a claim whose owner died before publishing', async () => {
    home = await scratch()
    setDshHome(home)
    await writeFile(lockPath(), JSON.stringify({ version: 1, pid: 999_999_998, port: null, url: null }))
    const result = await ensureServer({ command: ['node', fakeServer], claimTimeoutMs: 10_000 })
    expect(await checkServerHealth(result.url)).toBe(true)
  })

  it('gives up after the retry budget when a live claim never publishes', async () => {
    home = await scratch()
    setDshHome(home)
    // A live pid (this process) holds an unpublished claim forever.
    await writeFile(lockPath(), JSON.stringify({ version: 1, pid: process.pid, port: null, url: null }))
    await expect(ensureServer({ command: ['node', fakeServer], claimTimeoutMs: 500 }))
      .rejects.toThrow('could not acquire the shared server lock')
  })

  it('releases its claim when a claimed server never publishes', async () => {
    home = await scratch()
    setDshHome(home)
    await expect(ensureServer({ command: ['node', neverPublish], claimTimeoutMs: 400 }))
      .rejects.toThrow('server did not publish a healthy lock')
    // the released claim leaves no lock behind
    expect(await readServerLock(lockPath())).toBeUndefined()
  })

  it('fails loudly for an empty command and releases the claim', async () => {
    home = await scratch()
    setDshHome(home)
    await expect(ensureServer({ command: [], claimTimeoutMs: 500 }))
      .rejects.toThrow('server command must not be empty')
    expect(await readServerLock(lockPath())).toBeUndefined()
  })

  it('propagates a non-contention claim failure', async () => {
    home = await scratch()
    setDshHome(home)
    await writeFile(join(home, 'parent'), 'not a directory')
    await expect(ensureServer({ command: ['node', fakeServer], claimTimeoutMs: 500, lockFile: join(home, 'parent', 'web.lock') }))
      .rejects.toThrow()
  })

  it('bootstraps the server profile when asked', async () => {
    home = await scratch()
    setDshHome(home)
    await ensureServer({ command: ['node', fakeServer], claimTimeoutMs: 10_000, bootstrap: true })
    const manifest = await readFile(join(home, 'profiles', 'server', 'package.json'), 'utf8')
    const parsed = JSON.parse(manifest) as { dsh: { profile: { bundles: string[] } } }
    expect(parsed.dsh.profile.bundles).toContain('@deepseek-ai/dsh-server-app')
  })
})

describe('concurrent claim', () => {
  it('starts exactly one server across four racing claimers', async () => {
    home = await scratch()
    setDshHome(home)
    const claimers = Array.from({ length: 4 }, () =>
      spawn('node', ['--import', 'tsx', claimer], {
        cwd: ROOT,
        env: { ...process.env, DSH_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      }))
    stray.push(...claimers)
    const results = await Promise.all(claimers.map(async (child) => {
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      const code = await new Promise<number | null>(resolve => child.on('close', resolve))
      return { code, stdout, stderr }
    }))
    for (const r of results) {
      expect(r.code).toBe(0)
      expect(r.stderr).toBe('')
    }
    const parsed = results.map(r => JSON.parse(r.stdout) as EnsureServerResult)
    const first = parsed[0] as EnsureServerResult
    expect(new Set(parsed.map(r => r.url)).size).toBe(1)
    // Exactly one server process was spawned by whoever won the claim.
    expect((await readFile(spawnedLog(), 'utf8')).trim().split('\n')).toHaveLength(1)
    const lock = await readServerLock(lockPath())
    expect(lock?.pid).toBe(first.pid)
    expect(await checkServerHealth(first.url)).toBe(true)
  })
})

describe('invariant companion', () => {
  it('registers under the test invariant host when a context mounts a plugin', async () => {
    // Mounting any plugin on a fresh context makes the vitest invariant host
    // load and apply this package's invariant companion (selected by test
    // path), exercising the no-op install.
    const ctx = new Context()
    await ctx.plugin(() => {})
    await ctx.fiber.dispose()
  })
})
