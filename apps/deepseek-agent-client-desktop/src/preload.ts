/**
 * DeepSeek Agent Client Desktop — preload bridge.
 *
 * Exposes a minimal native surface to the renderer. The heavy lifting
 * (`host.pickDirectory`, `host.openPath`) already works over the loopback
 * HTTP API from the server page; only window/tray/notification/platform
 * conveniences are bridged here, under strict `contextIsolation`.
 */

import { contextBridge, ipcRenderer, Notification, shell } from 'electron'

contextBridge.exposeInMainWorld('dshNative', {
  /** Node platform identifier (`win32` / `darwin` / `linux`). */
  platform: process.platform,
  /** Open a path in the OS default handler; resolves to an error string or ''. */
  openPath: (path: string): Promise<string> => shell.openPath(path),
  /** Show a system notification. */
  showNotification: (title: string, body: string): void => {
    new Notification({ title, body }).show()
  },
  /** Browser-window controls requested by the renderer. */
  window: {
    minimize: (): void => { ipcRenderer.send('dsh.window.minimize') },
    toggleMaximize: (): void => { ipcRenderer.send('dsh.window.toggle-maximize') },
    close: (): void => { ipcRenderer.send('dsh.window.close') },
  },
})
