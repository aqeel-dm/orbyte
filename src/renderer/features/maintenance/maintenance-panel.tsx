import { DatabaseBackup, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { MaintenanceScan } from '@shared/schemas/maintenance'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

/** Backup and cleanup of leftovers. Nothing here takes a path: the save location and the folders are chosen in main. */
export function MaintenancePanel() {
  const [scan, setScan] = useState<MaintenanceScan | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(fn: () => Promise<string | null>) {
    setBusy(true); setMessage(null)
    try { setMessage(await fn()) } catch { setMessage('Cannot reach the application backend.') }
    setBusy(false)
  }

  const backup = () => run(async () => {
    const res = await window.orbyte.maintenance.backupDatabase()
    return res.ok ? (res.data.saved ? 'Backup saved.' : null) : res.error.message
  })
  const check = () => run(async () => {
    const res = await window.orbyte.maintenance.scan()
    if (!res.ok) return res.error.message
    setScan(res.data)
    return res.data.orphanWorktrees.length === 0 ? 'Nothing left over.' : null
  })
  const clean = () => run(async () => {
    if (!scan) return null
    const res = await window.orbyte.maintenance.cleanOrphans(scan.orphanWorktrees.map((o) => o.id))
    if (!res.ok) return res.error.message
    const again = await window.orbyte.maintenance.scan()
    if (again.ok) setScan(again.data)
    return `Removed ${res.data.removed}.${res.data.skipped.length ? ` Kept ${res.data.skipped.length}: ${res.data.skipped.map((s) => s.reason).join(' ')}` : ''}`
  })

  return (
    <Card className="mt-8 p-4">
      <h2 className="text-sm font-medium">Maintenance</h2>
      <p className="mt-1 text-xs text-muted-foreground">Back up Orbyte's database, or find worktree folders that no agent owns any more (for example after a crash). A folder with uncommitted changes is never removed.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={backup}><DatabaseBackup className="h-4 w-4" />Back up database…</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={check}>Look for leftovers</Button>
        {scan && scan.orphanWorktrees.length > 0 && <Button size="sm" variant="destructive" disabled={busy} onClick={() => window.confirm(`Remove ${scan.orphanWorktrees.length} leftover worktree folder(s)?`) && void clean()}><Trash2 className="h-4 w-4" />Remove {scan.orphanWorktrees.length}</Button>}
      </div>
      {scan && scan.orphanWorktrees.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">{scan.orphanWorktrees.map((o) => <li key={o.id} className="break-all"><span className="text-muted-foreground">{o.projectName ?? 'unknown project'} · </span>{o.name}</li>)}</ul>
      )}
      {message && <p role="status" className="mt-3 text-sm text-muted-foreground">{message}</p>}
    </Card>
  )
}
