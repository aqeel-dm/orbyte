import { Check, ShieldCheck, ShieldX, Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import type { PlanApproval, PlanReview, SubmittedPlan, TaskPlan } from '@shared/schemas/plan'
import type { Task } from '@shared/schemas/task'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { usePlan } from '@/hooks/use-plan'

const REC_LABEL = { approve: 'Recommends approving', revise: 'Recommends revising', reject: 'Recommends rejecting' } as const
const REC_VARIANT = { approve: 'success', revise: 'warning', reject: 'destructive' } as const
const when = (t: number) => new Date(t).toLocaleString()

function PlanContent({ content }: { content: SubmittedPlan }) {
  const list = (title: string, items: string[]) =>
    items.length === 0 ? null : (
      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h4>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{items.map((i, n) => <li key={n} className="whitespace-pre-wrap break-words">{i}</li>)}</ul>
      </div>
    )
  return (
    <div className="space-y-3">
      <p className="whitespace-pre-wrap break-words text-sm">{content.summary}</p>
      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Steps</h4>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">{content.steps.map((s, n) => <li key={n} className="whitespace-pre-wrap break-words">{s}</li>)}</ol>
      </div>
      {list('Files', content.files)}
      {list('Tests', content.tests)}
      {list('Risks', content.risks)}
    </div>
  )
}

function ReviewCard({ review }: { review: PlanReview }) {
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 text-sm">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="font-medium">Team Lead's advice</span>
        <Badge variant={REC_VARIANT[review.recommendation]}>{REC_LABEL[review.recommendation]}</Badge>
        <span className="text-xs text-muted-foreground">for version {review.planVersion}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{review.summary}</p>
      {review.concerns.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{review.concerns.map((c, n) => <li key={n} className="whitespace-pre-wrap break-words">{c}</li>)}</ul>}
      <p className="mt-2 text-xs text-muted-foreground">This is advice. Only your decision can authorize execution.</p>
    </Card>
  )
}

