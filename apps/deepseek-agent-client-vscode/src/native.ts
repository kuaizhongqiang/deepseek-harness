/**
 * Native IDE integration on the shared server downlink. These bridges consume
 * the same mux stream the webview renders and translate dsh capabilities into
 * VSCode surface (diff editor, terminal, native dialog). They are thin
 * `vscode`-bound wrappers; the frame shapes are parsed defensively because
 * they evolve with the harness's session events.
 */

import * as vscode from 'vscode'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy'

/** Extract the terminal id from an unknown frame payload, tolerating absence. */
function payloadId(frame: Frame): string {
  const id = (frame.payload as { id?: unknown } | undefined)?.id
  return typeof id === 'string' ? id : ''
}

interface ToolResultEvent {
  type?: string
  sessionId?: string
  payload?: {
    toolName?: string
    artifacts?: Array<{ kind?: string; path?: string; oldPath?: string; newPath?: string }>
    output?: unknown
  }
}

/** Frame payload envelope for mux events (defensive: unknown shape tolerated). */
type Frame = { type?: string; payload?: unknown }

/**
 * Open a VSCode diff editor when dsh's edit/str_replace tools land a
 * `tool/result` artifact.
 */
export async function installDiffBridge(mux: AsyncIterable<unknown>): Promise<void> {
  for await (const entry of mux) {
    const frame = (entry as { payload?: unknown }).payload as ToolResultEvent | undefined
    if (frame?.type !== 'tool/result') continue
    const artifacts = frame.payload?.artifacts ?? []
    for (const artifact of artifacts) {
      if (artifact.kind !== 'edit' || artifact.newPath === undefined) continue
      const original = artifact.oldPath ?? artifact.newPath
      const left = vscode.Uri.file(original)
      const right = vscode.Uri.file(artifact.newPath)
      await vscode.commands.executeCommand('vscode.diff', left, right)
    }
  }
}

/**
 * Surface dsh terminal (PTY) events in a VSCode `Pseudoterminal`. Kept
 * structural: a terminal frame carries an id plus output/exit facts.
 */
export async function installTerminalBridge(mux: AsyncIterable<unknown>): Promise<void> {
  const active = new Map<string, vscode.Terminal>()
  for await (const entry of mux) {
    const frame = (entry as { payload?: unknown }).payload as Frame | undefined
    if (frame === undefined || frame.type === undefined) continue
    if (frame.type === 'terminal/open') {
      const id = payloadId(frame)
      const pty: vscode.Pseudoterminal = {
        onDidWrite: new vscode.EventEmitter<string>().event,
        onDidClose: new vscode.EventEmitter<number>().event,
        open: () => {},
        close: () => {},
      }
      const terminal = vscode.window.createTerminal({ name: `dsh:${id}`, pty })
      active.set(id, terminal)
      terminal.show()
    } else if (frame.type === 'terminal/close') {
      const id = payloadId(frame)
      active.get(id)?.dispose()
      active.delete(id)
    }
  }
}

/**
 * Route the directory picker through VSCode's native dialog instead of the
 * server-side `host.pickDirectory` native picker.
 */
export function installDialogBridge(client: IApiClient): void {
  const host = client.host as unknown as { pickDirectory: (payload: unknown) => Promise<unknown> }
  const original = host.pickDirectory.bind(host)
  host.pickDirectory = async () => {
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select Directory' })
    const path = picked?.[0]?.fsPath
    return path ?? original({})
  }
}
