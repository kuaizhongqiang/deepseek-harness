/**
 * Electron type stub for the shared type-checking aggregates.
 *
 * Playwright's optional `typeof import('electron')` (guarded by its own
 * `@ts-ignore`) loads the real electron.d.ts whenever electron is installed,
 * and electron's `declare namespace NodeJS { interface Process }` augmentation
 * conflicts with @types/node's generic `process.off/once`. The host/client
 * aggregates do not use electron, so this stub satisfies resolution without
 * loading the augmentation. The desktop app's own tsconfig maps `electron`
 * back to the real types.
 */
declare module 'electron' {
  // Intentionally empty: resolution-only for the aggregates.
  const _electron: Record<string, never>
  export default _electron
}
