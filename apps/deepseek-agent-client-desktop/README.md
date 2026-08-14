# DeepSeek Agent Client Desktop

English | [中文](README.zh.md)

An Electron shell that lazily starts (or attaches to) the shared dsh server —
see `docs/transformation/desktop-and-vscode.md` — and loads the web UI straight
from the server URL. Because the renderer is the exact SPA `dsh web` serves,
every web feature (sessions, model configuration, tools, settings,
credentials) works with zero adaptation; native window/tray/notification
conveniences are exposed through a small preload bridge.

## Development

```sh
pnpm install
pnpm exec tsc -b ../../tsconfig.host.json     # typecheck
pnpm run build                                # esbuild -> dist/main.js, dist/preload.js
pnpm run package                              # electron-builder -> release/
```

The server command is resolved as: `DSH_CLIENT_DESKTOP_SERVER_COMMAND` (JSON
array) → the bundled CLI under the packaged resources → `dsh` on PATH. In dev,
ensure `dsh` is on PATH (`pnpm dsh` works from the repo root).

## Verification status

Typecheck and lint are CI-green in this repository. Runtime behavior (window
lifecycle, tray, navigation guard, lazy server start) must be smoke-tested by
launching the packaged app; the server survives window close by design.
