# DeepSeek Agent Client for VSCode

Full chat panel in the VSCode sidebar, bridged to the shared `dsh` server
(the "unique server" from `docs/transformation/desktop-and-vscode.md`). The
webview is fully offline: every RPC and downlink frame flows through
`postMessage` to the extension host, which drives the server over HTTP +
WebSocket. Native diff / terminal / dialog integration lands on the same
downlink.

## Development

```sh
pnpm install
pnpm exec tsc -b ../../tsconfig.host.json     # typecheck
pnpm exec vitest run                          # unit tests (server-client / webview-boot / bridge)
node esbuild.config.mjs                       # bundle dist/extension.js
pnpm run package                              # esbuild + vsce → dist/*.vsix
```

## Architecture

- `src/extension.ts` — activation: `ensureServer` (dsh-server-launcher), the
  `WebviewViewProvider`, RPC/stream bridging, and native integration.
- `src/server-client.ts` — `VsCodeServerClient extends AbstractApiClient`
  (Node fetch uplink, `ws` downlink).
- `src/webview-boot.ts` — pure HTML rewrite: de-inlines the boot manifest,
  rewrites asset/bundle URLs to the server origin, prepends the loader, injects
  the CSP.
- `src/bridge.ts` — webview ↔ extension-host message envelope + method
  dispatch (pure).
- `resources/webview/` — `boot-loader.js` (manifest publication) and
  `vscode-connection.js` (postMessage transport plugin); both require runtime
  verification inside VSCode.

## Verification status

Typecheck, lint, the pure-logic unit tests, and the esbuild bundle are CI-green
in this repository. The webview runtime path (CSP, manifest injection,
postMessage transport) must be smoke-tested inside VSCode before release.
