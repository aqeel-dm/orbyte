import { app, session, shell } from 'electron'
import { isAppUrl, isSafeExternalUrl } from './navigation-policy'

/**
 * Process-wide guards applied to EVERY web contents (current and future), plus a
 * deny-all permission policy. Call after app is ready and before creating windows.
 */
export function installAppSecurity(appEntryUrl: string): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    const guard = (event: { preventDefault: () => void }, url: string): void => {
      if (!isAppUrl(url, appEntryUrl)) event.preventDefault()
    }
    contents.on('will-navigate', guard)
    contents.on('will-redirect', guard)
    contents.on('will-frame-navigate', (details) => guard(details, details.url))
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}
