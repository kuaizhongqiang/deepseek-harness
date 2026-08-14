/**
 * DeepSeek Agent Client for VSCode — extension host entry. It connects to the
 * shared dsh server (see `dsh-server-launcher`), serves the chat panel as a
 * fully-offline webview that talks only through postMessage, bridges RPC and
 * downlink streams over `VsCodeServerClient`, and wires the native
 * diff/terminal/dialog integration on the same downlink.
 */

import * as vscode from 'vscode'
import type { Disposable, Webview, WebviewView, WebviewViewProvider, WebviewViewResolveContext } from 'vscode'
import { ensureServer } from '@deepseek-ai/dsh-server-launcher'
import { dispatchMethod } from './bridge.ts'
import type { VsMessage } from './bridge.ts'
import { VsCodeServerClient } from './server-client.ts'
import { buildWebviewHtml } from './webview-boot.ts'
import { installDiffBridge, installDialogBridge, installTerminalBridge } from './native.ts'

/** Where the extension ships its webview resources (boot loader + connection plugin). */
function webviewResourceUrl(context: vscode.ExtensionContext, webview: Webview, path: string): string {
  return webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'resources', 'webview', path)).toString()
}

class ChatPanelProvider implements WebviewViewProvider {
  private readonly client: VsCodeServerClient
  private readonly serverOrigin: string

  constructor(private readonly context: vscode.ExtensionContext, serverOrigin: string, client: VsCodeServerClient) {
    this.serverOrigin = serverOrigin
    this.client = client
  }

  async resolveWebviewView(view: WebviewView, _context: WebviewViewResolveContext): Promise<void> {
    const webview = view.webview
    webview.options = { enableScripts: true }
    const serverHtml = await fetch(this.serverOrigin).then(r => r.text())
    const bootLoaderUrl = webviewResourceUrl(this.context, webview, 'boot-loader.js')
    const { html } = buildWebviewHtml({ serverHtml, serverOrigin: this.serverOrigin, bootLoaderUrl })
    webview.html = html

    webview.onDidReceiveMessage((message: VsMessage) => {
      void this.handleMessage(message, webview)
    })
  }

  private async handleMessage(message: VsMessage, webview: Webview): Promise<void> {
    switch (message.kind) {
      case 'rpc': {
        try {
          const result = await dispatchMethod(this.client, message.method, message.payload)
          void webview.postMessage({ kind: 'rpc-reply', rpcId: message.rpcId, ok: true, result })
        } catch (error) {
          void webview.postMessage({ kind: 'rpc-reply', rpcId: message.rpcId, ok: false, error: String(error) })
        }
        break
      }
      case 'subscribe': {
        const controller = new AbortController()
        const stream = message.stream === 'mux'
          ? this.client.events.mux({}, controller.signal)
          : this.client.events.host({}, controller.signal)
        void this.forwardStream(stream, message.stream, webview)
        break
      }
      default:
        break
    }
  }

  private async forwardStream(stream: AsyncIterable<unknown>, name: 'mux' | 'host', webview: Webview): Promise<void> {
    try {
      for await (const entry of stream) {
        const frame = (entry as { payload?: unknown }).payload
        void webview.postMessage({ kind: 'frame', stream: name, frame })
      }
    } catch (error) {
      console.error(`[dsh-vscode] ${name} stream ended with error:`, error)
    }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const server = await ensureServer({ command: ['dsh', '--profile', 'server', '--port', '0'], bootstrap: true })
  const client = new VsCodeServerClient(server.url)

  // Native integration observes the same downlink the webview consumes.
  const nativeController = new AbortController()
  const nativeMux = client.events.mux({}, nativeController.signal)
  void installDiffBridge(nativeMux)
  void installTerminalBridge(nativeMux)
  installDialogBridge(client)

  const disposables: Disposable[] = [
    vscode.commands.registerCommand('dsh.chat.open', () => {
      void vscode.commands.executeCommand('workbench.view.extension.dsh')
    }),
    vscode.window.registerWebviewViewProvider('dsh.chat', new ChatPanelProvider(context, server.url, client)),
  ]
  context.subscriptions.push(...disposables)
}

export function deactivate(): void {
  // The shared server outlives this extension host; nothing to tear down here.
}
