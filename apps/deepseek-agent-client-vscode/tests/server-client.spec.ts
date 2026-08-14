/**
 * Integration coverage for the extension-host transport: the WebSocket
 * downlink yields parsed frames (and drops malformed ones) against a real
 * `ws` server on a loopback port.
 */

import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy'
import { VsCodeServerClient } from '../src/server-client.ts'

const servers: WebSocketServer[] = []

async function startWs(): Promise<WebSocketServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(wss)
  await once(wss, 'listening')
  return wss
}

function portOf(wss: WebSocketServer): number {
  return (wss.address() as AddressInfo).port
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (wss) => {
    await new Promise<void>((resolve) => { wss.close(() => { resolve() }) })
  }))
})

describe('VsCodeServerClient', () => {
  it('yields a mux frame from the WebSocket downlink', async () => {
    const wss = await startWs()
    wss.on('connection', (socket) => {
      socket.send(JSON.stringify({ rpcId: 'r1', payload: { type: 'session/event', sessionId: 's1' } }))
    })
    const client = new VsCodeServerClient(`http://127.0.0.1:${portOf(wss)}`)
    const controller = new AbortController()
    const iterator = client.events.mux({}, controller.signal)[Symbol.asyncIterator]()
    const { value, done } = await iterator.next() as { value: RpcRequest<{ type: string }>; done: boolean }
    expect(done).toBe(false)
    expect(value).toMatchObject({ rpcId: 'r1', payload: { type: 'session/event', sessionId: 's1' } })
    controller.abort()
    await iterator.return?.(undefined)
  })

  it('yields a host frame and drops a malformed frame', async () => {
    const wss = await startWs()
    wss.on('connection', (socket) => {
      socket.send('not json')
      socket.send(JSON.stringify({ rpcId: 'r2', payload: { type: 'host/frame', value: 7 } }))
    })
    const client = new VsCodeServerClient(`http://127.0.0.1:${portOf(wss)}`)
    const controller = new AbortController()
    const iterator = client.events.host({}, controller.signal)[Symbol.asyncIterator]()
    const { value, done } = await iterator.next() as { value: RpcRequest<{ type: string }>; done: boolean }
    expect(done).toBe(false)
    expect(value).toMatchObject({ rpcId: 'r2', payload: { type: 'host/frame', value: 7 } })
    controller.abort()
    await iterator.return?.(undefined)
  })
})
