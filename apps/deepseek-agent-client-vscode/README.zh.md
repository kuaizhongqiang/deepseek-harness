# DeepSeek Agent Client for VSCode

[English](README.md) | 中文

VSCode 侧边栏的完整聊天面板，桥接到共享 `dsh` server（见 `docs/transformation/desktop-and-vscode.md` 的「唯一 server」）。webview 完全离线：所有 RPC 与下行帧经 `postMessage` 流经 extension host，后者通过 HTTP + WebSocket 驱动 server。原生 diff / terminal / dialog 集成落在同一条下行流上。

## Development

```sh
pnpm install
pnpm exec tsc -b ../../tsconfig.host.json     # typecheck
pnpm exec vitest run                          # unit tests (server-client / webview-boot / bridge)
node esbuild.config.mjs                       # bundle dist/extension.js
pnpm run package                              # esbuild + vsce → dist/*.vsix
```

## Architecture

- `src/extension.ts` — 激活：`ensureServer`（dsh-server-launcher）、`WebviewViewProvider`、RPC/流桥接、原生集成。
- `src/server-client.ts` — `VsCodeServerClient extends AbstractApiClient`（Node fetch 上行、`ws` 下行）。
- `src/webview-boot.ts` — 纯 HTML 重写：boot manifest 去内联、资源/bundle URL 改写为 server 源、前置 loader、注入 CSP。
- `src/bridge.ts` — webview ↔ extension host 消息信封 + 方法 dispatch（纯函数）。
- `resources/webview/` — `boot-loader.js`（manifest 发布）与 `vscode-connection.js`（postMessage transport 插件）；两者需在 VSCode 内运行时验证。

## Verification status

本仓库内 typecheck、lint、纯逻辑单测、esbuild bundle 均为 CI 绿。webview 运行时路径（CSP、manifest 注入、postMessage transport）须在 VSCode 内冒烟后发布。
