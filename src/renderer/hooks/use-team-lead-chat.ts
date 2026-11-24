import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@shared/schemas/team-lead'

export interface ChatError { code: string; message: string }

export const AUTH_HELP = "Claude isn't signed in. Open a terminal, run `claude`, log in, then try again."

/** All chat state and event handling lives here; components only render it. */
export function useTeamLeadChat(projectId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [working, setWorking] = useState<null | 'chat' | 'onboarding' | 'review'>(null)
  const [tools, setTools] = useState<string[]>([])
  const [error, setError] = useState<ChatError | null>(null)
  const [loading, setLoading] = useState(true)
  const turnRef = useRef<string | null>(null)
  const workingRef = useRef<'chat' | 'onboarding' | 'review' | null>(null)

  const loadHistory = useCallback(async () => {
    const res = await window.orbyte.teamLead.history(projectId)
    if (res.ok) setMessages(res.data)
    else setError(res.error)
    setLoading(false)
  }, [projectId])

  useEffect(() => { void loadHistory() }, [loadHistory])

  useEffect(() => window.orbyte.onEvent((e) => {
    if (e.type === 'project_updated' || e.projectId !== projectId) return
    switch (e.type) {
      case 'turn_started':
        turnRef.current = e.turnId; workingRef.current = e.purpose; setWorking(e.purpose); setDraft(''); setTools([]); setError(null); break
      case 'text_delta':
        // Only chat replies are shown as they stream; onboarding and review turns are background work.
        if (e.turnId === turnRef.current && workingRef.current === 'chat') setDraft((d) => d + e.text); break
      case 'tool_activity':
        if (e.turnId === turnRef.current) setTools((t) => (t.includes(e.tool) ? t : [...t, e.tool])); break
      case 'turn_completed':
        if (turnRef.current && e.turnId !== turnRef.current) break // a different turn's event: ignore
        setWorking(null); setDraft(''); void loadHistory(); break
      case 'turn_error':
        if (turnRef.current && e.turnId !== turnRef.current) break
        setWorking(null); setDraft(''); setError({ code: e.code, message: e.message }); void loadHistory(); break
    }
  }), [projectId, loadHistory])

  const send = useCallback(async (text: string): Promise<boolean> => {
    setError(null)
    const res = await window.orbyte.teamLead.send(projectId, text)
    if (!res.ok) { setError(res.error); return false }
    setMessages((m) => (m.some((x) => x.id === res.data.userMessage.id) ? m : [...m, res.data.userMessage]))
    return true
  }, [projectId])

  const interrupt = useCallback(() => void window.orbyte.teamLead.interrupt(projectId), [projectId])
  return { messages, draft, working, tools, error, loading, send, interrupt }
}
