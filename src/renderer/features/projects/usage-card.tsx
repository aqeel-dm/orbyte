import { useCallback, useEffect, useState } from 'react'
import type { TokenTotals, UsageSummary } from '@shared/schemas/usage'
import { Card } from '@/components/ui/card'

const n = (v: number) => v.toLocaleString()
const total = (t: TokenTotals) => t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens

function Tokens({ t }: { t: TokenTotals }) {
  return <p className="text-xs text-muted-foreground">{n(t.inputTokens)} input · {n(t.outputTokens)} output · {n(t.cacheReadTokens)} cache read · {n(t.cacheCreationTokens)} cache write</p>
}

/** Usage figures are estimates and say where each one comes from. Nothing here is a bill. */
export function UsageCard({ projectId }: { projectId: string }) {
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const load = useCallback(() => { void window.orbyte.usage.get(projectId).then((r) => { if (r.ok) setUsage(r.data) }) }, [projectId])
  useEffect(() => {
    load()
    return window.orbyte.onEvent((e) => { if (e.projectId === projectId && (e.type === 'turn_completed' || e.type === 'agent_changed')) load() })
  }, [projectId, load])
  if (!usage) return null
  const { teamLead: t, agents: a } = usage

  return (
    <Card className="p-4">
      <h2 className="font-semibold">Usage (estimates)</h2>
      <div className="mt-2 grid gap-3 text-sm md:grid-cols-2">
        <div>
          <div className="font-medium">Team Lead</div>
          {t.sessions === 0 ? <p className="text-xs text-muted-foreground">Nothing recorded yet.</p> : (
            <>
              <p>{n(total(t))} tokens <span className="text-muted-foreground">· about ${t.costUsd.toFixed(2)}</span></p>
              <Tokens t={t} />
              <p className="mt-1 text-xs text-muted-foreground">Reported by the Claude Agent SDK as an estimate. With a Claude subscription login the dollar figure is not what you are charged; it only shows relative use. Counted from when this version started recording.</p>
            </>
          )}
        </div>
        <div>
          <div className="font-medium">Developer agents</div>
          {a.agentsRead === 0 ? <p className="text-xs text-muted-foreground">{a.agentsUnreadable > 0 ? 'Usage could not be read for this project\'s agents.' : 'No agents yet.'}</p> : (
            <>
              <p>{n(total(a))} tokens</p>
              <Tokens t={a} />
              <p className="mt-1 text-xs text-muted-foreground">Read from Claude Code's own session files for {a.agentsRead} agent session(s){a.agentsUnreadable > 0 ? `; ${a.agentsUnreadable} could not be read (the file is missing or in an unexpected format)` : ''}. No dollar figure: Orbyte has no price list.</p>
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
