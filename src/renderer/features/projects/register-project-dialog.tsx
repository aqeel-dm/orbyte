import { useState } from 'react'
import { FolderOpen, GitBranch, TriangleAlert } from 'lucide-react'
import type { PickDirectoryResult } from '@shared/schemas/project'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

type Picked = Extract<PickDirectoryResult, { cancelled: false }>

export function RegisterProjectDialog({ open, onOpenChange, onRegistered }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRegistered: () => void
}) {
  const [picked, setPicked] = useState<Picked | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = () => { setPicked(null); setName(''); setDescription(''); setError(null) }

  async function pick() {
    setError(null)
    const res = await window.orbyte.projects.pickDirectory()
    if (!res.ok) return setError(res.error.message)
    if (res.data.cancelled) return
    setPicked(res.data)
    setName((n) => n || (res.data as Picked).suggestedName)
  }

  async function submit() {
    if (!picked) return
    setBusy(true)
    setError(null)
    const res = await window.orbyte.projects.register({ token: picked.token, name, description })
    setBusy(false)
    if (!res.ok) {
      // Tokens are single-use; force a re-pick after any failure that consumed it.
      if (res.error.code !== 'INVALID_INPUT') setPicked(null)
      return setError(res.error.message)
    }
    reset()
    onOpenChange(false)
    onRegistered()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o) }}>
      <DialogContent>
        <DialogTitle className="text-lg font-semibold">Register project</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          Select an existing repository. Orbyte reads it but never modifies it.
        </DialogDescription>

        <div className="mt-5 space-y-4">
          <div>
            <Button variant="outline" onClick={pick}><FolderOpen className="h-4 w-4" />{picked ? 'Change directory' : 'Choose directory'}</Button>
            {picked && (
              <div className="mt-3 rounded-md border border-border bg-muted p-3 text-sm">
                <div className="break-all font-mono text-xs">{picked.path}</div>
                <div className="mt-2">
                  {picked.inspection.isGitRepo ? (
                    <Badge variant="success"><GitBranch className="mr-1 h-3 w-3" />Git · {picked.inspection.defaultBranch ?? 'detached'}</Badge>
                  ) : (
                    <Badge variant="warning"><TriangleAlert className="mr-1 h-3 w-3" />Not a Git repository. Worktree isolation will be unavailable.</Badge>
                  )}
                </div>
              </div>
            )}
          </div>
          <label className="block text-sm font-medium">Name
            <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} disabled={!picked} maxLength={100} />
          </label>
          <label className="block text-sm font-medium">Description <span className="font-normal text-muted-foreground">(optional)</span>
            <Input className="mt-1" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!picked} maxLength={1000} />
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!picked || !name.trim() || busy}>{busy ? 'Registering…' : 'Register'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
