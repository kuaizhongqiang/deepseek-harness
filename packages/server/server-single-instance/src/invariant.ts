/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-server-single-instance`.
 * @module @deepseek-ai/dsh-server-single-instance/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-server-single-instance'

/** Cordis companion plugin name. */
export const name = 'server-single-instance-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the lock publish/cleanup contract lives entirely in
 * the filesystem and is pinned by the package unit tests (content, readiness,
 * and dispose cleanup). There is no in-process event stream or mutable
 * runtime data for the package to own beyond that.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
