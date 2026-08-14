/**
 * Composition constants and invariant-companion coverage for the shared
 * "server" bundle.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SERVER_PROFILE_BUNDLES, SERVER_PROFILE_NAME } from '../src/index.ts'

describe('dsh-server-app', () => {
  it('declares the shared-server profile name and bundle stack', () => {
    expect(SERVER_PROFILE_NAME).toBe('server')
    expect(SERVER_PROFILE_BUNDLES).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-server-app',
    ])
  })

  it('registers under the test invariant host when a context mounts a plugin', async () => {
    const ctx = new Context()
    await ctx.plugin(() => {})
    await ctx.fiber.dispose()
  })
})
