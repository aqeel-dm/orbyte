import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'

/**
 * A real terminal attached to one agent's PTY. It receives output only for this agent (main
 * enforces that), and keystrokes are sent only while the agent is running.
 */
export function TerminalView({ projectId, agentId, interactive }: { projectId: string; agentId: string; interactive: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const interactiveRef = useRef(interactive)
  interactiveRef.current = interactive

  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, scrollback: 5000, convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: { background: '#0b0b0e', foreground: '#ececf1' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)

    let disposed = false
    let ready = false
    const early: string[] = [] // output that arrives while history is still being written
    const sendSize = () => {
      if (disposed) return
      fit.fit()
      void window.orbyte.agents.resize(projectId, agentId, Math.max(20, term.cols), Math.max(5, term.rows))
    }

    const offData = window.orbyte.onTerminalData((e) => {
      if (e.agentId !== agentId) return
      if (ready) term.write(e.data)
      else early.push(e.data)
    })
    // While history is replayed xterm answers the program's OLD terminal queries (cursor position,
    // device attributes, ...). Those replies must not be typed into the live session, so input is
    // ignored until the replay has finished.
    let replayDone = false
    const input = term.onData((d) => {
      if (replayDone && interactiveRef.current) void window.orbyte.agents.write(projectId, agentId, d)
    })

    void window.orbyte.agents.attach(projectId, agentId).then((res) => {
      if (disposed) return
      if (res.ok) {
        // The callback runs once xterm has parsed the whole history (and produced any replies).
        term.write(res.data.history, () => {
          if (disposed) return
          replayDone = true
          // Output that arrived while replaying is live, so answering its queries is correct.
          for (const chunk of early) term.write(chunk)
          early.length = 0
          ready = true
          sendSize()
        })
      } else {
        term.write(`\r\n${res.error.message}\r\n`)
        replayDone = true
        ready = true
        sendSize()
      }
    })

    const observer = new ResizeObserver(() => sendSize())
    observer.observe(el)

    return () => {
      disposed = true
      observer.disconnect(); input.dispose(); offData()
      void window.orbyte.agents.detach(projectId, agentId)
      term.dispose()
    }
  }, [projectId, agentId])

  return <div ref={host} className="h-full w-full overflow-hidden rounded-md border border-border bg-[#0b0b0e] p-2" aria-label="Agent terminal" />
}
