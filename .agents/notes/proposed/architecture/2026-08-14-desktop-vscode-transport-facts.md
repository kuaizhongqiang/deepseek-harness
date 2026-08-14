# Agent Note: Desktop/VSCode client transport facts

Status: proposed

English | [中文](2026-08-14-desktop-vscode-transport-facts.zh.md)

## Problem

The desktop/VSCode transformation plan ([desktop-and-vscode.md](../../../../docs/transformation/desktop-and-vscode.md)) rests on four assumptions about the codebase that exploration found to disagree with the source, plus three facts that shape how the new carriers can be built. Recording them once here keeps the corrections traceable and lets the plan state conclusions instead of re-deriving them.

## Proposal

Four corrections and three facts, treated as ground truth for the desktop/VSCode work:

1. **`seams` is not a transport injection point.** `AppWebEntry(el, seams?)`'s `seams` type is `Pick<ClientModuleSystemOptions, 'loadBundle'>` (`packages/client/web/src/boot.tsx`) — module loading only. Transport swaps happen in `AbstractApiClient`'s `doFetch`/`openMux`/`openHost` (`packages/host/apiproxy/src/fetch/client.ts`) and at the `ctx.connection` client plugin that selects the default `WebApiClient`.
2. **There is no health-check endpoint.** The webserver only routes; readiness is `POST /api/host.describe` succeeding plus both downlink streams' `onOpen`. The single-server lock file must define its own probe.
3. **No daemon / PID / port-ping infrastructure exists.** `writeFileAtomic` always overwrites, so an exclusive claim needs `writeFile(..., { flag: 'wx' })` directly; detached background hosting must be built.
4. **`sdk/server` cannot drive the full chat UI.** `HarnessSdkJsonRpcServer` exposes only `initialize`/`session.prompt`/`shutdown`; `HarnessClient` can only spawn, not attach to an existing server. The shared server must be the `web`-profile HTTP server, and the VSCode webview bridges through the extension host.

Three facts the carriers depend on:

- The boot manifest is injected as an inline `<script>` (`packages/client/modules/src/index.ts`); a webview CSP forbids it, so the manifest must be de-inlined (`<script type="application/json">` plus an external loader).
- Client-module bundles are served at `/plugins/<id>/client.js` (a `/plugins` prefix route on the webserver).
- `WebApiClient` uses relative `/api`; it works under Electron `loadURL` (page origin = server) but breaks on a `vscode-webview://` origin, which is why the webview transport is custom.

## Alternatives considered

- **Thread the webview transport through `seams`.** Rejected: the seams interface carries only `loadBundle`; extending it to fetch/WebSocket would change the boot contract.
- **Adopt `sdk/server` as the shared-server protocol for VSCode.** Rejected: the three-method surface cannot serve the full chat panel, and `HarnessClient` cannot attach to an already-running server.
- **Add a `/api/health` endpoint to the webserver.** Deferred: the readiness contract (`host.describe` + `onOpen`) already exists; a bespoke endpoint would touch upstream `dsh-host-webserver`.

## Acceptance criteria

- The plan (docs/transformation/desktop-and-vscode.md) states these as conclusions, not open questions.
- M1's launcher probes readiness via `POST /api/host.describe`; M2's webview transport is an extension-host bridge; both hold across the milestones.

## Risks

- If `dsh-web-frontend` changes its boot mechanism, facts 5–7 go stale; the plan must be revisited.
- If upstream `dsh-host-webserver` later grows a health endpoint, fact 2's bespoke probe becomes redundant but harmless.