export function PlanDialog({ projectId, task, open, onOpenChange }: { projectId: string; task: Task; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { bundle, error, refresh } = usePlan(projectId, task.id)
  const [viewing, setViewing] = useState<number | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const current = bundle?.plans[0]
  const shown: TaskPlan | undefined = bundle?.plans.find((p) => p.version === viewing) ?? current
  const isCurrent = shown && current && shown.id === current.id
  const gate = bundle?.gate
  const reviews = (bundle?.reviews ?? []).filter((r) => r.planId === shown?.id)
  const latestReview = reviews[0]
  const validApproval: PlanApproval | undefined = bundle?.approvals.find((a) => a.status === 'approved' && a.invalidatedAt === null)

  async function run(fn: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setBusy(true); setActionError(null)
    const res = await fn()
    setBusy(false)
    if (!res.ok) return setActionError(res.error?.message ?? 'Something went wrong.')
    setRejecting(false); setReason('')
    void refresh()
  }

  async function approve() {
    if (!current) return
    if (latestReview && latestReview.recommendation !== 'approve' && !window.confirm(`The Team Lead ${REC_LABEL[latestReview.recommendation].toLowerCase()}. Approve this plan anyway?`)) return
    await run(() => window.orbyte.plans.approve(projectId, task.id, current.id))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-auto">
        <DialogTitle className="text-lg font-semibold">Plan for "{task.title}"</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">A plan submitted by the developer agent. Nothing is executed until you approve it.</DialogDescription>

        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        {!bundle && !error && <p className="mt-3 text-sm text-muted-foreground">Loading…</p>}

        {bundle && gate && (
          <div className="mt-4 space-y-4">
            <Card className={`p-3 ${gate.executionAuthorized ? 'border-success/50' : 'border-warning/50'}`}>
              <div className="flex items-center gap-2 text-sm font-medium">
                {gate.executionAuthorized ? <ShieldCheck className="h-4 w-4 text-success" /> : <ShieldX className="h-4 w-4 text-warning" />}
                {gate.executionAuthorized ? `Execution authorized by your approval of plan version ${validApproval?.planVersion}` : 'Execution is blocked'}
              </div>
              {gate.blockers.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">{gate.blockers.map((b, n) => <li key={n}>{b}</li>)}</ul>}
              {gate.executionAuthorized && <p className="mt-1 text-xs text-muted-foreground">Execution itself is not available yet (a later phase). Approval is recorded and checked by the backend.</p>}
            </Card>

            {!shown ? (
              <p className="text-sm text-muted-foreground">No plan has been submitted yet. The agent submits one when it has finished investigating.</p>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">Version</span>
                  <select className="h-8 rounded-md border border-border bg-card px-2 text-sm" value={shown.version} onChange={(e) => setViewing(Number(e.target.value))} aria-label="Plan version">
                    {bundle.plans.map((p) => <option key={p.id} value={p.version}>{p.version}{p.id === current?.id ? ' (current)' : ' (superseded)'}</option>)}
                  </select>
                  <span className="text-xs text-muted-foreground">submitted {when(shown.submittedAt)}</span>
                </div>
                <PlanContent content={shown.content} />

                {latestReview ? <ReviewCard review={latestReview} /> : isCurrent && (
                  <Card className="flex items-center justify-between gap-3 p-3 text-sm">
                    <span className="text-muted-foreground">{bundle.reviewInProgress ? 'The Team Lead is reviewing this plan…' : 'No Team Lead review yet.'}</span>
                    {!bundle.reviewInProgress && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => window.orbyte.plans.requestReview(projectId, task.id, shown.id))}>Request review</Button>}
                  </Card>
                )}

                {isCurrent && gate.state === 'awaiting_decision' && (
                  <div className="space-y-2">
                    {rejecting ? (
                      <>
                        <textarea className="min-h-[4rem] w-full rounded-md border border-border bg-card px-3 py-2 text-sm" placeholder="Why is this plan rejected? The agent can use this to revise." value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
                        <div className="flex gap-2">
                          <Button variant="destructive" disabled={busy || !reason.trim()} onClick={() => run(() => window.orbyte.plans.reject(projectId, task.id, shown.id, reason))}><X className="h-4 w-4" />Reject plan</Button>
                          <Button variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
                        </div>
                      </>
                    ) : (
                      <div className="flex gap-2">
                        <Button disabled={busy || gate.blockers.some((b) => b.startsWith('Dependencies'))} onClick={approve}><Check className="h-4 w-4" />Approve plan</Button>
                        <Button variant="outline" disabled={busy} onClick={() => setRejecting(true)}>Reject…</Button>
                      </div>
                    )}
                  </div>
                )}
                {isCurrent && gate.state === 'approved' && validApproval && (
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground">Approved by you on {when(validApproval.decidedAt)}.</span>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => window.orbyte.plans.revoke(projectId, task.id).then((r) => ({ ok: r.ok, ...(r.ok ? {} : { error: r.error }) })))}>Revoke approval</Button>
                  </div>
                )}
                {!isCurrent && <p className="text-xs text-muted-foreground">An older version. It can no longer be approved.</p>}
              </>
            )}

            {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}

            {bundle.approvals.length > 0 && (
              <div>
                <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Decision history</h4>
                <ul className="mt-1 space-y-1 text-sm">
                  {bundle.approvals.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2">
                      <Badge variant={a.status === 'approved' ? 'success' : 'destructive'}>{a.status}</Badge>
                      <span>version {a.planVersion} by you, {when(a.decidedAt)}</span>
                      {a.invalidatedAt !== null && <span className="text-xs text-muted-foreground">(no longer valid: {a.invalidationReason})</span>}
                      {a.status === 'rejected' && a.reason && <span className="text-xs text-muted-foreground">"{a.reason}"</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
