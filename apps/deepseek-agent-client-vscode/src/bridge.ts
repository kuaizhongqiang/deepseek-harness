/**
 * Webview ↔ extension-host message envelope and dispatch. The webview is
 * fully offline (CSP `connect-src` closed); all RPC and stream traffic flows
 * through `acquireVsCodeApi().postMessage`. This module owns the envelope
 * shape and the method dispatch — pure, no `vscode` import — so it is
 * unit-testable.
 */

import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy'

/** webview → extension host: one unary RPC, method as a dotted IApiClient path. */
export type VsMsgReq = { kind: 'rpc'; rpcId: string; method: string; payload: unknown }

/** webview → extension host: open (or re-subscribe) a downlink stream. */
export type VsMsgSub = { kind: 'subscribe'; stream: 'mux' | 'host' }

/** extension host → webview: unary reply. */
export type VsMsgRes =
  | { kind: 'rpc-reply'; rpcId: string; ok: true; result: unknown }
  | { kind: 'rpc-reply'; rpcId: string; ok: false; error: unknown }

/** extension host → webview: one downlink frame. */
export type VsMsgFrame = { kind: 'frame'; stream: 'mux' | 'host'; frame: unknown }

/** extension host → webview: readiness/connection state. */
export type VsMsgState = { kind: 'state'; connected: boolean; description: string; loopback: boolean }

/** Every message either side may emit. */
export type VsMessage = VsMsgReq | VsMsgSub | VsMsgRes | VsMsgFrame | VsMsgState

/**
 * Dispatch a dotted IApiClient method path (e.g. `host.describe` or
 * `sessions.list`) against a client. The path mirrors the client's service
 * grouping, so the webview's serialized method needs no translation.
 * @param client - the client whose service methods are invoked.
 * @param method - dotted `service.name` path.
 * @param payload - the single argument passed to the method.
 * @returns the awaited result.
 * @throws when the service or method is unknown.
 */
export async function dispatchMethod(client: IApiClient, method: string, payload: unknown): Promise<unknown> {
  const separator = method.indexOf('.')
  if (separator === -1) throw new Error(`dsh-vscode: invalid method ${JSON.stringify(method)}`)
  const service = method.slice(0, separator)
  const name = method.slice(separator + 1)
  const root = client as unknown as Record<string, unknown>
  const svc = root[service]
  if (svc === null || typeof svc !== 'object') throw new Error(`dsh-vscode: unknown service ${JSON.stringify(service)}`)
  const fn = (svc as Record<string, unknown>)[name]
  if (typeof fn !== 'function') throw new Error(`dsh-vscode: unknown method ${JSON.stringify(method)}`)
  return await (fn as (payload: unknown) => unknown).call(svc, payload)
}
