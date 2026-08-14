// Bundles the extension host entry into a single dist/extension.js for vsce.
// The `vscode` module is external (provided by the extension host at runtime);
// workspace packages resolve to their built lib/ or src via tsconfig paths.

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = fileURLToPath(new URL('.', import.meta.url))
const outfile = resolve(root, 'dist/extension.js')

await build({
  entryPoints: [resolve(root, 'src/extension.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['vscode'],
  sourcemap: false,
  logLevel: 'info',
})

console.log(`dsh-vscode: bundled extension host -> ${outfile}`)
