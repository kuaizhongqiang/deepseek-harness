/**
 * Build the self-contained dsh CLI closure the desktop app ships as an extra
 * resource (`apps/deepseek-agent-client-desktop/dsh-cli`) — and the source of
 * the portable `dsh-server` tarball.
 *
 * A single-file bundle of the `dsh` CLI is impossible: the Cordis Loader
 * resolves plugin entries discovered from YAML patch rows at runtime, and
 * `resolveBundleDir`/`healProfilesModuleFallback` walk a real on-disk package
 * tree from the CLI's own manifest. So this stages a symlink-free
 * `node_modules` closure — the same deploy/staging approach
 * `scripts/build-exe-for-python-sdk.ts` uses for the SDK runtime, minus the
 * pkg --sea executable.
 *
 * The deployed root manifest (`dsh-cli/package.json`) carries the version and
 * the server-profile bundle deps, so the CLI's `../package.json` anchor reads
 * and `resolveBundleDir` BFS both work from inside the packaged app.
 * @module build-dsh-cli
 */

import { cp, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const APP_DIR = 'apps/deepseek-agent-client-desktop'
const CLOSURE_PACKAGE = 'dsh-desktop-cli-pkg'
const TARGET = resolve(root, APP_DIR, 'dsh-cli')
const CLI_MANIFEST_DIR = '@deepseek-ai/dsh'

const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(command: string, args: readonly string[], envOverrides: NodeJS.ProcessEnv = {}): void {
  // On Windows, Node's spawnSync cannot exec a `.cmd` shim directly (EINVAL);
  // run the whole line through the shell there. On POSIX pnpm is a real
  // executable, so no shell indirection is needed.
  const opts = {
    cwd: root,
    stdio: 'inherit' as const,
    env: { ...process.env, ...envOverrides },
  }
  const result =
    process.platform === 'win32'
      ? spawnSync(
          [command, ...args].map(arg => (arg.includes(' ') ? `"${arg}"` : arg)).join(' '),
          { ...opts, shell: true },
        )
      : spawnSync(command, [...args], opts)
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

/** Replace every symlink under `dir` with a real copy of its target; drop `.bin`. */
async function materializeLinks(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      const real = await realpath(full)
      const stat = await lstat(real)
      await rm(full, { recursive: true, force: true })
      if (stat.isDirectory()) {
        await cp(real, full, { recursive: true, dereference: true })
        await materializeLinks(full)
      } else {
        await cp(real, full)
      }
    } else if (entry.isDirectory()) {
      if (entry.name === '.bin') {
        await rm(full, { recursive: true, force: true })
      } else {
        await materializeLinks(full)
      }
    }
  }
}

/** Every direct dependency must exist as a real directory under the staged node_modules. */
async function ensureDirectDeps(target: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  // pnpm's legacy deploy hoists some direct dependencies beside the deploy
  // source rather than into the target, and the workspace ROOT node_modules
  // does not link them (the root package does not depend on them). Source the
  // fallback from the deploy root's own node_modules, mirroring
  // build-exe-for-python-sdk.ts's restoreLegacyHoists.
  const deployRootModules = join(root, APP_DIR, 'dsh-cli-source', 'node_modules')
  const missing: string[] = []
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(target, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(deployRootModules, dependency)
    if (!existsSync(source)) {
      missing.push(dependency)
      continue
    }
    await mkdir(dirname(destination), { recursive: true })
    // Exclude the package's own nested node_modules: in pnpm's link layout it
    // holds dangling symlinks that cp's recursion would fail to stat. The
    // package's bare imports resolve upward to the closure's hoisted
    // node_modules at runtime, mirroring restoreLegacyHoists.
    const nested = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nested && !path.startsWith(nested + sep),
    })
  }
  if (missing.length > 0) {
    throw new Error(`build-dsh-cli: staged dependencies remain missing: ${missing.join(', ')}`)
  }
}

/**
 * Lift the CLI's `bin.js` + split chunks + `config/` into the closure.
 *
 * The CLI reads its own version and computes `INSTALL_ANCHOR` via
 * `new URL('../package.json', import.meta.url)`, which assumes the entry sits
 * one directory BELOW the manifest (as `apps/cli/lib/bin.js` does for
 * `apps/cli/package.json`). So the closure must keep the CLI under `lib/`,
 * with the closure manifest at the root — otherwise the anchor walks up to
 * `apps/deepseek-agent-client-desktop/package.json`.
 */
async function liftCliEntry(target: string): Promise<void> {
  const cliDir = join(target, 'node_modules', CLI_MANIFEST_DIR)
  if (!existsSync(join(cliDir, 'lib'))) {
    throw new Error(`build-dsh-cli: @deepseek-ai/dsh has no built lib/ under ${cliDir}`)
  }
  const libOut = join(target, 'lib')
  await mkdir(libOut, { recursive: true })
  for (const name of await readdir(join(cliDir, 'lib'))) {
    if (name.endsWith('.js')) await cp(join(cliDir, 'lib', name), join(libOut, name))
  }
  const configSource = join(cliDir, 'config')
  if (existsSync(configSource)) {
    await cp(configSource, join(target, 'config'), { recursive: true })
  }
}

async function main(): Promise<void> {
  if (TARGET === root || root.startsWith(TARGET + join('.'))) {
    throw new Error('build-dsh-cli: refusing to clear the repo root as the closure target')
  }

  // Every package's lib must exist before deploy (files fields point at lib/).
  // CI builds first and passes --skip-build; local runs build here for convenience.
  if (!process.argv.includes('--skip-build')) {
    run(pnpmBin, ['run', 'build:lib'])
  }

  await rm(TARGET, { recursive: true, force: true })
  // Pass the target as a forward-slash repo-relative path (deploy resolves it
  // from the workspace root, where this script's cwd is anchored).
  run(
    pnpmBin,
    [
      '--filter',
      CLOSURE_PACKAGE,
      'deploy',
      '--legacy',
      // No `--prod`: deploy's internal `install --production` strips the
      // workspace's dev tooling (lefthook, tsx) and then the postinstall lane
      // fails. The closure manifest is dependency-only anyway; size trimming
      // can come later on Linux CI.
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      // Deploy's pre-run deps-status check runs an `install --production` that
      // aborts on a non-TTY shell (purge confirmation). Skip the check and force
      // confirmModulesPurge off; the closure is verified by ensureDirectDeps.
      '--config.verify-deps-before-run=false',
      '--config.confirm-modules-purge=false',
      `${APP_DIR}/dsh-cli`,
    ],
    // CI=true only here: on the build:lib call it would make pnpm purge and
    // reinstall the workspace, which is not what this script wants.
    { CI: 'true', npm_config_confirm_modules_purge: 'false' },
  )

  await materializeLinks(join(TARGET, 'node_modules'))
  await ensureDirectDeps(TARGET)
  await liftCliEntry(TARGET)

  console.log(`build-dsh-cli: staged self-contained closure -> ${TARGET}`)
}

await main()
