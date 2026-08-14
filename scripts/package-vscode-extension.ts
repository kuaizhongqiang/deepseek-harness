/**
 * Package the VSCode extension as a `.vsix` via a staging shim.
 *
 * The workspace package name is scoped (`@deepseek-ai/dsh-deepseek-agent-client-vscode`)
 * so pnpm can resolve it as a workspace dependency, but `vsce` rejects scoped
 * extension names. This script stages the built payload under an unscoped name
 * and runs `vsce package` there, producing `apps/deepseek-agent-client-vscode/dist/deepseek-agent-client-<version>.vsix`.
 * @module package-vscode-extension
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const APP = resolve(root, 'apps/deepseek-agent-client-vscode')
const isWin = process.platform === 'win32'
const VSCE = join(APP, 'node_modules', '.bin', isWin ? 'vsce.cmd' : 'vsce')
const STAGE = join(APP, 'dist', 'vsix-stage')
const OUT_DIR = join(APP, 'dist')

function run(command: string, args: readonly string[], cwd: string): void {
  const opts = { cwd, stdio: 'inherit' as const }
  const result = isWin
    ? spawnSync([command, ...args].map(arg => (arg.includes(' ') ? `"${arg}"` : arg)).join(' '), {
        ...opts,
        shell: true,
      })
    : spawnSync(command, [...args], opts)
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

async function main(): Promise<void> {
  // 1. Bundle the extension host (the app's own esbuild build).
  run('node', ['esbuild.config.mjs'], APP)

  // 2. Stage the payload under an unscoped shim manifest.
  await rm(STAGE, { recursive: true, force: true })
  await mkdir(STAGE, { recursive: true })

  const real = JSON.parse(await readFile(join(APP, 'package.json'), 'utf8')) as Record<string, unknown>
  const shim = {
    name: 'deepseek-agent-client-vscode',
    displayName: real.displayName,
    description: real.description,
    version: real.version,
    publisher: real.publisher,
    license: 'MIT',
    repository: { type: 'git', url: 'https://github.com/kuaizhongqiang/deepseek-harness.git' },
    main: real.main,
    engines: real.engines,
    activationEvents: real.activationEvents,
    contributes: real.contributes,
    // No top-level `icon`: vsce requires a raster (PNG) for the marketplace
    // listing icon; the SVG in media/ stays for the activity-bar entry.
  }
  await writeFile(join(STAGE, 'package.json'), `${JSON.stringify(shim, undefined, 2)}\n`)

  await mkdir(join(STAGE, 'dist'))
  await cp(join(APP, 'dist', 'extension.js'), join(STAGE, 'dist', 'extension.js'))
  for (const dir of ['resources', 'media']) {
    const source = join(APP, dir)
    if (existsSync(source)) await cp(source, join(STAGE, dir), { recursive: true })
  }
  for (const name of ['README.md', 'README.zh.md', 'LICENSE']) {
    const source = name === 'LICENSE' ? join(root, 'LICENSE') : join(APP, name)
    if (existsSync(source)) await cp(source, join(STAGE, name))
  }
  await writeFile(
    join(STAGE, '.vscodeignore'),
    [
      '**/*.map',
      '**/tsconfig.tsbuildinfo',
      '**/.DS_Store',
    ].join('\n') + '\n',
  )

  // 3. Package the vsix from the stage.
  run(VSCE, ['package', '--out', join(OUT_DIR, `deepseek-agent-client-${String(shim.version)}.vsix`)], STAGE)

  await rm(STAGE, { recursive: true, force: true })
  console.log(`package-vscode-extension: wrote dist/deepseek-agent-client-${String(shim.version)}.vsix`)
}

await main()
