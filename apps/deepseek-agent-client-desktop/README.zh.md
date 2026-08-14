# DeepSeek Agent Client Desktop

[English](README.md) | 中文

Electron 壳：懒启动（或 attach）共享 dsh server——见 `docs/transformation/desktop-and-vscode.md`——并直接从 server URL 加载 web UI。由于 renderer 就是 `dsh web` 服务的同一份 SPA，所有 web 功能（会话、模型配置、工具、设置、凭证）零适配可用；原生窗口/托盘/通知能力通过一个最小 preload 桥暴露。

## Development

```sh
pnpm install
pnpm exec tsc -b ../../tsconfig.host.json     # typecheck
pnpm run build                                # esbuild -> dist/main.js, dist/preload.js
pnpm run package                              # electron-builder -> release/
```

server 命令按以下顺序解析：`DSH_CLIENT_DESKTOP_SERVER_COMMAND`（JSON 数组）→ 打包资源内的 bundled CLI → PATH 上的 `dsh`。开发时请确保 `dsh` 在 PATH 上（仓库根目录的 `pnpm dsh` 即可）。

## Verification status

本仓库内 typecheck 与 lint 为 CI 绿。运行时行为（窗口生命周期、托盘、导航防护、懒启动 server）需启动打包产物冒烟验证；按设计，server 在关窗后仍存活。
