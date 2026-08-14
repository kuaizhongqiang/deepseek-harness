/**
 * REAL-composition coverage for the lock publisher: a test-only cordis.yml
 * booted through the vendored Loader mounts the webserver and the
 * single-instance service, and every assertion observes the published
 * `~/.dsh/web.lock` (content, readiness, and dispose cleanup). Hand-built
 * contexts (no Loader) cover the awaited `[Service.init]` publish path.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import ServerSingleInstance, { LOOPBACK_HOST, SERVER_LOCK_VERSION, defaultLockFile, renderServerLock } from '../src/index.ts'
import type { ServerLockV1 } from '../src/index.ts'

let context: Context | undefined
let home: string | undefined
let previousDshHome: string | undefined

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-single-instance-'))
}

async function dispose(): Promise<void> {
  await context?.fiber.dispose()
  context = undefined
}

function setDshHome(dir: string): void {
  previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
}

afterEach(async () => {
  await dispose()
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  previousDshHome = undefined
})

/** Boot a cordis.yml with the webserver and single-instance rows through the real Loader. */
async function loadComposition(yaml: string): Promise<Context> {
  home = await scratch()
  setDshHome(home)
  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, yaml)
  context = new Context()
  context.baseUrl = pathToFileURL(home).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === '@deepseek-ai/dsh-host-webserver') return WebServer
      if (specifier === '@deepseek-ai/dsh-server-single-instance') return ServerSingleInstance
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

const COMPOSITION = [
  "- name: '@deepseek-ai/dsh-host-webserver'",
  '  config:',
  "    host: '127.0.0.1'",
  '    port: 0',
  "- name: '@deepseek-ai/dsh-server-single-instance'",
  '',
].join('\n')

async function readLock(): Promise<ServerLockV1> {
  const raw = await readFile(join(home as string, 'web.lock'), 'utf8')
  return JSON.parse(raw) as ServerLockV1
}

describe('server-single-instance', () => {
  it('publishes the lock to the default path after the webserver binds (Loader composition)', async () => {
    await loadComposition(COMPOSITION)
    const lock = await readLock()
    expect(lock.version).toBe(SERVER_LOCK_VERSION)
    expect(lock.pid).toBe(process.pid)
    expect(lock.port).toBeGreaterThan(0)
    expect(lock.url).toBe(`http://${LOOPBACK_HOST}:${lock.port}`)
    // The lock is the readiness signal; the URL must be reachable. The bare
    // webserver answers any unclaimed path with 404 — a connection, not an error.
    const response = await fetch(lock.url)
    expect(response.status).toBe(404)
  })

  it('honors an explicit lockFile config', async () => {
    home = await scratch()
    setDshHome(home)
    const customLock = join(home, 'custom', 'server.lock')
    const yaml = [
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-server-single-instance'",
      '  config:',
      `    lockFile: ${customLock}`,
      '',
    ].join('\n')
    await loadComposition(yaml)
    const raw = await readFile(customLock, 'utf8')
    const parsed = JSON.parse(raw) as ServerLockV1
    expect(parsed.version).toBe(1)
    expect(parsed.port).toBeGreaterThan(0)
  })

  it('removes the lock on dispose', async () => {
    await loadComposition(COMPOSITION)
    expect(existsSync(join(home as string, 'web.lock'))).toBe(true)
    await dispose()
    expect(existsSync(join(home as string, 'web.lock'))).toBe(false)
  })

  it('tolerates the lock already being gone at dispose', async () => {
    await loadComposition(COMPOSITION)
    await rm(join(home as string, 'web.lock'))
    await dispose() // the cleanup unlink rejects ENOENT and is swallowed
  })

  it('publishes immediately in a hand-built context once the webserver is bound (no Loader)', async () => {
    home = await scratch()
    setDshHome(home)
    context = new Context()
    await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await context.plugin(ServerSingleInstance)
    const lock = await readLock()
    expect(lock.port).toBeGreaterThan(0)
  })

  it('exposes the lock path via the service', async () => {
    home = await scratch()
    setDshHome(home)
    context = new Context()
    await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await context.plugin(ServerSingleInstance)
    expect(context.serverSingleInstance.lockFile).toBe(defaultLockFile())
  })

  it('renders a deterministic lock body', () => {
    expect(renderServerLock(42, 7)).toBe(JSON.stringify({ version: 1, pid: 7, port: 42, url: 'http://127.0.0.1:42' }))
  })
})
