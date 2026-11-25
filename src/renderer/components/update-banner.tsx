import { Download, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/schemas/updates'
import { Button } from '@/components/ui/button'

/** Version, and a notice when a newer release exists. Nothing is installed from here: it opens the download page. */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await window.orbyte.updates.status()
    if (res.ok) setStatus(res.data)
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 60_000)
    return () => clearInterval(t)
  }, [load])

  async function check() {
    setBusy(true)
    setNote(null)
    const res = await window.orbyte.updates.check()
    if (res.ok) setStatus(res.data)
    else setNote(res.error.message)
    setBusy(false)
  }
  async function download() {
    const res = await window.orbyte.updates.openDownload()
    if (!res.ok) setNote(res.error.message)
  }

  if (!status) return null
  return (
    <div className="no-drag space-y-1 px-3 pb-1 text-xs text-muted-foreground">
      <p>Orbyte v{status.current}</p>
      {status.updateAvailable ? (
        <Button size="sm" className="w-full justify-start" onClick={download}><Download className="h-3.5 w-3.5" />Update to v{status.latest}</Button>
      ) : status.packaged ? (
        <Button variant="ghost" size="sm" className="h-7 w-full justify-start px-2 text-xs" onClick={check} disabled={busy}>
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />{busy ? 'Checking…' : 'Check for updates'}
        </Button>
      ) : <p>Development build</p>}
      {status.updateAvailable && <p>Download the new app and replace the old one in Applications.</p>}
      {!status.updateAvailable && status.packaged && status.checkedAt && !status.error && !busy && <p>Up to date.</p>}
      {(note ?? status.error) && <p role="alert" className="text-destructive">{note ?? status.error}</p>}
    </div>
  )
}
