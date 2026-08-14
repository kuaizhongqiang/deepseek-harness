/**
 * Webview bootstrap: reuse the exact SPA the server serves. A VSCode webview
 * cannot `loadURL` a remote page, so the extension host fetches the server's
 * index.html (which already carries the inline boot manifest), de-inlines the
 * manifest into a `<script type="application/json">` element, rewrites the
 * Vite asset URLs and the manifest's `/plugins/*` bundle URLs to server-
 * absolute URLs, prepends an external classic loader, and injects the CSP.
 * Pure string logic — no `vscode` import — so it is unit-testable.
 */

/** One client-module row of the boot manifest. */
export interface BootModuleRow {
  id: string
  url: string
  rev: string
}

/** The boot graph the host injects as `window.__DSH_BOOT__`. */
export interface BootManifest {
  modules: BootModuleRow[]
  plugins: unknown[]
}

const BOOT_SCRIPT_PATTERN = /<script>window\.__DSH_BOOT__ = (\{.*\})<\/script>/

/** The webview CSP for the bridged transport (data via postMessage) + server-served scripts. */
export function webviewCsp(): string {
  return "default-src 'none'; script-src 'vscode-webview-resource:' http://127.0.0.1:*;"
    + " style-src 'unsafe-inline' 'vscode-webview-resource:' http://127.0.0.1:*;"
    + " img-src 'vscode-webview-resource:' http://127.0.0.1:* data:;"
    + " font-src 'vscode-webview-resource:' http://127.0.0.1:* data:;"
    + " connect-src 'vscode-webview-resource:'; frame-src 'none'"
}

/** Parse and validate the inline boot manifest from the served index.html. */
export function extractBootManifest(serverHtml: string): BootManifest {
  const match = BOOT_SCRIPT_PATTERN.exec(serverHtml)
  if (match === null) throw new Error('dsh-vscode: served index.html carries no inline boot manifest')
  const json = match[1]
  if (json === undefined) throw new Error('dsh-vscode: served index.html carries no inline boot manifest')
  const parsed = JSON.parse(json) as Partial<BootManifest>
  if (!Array.isArray(parsed.modules)) {
    throw new Error('dsh-vscode: boot manifest has no modules array')
  }
  return parsed as BootManifest
}

/**
 * Rewrite the manifest's `/plugins/*` bundle URLs to server-absolute URLs so
 * the webview's default `<script src>` loader can fetch them cross-origin.
 */
export function rewriteManifestUrls(manifest: BootManifest, serverOrigin: string): BootManifest {
  return {
    ...manifest,
    modules: manifest.modules.map(module => ({
      ...module,
      url: module.url.startsWith('/') ? `${serverOrigin}${module.url}` : module.url,
    })),
  }
}

/**
 * Rewrite a server-rendered index.html into a webview-ready document.
 * @param input - the served html, server origin, loader URL, and an optional
 * override that points the boot manifest's `connection` row at the webview's
 * postMessage transport bundle (vscode-connection.js) instead of the server's
 * WebApiClient.
 */
export function buildWebviewHtml(input: {
  serverHtml: string
  serverOrigin: string
  bootLoaderUrl: string
  connectionModuleUrl?: string
}): { html: string; bootManifest: BootManifest } {
  const { serverHtml, serverOrigin, bootLoaderUrl } = input
  let manifest = rewriteManifestUrls(extractBootManifest(serverHtml), serverOrigin)
  if (input.connectionModuleUrl !== undefined) {
    manifest = {
      ...manifest,
      modules: manifest.modules.map(module =>
        module.id === 'connection' ? { ...module, url: input.connectionModuleUrl as string } : module,
      ),
    }
  }

  // De-inline the manifest: CSP forbids inline scripts, a non-executable JSON
  // tag does not count as one, and the classic boot-loader reads it.
  const json = JSON.stringify(manifest).replaceAll('<', '\\u003c')
  const deInlined = serverHtml.replace(
    BOOT_SCRIPT_PATTERN,
    `<script type="application/json" id="dsh-boot">${json}</script>`,
  )

  // Rewrite the Vite asset references to server-absolute URLs (classic-script
  // and stylesheet cross-origin loads have no CORS restriction).
  const assets = deInlined.replaceAll('src="/assets/', `src="${serverOrigin}/assets/`)
    .replaceAll('href="/assets/', `href="${serverOrigin}/assets/`)

  // Prepend the classic loader + CSP at the top of <head>; the loader runs
  // before the deferred module scripts, so AppWebEntry.run() sees the manifest.
  const headStart = '<head>'
  const headIndex = assets.indexOf(headStart)
  const headPrefix = headIndex === -1 ? '' : assets.slice(0, headIndex + headStart.length)
  const headSuffix = headIndex === -1 ? assets : assets.slice(headIndex + headStart.length)
  const injection = `<meta http-equiv="Content-Security-Policy" content="${webviewCsp()}">`
    + `<script src="${bootLoaderUrl}"></script>`
  return { html: `${headPrefix}${injection}${headSuffix}`, bootManifest: manifest }
}
