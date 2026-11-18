import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow } from 'electron'

/** URL of the renderer entry: the dev server in development, the built file otherwise. */
export function getAppEntryUrl(): string {
  return process.env['ELECTRON_RENDERER_URL'] ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false
    }
  })

  win.once('ready-to-show', () => win.show())
  // Navigation, window.open and permission rules live in app/security.ts (all web contents).
  void win.loadURL(getAppEntryUrl())
  return win
}
