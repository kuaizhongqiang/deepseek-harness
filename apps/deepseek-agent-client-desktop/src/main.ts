/**
 * DeepSeek Agent Client Desktop — Electron main process.
 *
 * Detects and attaches to the shared dsh server (via `dsh-server-launcher`),
 * lazily starting it when unreachable, then loads the web UI straight from the
 * server URL — the same SPA `dsh web` serves, so every web feature works with
 * zero adaptation. Closing the window never stops the server; it survives for
 * other clients (VSCode, another desktop instance) to share.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, nativeImage, Notification, shell, Tray } from 'electron'
import { ensureServer } from '@deepseek-ai/dsh-server-launcher'

/** 1×1 PNG placeholder; packaging replaces it with a real tray/icon asset. */
const TRAY_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const HERE = fileURLToPath(new URL('.', import.meta.url))

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined

/**
 * Resolve the server command. An explicit `DSH_CLIENT_DESKTOP_SERVER_COMMAND`
 * JSON array wins; otherwise the bundled CLI (under the packaged resources)
 * is preferred; dev falls back to `dsh` on PATH.
 */
function resolveServerCommand(): string[] {
  const override = process.env.DSH_CLIENT_DESKTOP_SERVER_COMMAND
  if (override !== undefined) return JSON.parse(override) as string[]
  // The closure keeps the CLI entry under lib/ so its `../package.json`
  // anchor resolves to the closure manifest (see scripts/build-dsh-cli.ts).
  const bundled = join(process.resourcesPath, 'dsh-cli', 'lib', 'bin.js')
  if (existsSync(bundled)) return ['node', bundled, '--profile', 'server', '--port', '0']
  return ['dsh', '--profile', 'server', '--port', '0']
}

function createTray(serverUrl: string): void {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Agent Client')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open DeepSeek Agent Client',
      click: () => {
        if (mainWindow === undefined) return
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      },
    },
    { type: 'separator' },
    { label: `Server: ${serverUrl}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit() } },
  ]))
}

async function bootstrap(): Promise<void> {
  const server = await ensureServer({ command: resolveServerCommand(), bootstrap: true })
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: {
      preload: join(HERE, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  // Keep the window on the server origin; deny new windows.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(server.url)) event.preventDefault()
  })
  void mainWindow.loadURL(server.url)
  mainWindow.on('closed', () => { mainWindow = undefined })
  createTray(server.url)
}

const gotSingleInstance = app.requestSingleInstanceLock()
if (!gotSingleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  void app.whenReady().then(bootstrap)
}

// Referenced so tree-shaking keeps the module-level notification/shell imports
// meaningful to readers; the renderer's native surface is exposed via preload.
void Notification
void shell
