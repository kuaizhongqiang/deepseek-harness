/**
 * Unit coverage for the webview HTML rewrite: manifest de-inlining, asset and
 * bundle URL rewriting to the server origin, connection-row override, and the
 * CSP/loader injection.
 */

import { describe, expect, it } from 'vitest'
import { buildWebviewHtml, extractBootManifest, rewriteManifestUrls, webviewCsp } from '../src/webview-boot.ts'
import type { BootModuleRow } from '../src/webview-boot.ts'

const SERVER_HTML = [
  '<!doctype html><html><head><meta charset="utf-8">',
  `<script>window.__DSH_BOOT__ = ${JSON.stringify({ modules: [{ id: 'connection', url: '/plugins/@deepseek-ai/dsh-client-connection/client.js?rev=abc', rev: 'abc' }], plugins: [] })}</script>`,
  '<link rel="stylesheet" href="/assets/index.css">',
  '</head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>',
].join('')

describe('webview-boot', () => {
  it('extracts the inline boot manifest', () => {
    const manifest = extractBootManifest(SERVER_HTML)
    const first = manifest.modules[0] as BootModuleRow
    expect(first).toMatchObject({ id: 'connection', rev: 'abc' })
  })

  it('rewrites manifest bundle URLs to the server origin', () => {
    const manifest = rewriteManifestUrls(extractBootManifest(SERVER_HTML), 'http://127.0.0.1:1234')
    const first = manifest.modules[0] as BootModuleRow
    expect(first.url).toBe('http://127.0.0.1:1234/plugins/@deepseek-ai/dsh-client-connection/client.js?rev=abc')
  })

  it('builds a webview-ready document: de-inlined manifest, absolute assets, loader, CSP', () => {
    const { html, bootManifest } = buildWebviewHtml({
      serverHtml: SERVER_HTML,
      serverOrigin: 'http://127.0.0.1:1234',
      bootLoaderUrl: 'vscode-webview-resource://x/boot-loader.js',
    })
    expect(html).not.toContain('<script>window.__DSH_BOOT__')
    expect(html).toContain('<script type="application/json" id="dsh-boot">')
    expect(html).toContain('src="http://127.0.0.1:1234/assets/index.js"')
    expect(html).toContain('href="http://127.0.0.1:1234/assets/index.css"')
    expect(html).toContain('src="vscode-webview-resource://x/boot-loader.js"')
    expect(html).toContain('http-equiv="Content-Security-Policy"')
    expect(html).toContain(webviewCsp())
    expect((bootManifest.modules[0] as BootModuleRow).url.startsWith('http://127.0.0.1:1234')).toBe(true)
  })

  it('overrides the connection row module URL with the webview transport bundle', () => {
    const { bootManifest } = buildWebviewHtml({
      serverHtml: SERVER_HTML,
      serverOrigin: 'http://127.0.0.1:1234',
      bootLoaderUrl: 'vscode-webview-resource://x/boot-loader.js',
      connectionModuleUrl: 'vscode-webview-resource://x/vscode-connection.js',
    })
    expect((bootManifest.modules[0] as BootModuleRow).url).toBe('vscode-webview-resource://x/vscode-connection.js')
  })

  it('throws when the served html carries no boot manifest', () => {
    expect(() => buildWebviewHtml({
      serverHtml: '<html><head></head><body></body></html>',
      serverOrigin: 'http://127.0.0.1:1',
      bootLoaderUrl: 'u',
    })).toThrow('no inline boot manifest')
  })
})
