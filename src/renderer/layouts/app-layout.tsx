import { LayoutDashboard, Moon, Orbit, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { Button } from '@/components/ui/button'

function useTheme() {
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem('theme') ? localStorage.getItem('theme') === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches }
    catch { return true }
  })
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try { localStorage.setItem('theme', dark ? 'dark' : 'light') } catch { /* storage unavailable */ }
  }, [dark])
  return { dark, toggle: () => setDark((d) => !d) }
}

export function AppLayout() {
  const { dark, toggle } = useTheme()
  return (
    <div className="flex h-screen">
      <aside className="drag flex w-56 shrink-0 flex-col border-r border-border bg-card pt-10">
        <div className="no-drag flex items-center gap-2 px-4 pb-4 font-semibold"><Orbit className="h-5 w-5 text-primary" />Orbyte</div>
        <nav className="no-drag flex-1 space-y-1 px-2">
          <NavLink to="/" end className={({ isActive }) => `flex items-center gap-2 rounded-md px-3 py-2 text-sm ${isActive ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-muted'}`}>
            <LayoutDashboard className="h-4 w-4" />Dashboard
          </NavLink>
        </nav>
        <div className="no-drag p-2">
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={toggle}>{dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}{dark ? 'Light' : 'Dark'} theme</Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto"><Outlet /></main>
    </div>
  )
}
