import { Loader2, Send, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { AUTH_HELP, useTeamLeadChat } from '@/hooks/use-team-lead-chat'
import { cn } from '@/lib/utils'

export function ChatTab({ projectId, disabled, disabledReason }: { projectId: string; disabled: boolean; disabledReason: string }) {
  const chat = useTeamLeadChat(projectId)
  const [text, setText] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [chat.messages, chat.draft])

  async function submit() {
    const value = text.trim()
    if (!value || chat.working || disabled) return
    if (await chat.send(value)) setText('')
  }

  const busy = chat.working !== null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-1 py-4">
        {chat.loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : chat.messages.length === 0 && !busy ? (
          <p className="text-sm text-muted-foreground">No messages yet. Describe what you want to build, or ask about the project. The Team Lead is read-only and only acts on what you ask.</p>
        ) : null}
        {chat.messages.map((m) => (
          <div key={m.id} className={cn('max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm', m.role === 'user' ? 'ml-auto bg-primary text-primary-foreground' : 'border border-border bg-card')}>
            {m.content}
          </div>
        ))}
        {busy && (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg border border-border bg-card px-3 py-2 text-sm">
            {chat.draft || <span className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{chat.working === 'onboarding' ? 'Onboarding the project…' : 'Team Lead is working…'}</span>}
            {chat.tools.length > 0 && <div className="mt-2 text-xs text-muted-foreground">Read-only tools used: {chat.tools.join(', ')}</div>}
          </div>
        )}
        {chat.error && (
          <p role="alert" className="text-sm text-destructive">
            {chat.error.code === 'AUTH_REQUIRED' ? AUTH_HELP : chat.error.message}
          </p>
        )}
        <div ref={endRef} />
      </div>
      <div className="flex items-end gap-2 border-t border-border pt-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit() } }}
          rows={2}
          maxLength={20000}
          disabled={disabled}
          placeholder={disabled ? disabledReason : 'Message the Team Lead (Enter to send, Shift+Enter for a new line)'}
          className="min-h-[3rem] flex-1 resize-none rounded-md border border-border bg-card px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
        />
        {busy ? (
          <Button variant="outline" onClick={chat.interrupt} aria-label="Interrupt"><Square className="h-4 w-4" />Stop</Button>
        ) : (
          <Button onClick={submit} disabled={!text.trim() || disabled} aria-label="Send"><Send className="h-4 w-4" />Send</Button>
        )}
      </div>
    </div>
  )
}
