import { AlertTriangle, Check, Copy, Play, Sparkles } from 'lucide-react'
import { useState } from 'react'
import type { Task } from '@shared/schemas/task'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { buildMergeGuidance } from '@shared/merge-guidance'
import { useAgents } from '@/hooks/use-agents'
import { useExecution } from '@/hooks/use-execution'

const REC_LABEL = { approve: 'Recommends accepting', revise: 'Recommends revising', reject: 'Recommends rejecting' } as const
const REC_VARIANT = { approve: 'success', revise: 'warning', reject: 'destructive' } as const
const when = (t: number) => new Date(t).toLocaleString()

export function ResultDialog({ projectId, repoPath, task, open, onOpenChange }: { projectId: string; repoPath: string; task: Task; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { bundle, testRuns, error, refresh } = useExecution(projectId, task.id)
  const { agents } = useAgents(projectId)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [feedback, setFeedback] = useState('')

  const result = bundle?.results[0]
  const review = bundle?.reviews.find((r) => r.resultId === result?.id)
  const gate = bundle?.gate
  const run = bundle?.runs[0]
  const agent = agents.find((a) => a.id === run?.agentId)

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

                <Card className="p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-medium">Tests Orbyte ran <Badge variant="success">collected by Orbyte</Badge></div>
                    {result.status === 'current' && task.status === 'in_review' && (
                      <Button size="sm" variant="outline" disabled={busy || testRuns[0]?.status === 'running' || gate.codeUnchanged === false}
                        onClick={() => { if (window.confirm("Run this project's test script in the agent's worktree? It executes the agent's code on your machine, as you.")) void act(() => window.orbyte.executions.runTests(projectId, task.id, result.id)) }}>
                        <Play className="h-3.5 w-3.5" />{testRuns[0]?.status === 'running' ? 'Running…' : 'Run tests'}
                      </Button>
                    )}
                  </div>
                  {testRuns.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">Not run. Orbyte runs the <code>test</code> script from package.json if there is one. A fresh worktree has no installed dependencies, so tests may fail for that reason; the output below shows what happened.</p> : (
                    <ul className="mt-2 space-y-2">{testRuns.slice(0, 3).map((t) => (
                      <li key={t.id} className="text-sm">
                        <span className="font-mono text-xs">{t.command}</span>{' '}
                        <Badge variant={t.status === 'passed' ? 'success' : t.status === 'running' ? 'default' : 'destructive'}>{t.status === 'timed_out' ? 'timed out' : t.status}{t.exitCode !== null && t.status === 'failed' ? ` (exit ${t.exitCode})` : ''}</Badge>
                        <span className="text-xs text-muted-foreground"> {when(t.startedAt)}{t.resultId !== result.id ? ' · an older result' : t.snapshotHash !== result.evidence.snapshotHash ? ' · different code' : ''}</span>
                        {t.status !== 'running' && t.output && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">{t.output}</pre>}
                      </li>))}</ul>
                  )}
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
                {gate.state === 'accepted' && agent && !agent.worktreeRemoved && (
                  <Card className="p-3">
                    <h4 className="text-sm font-medium">To merge it yourself</h4>
                    <p className="mt-1 text-xs text-muted-foreground">Orbyte does not run these. Copy them into a terminal when you are ready; check them first.</p>
                    <ol className="mt-2 space-y-2">
                      {buildMergeGuidance({ repoPath, worktreePath: agent.worktreePath, branch: agent.branch, baseBranch: agent.baseBranch }).map((s, n) => (
                        <li key={n} className="text-sm">
                          <div className="text-xs text-muted-foreground">{n + 1}. {s.title}</div>
                          <div className="mt-0.5 flex items-start gap-2"><code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs">{s.command}</code>
                            <Button size="sm" variant="outline" aria-label={`Copy step ${n + 1}`} onClick={() => void navigator.clipboard?.writeText(s.command).catch(() => undefined)}><Copy className="h-3.5 w-3.5" /></Button></div>
                        </li>
                      ))}
                    </ol>
                  </Card>
                )}
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
