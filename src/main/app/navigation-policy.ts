/** Pure URL rules for window navigation. No Electron imports so they can be unit-tested. */

/** True only for well-formed https URLs with a host and no embedded credentials. */
export function isSafeExternalUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  return u.protocol === 'https:' && u.hostname !== '' && u.username === '' && u.password === ''
}

/**
 * True only for the app's own entry. For a file:// bundle the path must match
 * exactly (hash/query ignored); for the dev server the origin must match.
 */
export function isAppUrl(raw: string, appEntryUrl: string): boolean {
  let u: URL
  let app: URL
  try {
    u = new URL(raw)
    app = new URL(appEntryUrl)
  } catch {
    return false
  }
  if (app.protocol === 'file:') return u.protocol === 'file:' && u.pathname === app.pathname
  return u.origin === app.origin
}
