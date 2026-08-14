/**
 * Extension-host transport to the shared dsh server: an `AbstractApiClient`
 * whose uplink is Node `fetch` and whose downlink streams are `ws`
 * WebSockets. The extension host is a plain Node process, so the browser
 * `WebSocket` global is replaced with the `ws` package; the protocol
 * invariants (RPC envelope, unary parse, stream framing) come from
 * `@deepseek-ai/dsh-host-apiproxy`.
 */

import { AbstractApiClient, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { ApiProxy, HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy'
import { WebSocket } from 'ws'

/** The two server downlink paths (same as the browser connection carrier). */
export const MUX_EVENTS_PATH = '/api/events.mux'
export const HOST_EVENTS_PATH = '/api/events.host'

type SocketItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }

/**
 * Node carrier for the shared server. `resolveBase` is overridden so the
 * relative `/api` paths resolve against the server origin from the lock file,
 * exactly as the browser page origin does under Electron `loadURL`.
 */
export class VsCodeServerClient extends AbstractApiClient {
  constructor(private readonly baseUrl: string, timeoutMs?: number) {
    super(timeoutMs)
  }

  protected override resolveBase(): string {
    return this.baseUrl
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return fetch(input, init)
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket(MUX_EVENTS_PATH, signal, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket(HOST_EVENTS_PATH, signal, onOpen)
  }

  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(path, this.resolveBase())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    const inbox: SocketItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: SocketItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleOpen = (): void => { onOpen?.() }
    const handleMessage = (data: unknown): void => {
      let full: { rpcId: string; payload: unknown }
      try {
        full = JSON.parse(String(data)) as { rpcId: string; payload: unknown }
      } catch {
        console.error(`[dsh-vscode] dropping malformed WebSocket frame on ${path}`)
        return
      }
      enqueue({ kind: 'frame', envelope: { rpcId: RpcId(full.rpcId), payload: full.payload as F } })
    }
    const handleClose = (): void => { enqueue({ kind: 'end' }) }
    const handleAbort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    socket.on('open', handleOpen)
    socket.on('message', handleMessage)
    socket.on('close', handleClose)
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as SocketItem<F>
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.off('open', handleOpen)
      socket.off('message', handleMessage)
      socket.off('close', handleClose)
      handleAbort()
    }
  }
}
