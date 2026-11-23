import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DiscoveryResult } from '@shared/schemas/onboarding'
import type { Project } from '@shared/schemas/project'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

/**
 * Asks the user whether this repository's own Claude settings (hooks etc.) may load
 * for the Team Lead. Nothing runs until the user decides; the choice can be changed later.
 */
export function TrustPanel({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const unset = project.repoSettingsTrust === 'unset'

  useEffect(() => {
    if (!unset) return
    let cancelled = false
    void window.orbyte.projects.discover(project.id).then((res) => { if (!cancelled && res.ok) setDiscovery(res.data) })
    return () => { cancelled = true }
  }, [project.id, unset])

  async function decide(trust: 'trusted' | 'untrusted') {
    setBusy(true); setError(null)
    const res = await window.orbyte.projects.setTrust(project.id, trust)
    setBusy(false)
    if (!res.ok) return setError(res.error.message)
    onChanged()
  }

  if (!unset) {
    const trusted = project.repoSettingsTrust === 'trusted'
    return (
      <Card className="flex items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-2 text-sm">
          {trusted ? <ShieldCheck className="h-4 w-4 text-success" /> : <ShieldAlert className="h-4 w-4 text-muted-foreground" />}
          <span className="font-medium">Repository settings</span>
          <Badge variant={trusted ? 'success' : 'default'}>{trusted ? 'Trusted: hooks and settings load' : 'Not used'}</Badge>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => decide(trusted ? 'untrusted' : 'trusted')}>
          {trusted ? 'Stop using' : 'Trust and use'}
        </Button>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </Card>
    )
  }

  const risky = discovery?.claudeDir.riskySettingsKeys ?? []
  return (
    <Card className="border-warning/50 p-4">
      <div className="flex items-center gap-2"><ShieldAlert className="h-5 w-5 text-warning" /><h2 className="font-semibold">Use this repository's Claude settings?</h2></div>
      <p className="mt-2 text-sm">
        A repository can ship Claude Code hooks and settings that run commands on your computer whenever the Team Lead works in it. Until you decide, the Team Lead and onboarding stay off. Only trust repositories you own or have reviewed.
      </p>
      <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
        {discovery === null ? <li>Checking the repository…</li> : (
          <>
            <li>CLAUDE.md files: {discovery.claudeMdFiles.length}</li>
            <li>.claude/ directory: {discovery.claudeDir.exists ? `yes (${discovery.claudeDir.rules.length} rules, ${discovery.claudeDir.skills.length} skills)` : 'no'}</li>
            <li className={risky.length ? 'font-medium text-warning' : ''}>Settings that can run code or change behavior: {risky.length ? risky.join(', ') : 'none found'}</li>
          </>
        )}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        “Don't use” still lets the Team Lead read the repository's files with read-only tools; it just ignores the repo's own settings. Your personal Claude settings always apply.
      </p>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex gap-2">
        <Button disabled={busy} onClick={() => decide('trusted')}>Trust and use repo settings</Button>
        <Button variant="outline" disabled={busy} onClick={() => decide('untrusted')}>Don't use repo settings</Button>
      </div>
    </Card>
  )
}
