/**
 * @deepseek-ai/dsh-server-app — the shared "server" profile composition.
 *
 * Desktop and VSCode both attach to one `dsh` web-server process. That server
 * is the `web` profile plus this bundle: the single-instance lock publisher
 * mounted on top, the webserver pinned to a dynamic loopback port, and the
 * profile name/bundle list the launcher bootstraps into `~/.dsh/profiles/`.
 */

/** The profile name the launcher bootstraps and spawns. */
export const SERVER_PROFILE_NAME = 'server'

/**
 * The bundle stack of the shared-server profile, applied over `dsh-base` and
 * `dsh-web-app` exactly like the shipped `web` template plus this bundle.
 */
export const SERVER_PROFILE_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-server-app',
]
