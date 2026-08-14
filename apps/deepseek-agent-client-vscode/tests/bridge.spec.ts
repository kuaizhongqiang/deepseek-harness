/**
 * Unit coverage for the webview ↔ extension-host message dispatch.
 */

import { describe, expect, it } from 'vitest'
import { dispatchMethod } from '../src/bridge.ts'

describe('dispatchMethod', () => {
  it('dispatches a dotted service.method path with the payload as argument', async () => {
    const client = {
      host: { describe: async (payload: unknown) => ({ echoed: payload }) },
    } as never
    await expect(dispatchMethod(client, 'host.describe', { x: 1 })).resolves.toEqual({ echoed: { x: 1 } })
  })

  it('rejects a method without a service dot', async () => {
    await expect(dispatchMethod({} as never, 'bare', {})).rejects.toThrow('invalid method')
  })

  it('rejects an unknown service', async () => {
    await expect(dispatchMethod({ host: {} } as never, 'nope.list', {})).rejects.toThrow('unknown service')
  })

  it('rejects an unknown method on a known service', async () => {
    await expect(dispatchMethod({ host: {} } as never, 'host.nope', {})).rejects.toThrow('unknown method')
  })
})
