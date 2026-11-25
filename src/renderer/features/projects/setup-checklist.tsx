import { CircleAlert, CircleCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SystemCheck } from '@shared/schemas/system'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

const LABEL = { git: 'Git', claude: 'Claude Code (the `claude` command)', secureStorage: 'Secure key storage' } as const
const KEY = 'setup-checklist-dismissed'
const read = () => { try { return localStorage.getItem(KEY) === '1' } catch { return false } }

/**
 * Shown while something Orbyte needs is missing, or until the first project is registered. It only reports what
 * Orbyte found. Whether Claude Code is signed in is not checked (that would need a request on your account).
 */
export function SetupChecklist({ projectCount, onRegister }: { projectCount: number; onRegister: () => void }) {
  const [check, setCheck] = useState<SystemCheck | null>(null)
  const [dismissed, setDismissed] = useState(read)
  useEffect(() => { void window.orbyte.system.check().then((r) => { if (r.ok) setCheck(r.data) }) }, [])
  if (!check) return null
  const missing = check.items.filter((i) => !i.ok)
  // Missing requirements are always shown; the getting-started steps can be dismissed.
  if (missing.length === 0 && (projectCount > 0 || dismissed)) return null

  return (
    <Card className="mt-6 p-4" aria-label="Getting started">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-semibold">{missing.length > 0 ? 'Something Orbyte needs is missing' : 'Getting started'}</h2>
        {missing.length === 0 && <Button size="sm" variant="ghost" onClick={() => { setDismissed(true); try { localStorage.setItem(KEY, '1') } catch { /* storage unavailable */ } }}>Dismiss</Button>}
      </div>
      <ul className="mt-3 space-y-2 text-sm">
        {check.items.map((i) => (
          <li key={i.id} className="flex items-start gap-2">
            {i.ok ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
            <div><span className="font-medium">{LABEL[i.id]}</span> <span className="text-muted-foreground">{i.detail}</span>{i.help && <p className="text-xs text-muted-foreground">{i.help}</p>}</div>
          </li>
        ))}
        <li className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div><span className="font-medium">Signed in to Claude Code</span> <span className="text-muted-foreground">not checked</span><p className="text-xs text-muted-foreground">Orbyte reuses your Claude Code login. If the Team Lead says you are not signed in, run `claude` once in a terminal and sign in.</p></div>
        </li>
        <li className="flex items-start gap-2">
          {projectCount > 0 ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
          <div className="flex-1"><span className="font-medium">Register a project</span> <span className="text-muted-foreground">{projectCount > 0 ? `${projectCount} registered` : 'none yet'}</span>
            {projectCount === 0 && <div className="mt-1"><Button size="sm" onClick={onRegister}>Register a project</Button></div>}</div>
        </li>
      </ul>
    </Card>
  )
}
