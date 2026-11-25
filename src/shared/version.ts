/** Parses `1.2.3` or `v1.2.3`. Anything else (pre-release suffixes, extra parts, junk) is not a release version. */
export function parseVersion(raw: string): [number, number, number] | null {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(raw.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Negative if a < b, 0 if equal, positive if a > b. Unparseable versions compare as equal to nothing: callers check parseVersion first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return 0
}
