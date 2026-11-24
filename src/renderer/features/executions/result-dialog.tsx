import { AlertTriangle, Check, Sparkles } from 'lucide-react'
import { useState } from 'react'
import type { Task } from '@shared/schemas/task'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useExecution } from '@/hooks/use-execution'

const REC_LABEL = { approve: 'Recommends accepting', revise: 'Recommends revising', reject: 'Recommends rejecting' } as const
const REC_VARIANT = { approve: 'success', revise: 'warning', reject: 'destructive' } as const
const when = (t: number) => new Date(t).toLocaleString()

export function ResultDialog({ projectId, task, open, onOpenChange }: { projectId: string; task: Task; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { bundle, error, refresh } = useExecution(projectId, task.id)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [feedback, setFeedback] = useState('')

  const result = bundle?.results[0]
  const review = bundle?.reviews.find((r) => r.resultId === result?.id)
  const gate = bundle?.gate
  const run = bundle?.runs[0]

  async function act(fn: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setBusy(true); setActionError(null)
    const res = await fn()
    setBusy(false)
    if (!res.ok) return setActionError(res.error?.message ?? 'Something went wrong.')
    setAsking(false); setFeedback('')
    void refresh()
  }

  async function accept() {
    if (!result) return
    if (review && review.recommendation !== 'approve' && !window.confirm(`The Team Lead ${REC_LABEL[review.recommendation].toLowerCase()}. Accept anyway?`)) return
    await act(() => window.orbyte.executions.accept(projectId, task.id, result.id))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-auto">
        <DialogTitle className="text-lg font-semibold">Result for "{task.title}"</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">The task completes only when you accept a Team Lead-reviewed result whose code is unchanged.</DialogDescription>
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        {!bundle && !error && <p className="mt-3 text-sm text-muted-foreground">Loading…</p>}

        {bundle && gate && (
          <div className="mt-4 space-y-4">
            {run && run.status === 'running' && <Card className="p-3 text-sm">The agent is working (plan version {run.planVersion}). Watch it in the Agents tab.</Card>}
            {bundle.progress.length > 0 && (
              <div>
                <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agent progress notes (the agent's own words)</h4>
                <ul className="mt-1 space-y-1 text-sm">{bundle.progress.slice(-8).map((p) => <li key={p.id} className="whitespace-pre-wrap break-words"><span className="text-xs text-muted-foreground">{when(p.createdAt)} </span>{p.message}</li>)}</ul>
              </div>
            )}

            {!result ? <p className="text-sm text-muted-foreground">No result has been submitted yet.</p> : (
              <>
                <div className="text-sm"><span className="font-medium">Result version {result.version}</span> <span className="text-xs text-muted-foreground">submitted {when(result.submittedAt)}</span></div>

                <Card className="p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">What the agent says <Badge variant="warning">unverified (the agent's claim)</Badge></div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm">{result.summary}</p>
                  {result.tests.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-sm">{result.tests.map((t, n) => <li key={n} className="break-words"><code>{t.command}</code>: {t.passed ? 'reported as passed' : 'reported as FAILED'}{t.note ? ` (${t.note})` : ''}</li>)}</ul>
                  ) : <p className="mt-2 text-sm text-muted-foreground">The agent reported no test runs.</p>}
                  <p className="mt-2 text-xs text-muted-foreground">Orbyte did not run these tests.</p>
                </Card>

                <Card className="p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">What Orbyte collected from git <Badge variant="success">collected by Orbyte</Badge></div>
                  <p className="mt-1 text-xs text-muted-foreground">HEAD {result.evidence.headCommit.slice(0, 8)}{result.evidence.uncommitted ? ' · uncommitted changes (the agent does not commit)' : ''}</p>
                  {result.evidence.files.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No changed files were found.</p> : (
                    <ul className="mt-2 space-y-0.5 text-sm">{result.evidence.files.map((f) => <li key={f.path} className="break-all"><span className="text-xs text-muted-foreground">{f.status} </span>{f.path}{f.additions !== null && <span className="text-xs text-muted-foreground"> +{f.additions} −{f.deletions}</span>}</li>)}</ul>
                  )}
                  {result.evidence.truncated && <p className="mt-1 text-xs text-muted-foreground">The list was truncated.</p>}
                </Card>

                {review ? (
                  <Card className="p-3">
                    <div className="flex items-center gap-2 text-sm"><Sparkles className="h-4 w-4 text-primary" /><span className="font-medium">Team Lead's advice</span><Badge variant={REC_VARIANT[review.recommendation]}>{REC_LABEL[review.recommendation]}</Badge></div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm">{review.summary}</p>
                    {review.concerns.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{review.concerns.map((c, n) => <li key={n} className="whitespace-pre-wrap break-words">{c}</li>)}</ul>}
                    <p className="mt-2 text-xs text-muted-foreground">This is advice. Only your decision completes the task.</p>
                  </Card>
                ) : (
                  <Card className="flex items-center justify-between gap-3 p-3 text-sm">
                    <span className="text-muted-foreground">{bundle.reviewInProgress ? 'The Team Lead is reviewing this result…' : 'No Team Lead review yet. You can accept only after one exists.'}</span>
                    {!bundle.reviewInProgress && result.status === 'current' && <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => window.orbyte.executions.requestReview(projectId, task.id, result.id))}>Request review</Button>}
                  </Card>
                )}

                {gate.codeUnchanged === false && <Card className="flex items-start gap-2 border-warning/50 p-3 text-sm"><AlertTriangle className="mt-0.5 h-4 w-4 text-warning" />The code in the worktree has changed since this result was submitted. It cannot be accepted; ask for changes to get a new result.</Card>}
                {gate.state === 'accepted' && <p className="text-sm text-success">You accepted this result. The task is completed. Its changes are in the agent's worktree and branch; merge them yourself.</p>}
                {gate.blockers.length > 0 && gate.state === 'awaiting_decision' && <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">{gate.blockers.map((b, n) => <li key={n}>{b}</li>)}</ul>}

                {task.status === 'in_review' && result.status === 'current' && (
                  <div className="space-y-2">
                    {asking ? (
                      <>
                        <textarea className="min-h-[4rem] w-full rounded-md border border-border bg-card px-3 py-2 text-sm" placeholder="What should the agent change? It works within the approved plan." value={feedback} maxLength={2000} onChange={(e) => setFeedback(e.target.value)} aria-label="Requested changes" />
                        <div className="flex gap-2">
                          <Button disabled={busy || !feedback.trim()} onClick={() => act(() => window.orbyte.executions.requestChanges(projectId, task.id, result.id, feedback))}>Send to agent</Button>
                          <Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
                        </div>
                      </>
                    ) : (
                      <div className="flex gap-2">
                        <Button disabled={busy || !gate.canAccept} onClick={accept}><Check className="h-4 w-4" />Accept result</Button>
                        <Button variant="outline" disabled={busy} onClick={() => setAsking(true)}>Request changes…</Button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
