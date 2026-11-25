import { TriangleAlert } from 'lucide-react'
import { useRouteError } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

/**
 * Shown instead of a blank window when a screen throws while rendering. It only catches render errors;
 * a failed `window.orbyte` call is already shown by the screen that made it. Nothing is sent anywhere.
 */
export function RouteError() {
  const error = useRouteError()
  const detail = error instanceof Error ? error.message : 'Unknown error'
  return (
    <div className="p-8">
      <Card className="mx-auto max-w-xl space-y-3 p-6" role="alert">
        <div className="flex items-center gap-2 font-semibold"><TriangleAlert className="h-5 w-5 text-warning" />This screen hit an error</div>
        <p className="text-sm text-muted-foreground">Something in the screen failed to display. Your data is not affected: tasks, approvals and agents are stored by the app, not by this screen. Reloading usually fixes it; if it keeps happening, the details below help to report it.</p>
        <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Details</summary><pre className="mt-1 whitespace-pre-wrap break-words">{detail}</pre></details>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => window.location.reload()}>Reload</Button>
          <Button size="sm" variant="outline" onClick={() => { window.location.hash = '#/'; window.location.reload() }}>Go to dashboard</Button>
        </div>
      </Card>
    </div>
  )
}
