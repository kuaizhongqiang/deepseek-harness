# Agent Note: Desktop/VSCode client transport facts

Status: proposed

[English](2026-08-14-desktop-vscode-transport-facts.md) | 中文

## Problem

桌面端/VSCode 改造方案（[desktop-and-vscode.md](../../../../docs/transformation/desktop-and-vscode.md)）依赖的四个代码库假设，经探索发现与源码不符；另有三条事实决定了新载体（carrier）的搭建方式。在此一次性记录，让修正可追溯，方案正文直接写结论而不再推导。

## Proposal

四条修正与三条事实，作为桌面端/VSCode 工作的基准：

1. **`seams` 不是 transport 注入点**。`AppWebEntry(el, seams?)` 的 `seams` 类型是 `Pick<ClientModuleSystemOptions, 'loadBundle'>`（`packages/client/web/src/boot.tsx`）——只管模块加载。transport 替换发生在 `AbstractApiClient` 的 `doFetch`/`openMux`/`openHost`（`packages/host/apiproxy/src/fetch/client.ts`），以及选中默认 `WebApiClient` 的 `ctx.connection` 这个 client 插件层。
2. **没有现成健康检查端点**。webserver 只做路由；就绪判定是 `POST /api/host.describe` 成功 + 两条下行流 `onOpen`。唯一 server 的锁文件必须自定义探测。
3. **没有 daemon / pid / 端口探测基建**。`writeFileAtomic` 总是覆盖，独占 claim 需直接用 `writeFile(..., { flag: 'wx' })`；后台驻留需自建。
4. **`sdk/server` 驱动不了完整聊天 UI**。`HarnessSdkJsonRpcServer` 只暴露 `initialize`/`session.prompt`/`shutdown`；`HarnessClient` 只能 `spawn`、不能 attach 已有 server。共享 server 必须是 `web` profile 的 HTTP server，VSCode webview 经 extension host 桥接。

载体依赖的三条事实：

- boot manifest 以内联 `<script>` 注入（`packages/client/modules/src/index.ts`）；webview CSP 禁内联，manifest 必须去内联（`<script type="application/json">` + 外部 loader）。
- client 模块 bundle 由 `/plugins/<id>/client.js` 服务（webserver 上的 `/plugins` 前缀路由）。
- `WebApiClient` 用相对 `/api`；Electron `loadURL` 下页面源即 server，天然正确，但在 `vscode-webview://` 源下失效——这正是 webview transport 必须自定义的原因。

## Alternatives considered

- **把 webview transport 走 `seams` 注入**。否决：`seams` 接口只携带 `loadBundle`；扩到 fetch/WebSocket 会改 boot 契约。
- **用 `sdk/server` 作为 VSCode 的共享 server 协议**。否决：三个方法的面无法支撑完整聊天面板，且 `HarnessClient` 不能 attach 已运行的 server。
- **给 webserver 加 `/api/health` 端点**。搁置：就绪契约（`host.describe` + `onOpen`）已存在；专属端点会触碰上游 `dsh-host-webserver`。

## Acceptance criteria

- 方案（docs/transformation/desktop-and-vscode.md）把这些写成结论而非开放问题。
- M1 的 launcher 用 `POST /api/host.describe` 探测就绪；M2 的 webview transport 是 extension host 桥接；两者在各里程碑中成立。

## Risks

- 若 `dsh-web-frontend` 改变 boot 机制，事实 5–7 会过期，需重审方案。
- 若上游 `dsh-host-webserver` 日后加健康端点，事实 2 的自定义探测变成冗余但无害。
