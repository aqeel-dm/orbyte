import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import './styles.css'
import { RouteError } from './components/route-error'
import { AppLayout } from './layouts/app-layout'
import { DashboardPage } from './pages/dashboard'
import { ProjectPage } from './pages/project'

const router = createHashRouter([{ path: '/', element: <AppLayout />, errorElement: <RouteError />, children: [{ errorElement: <RouteError />, children: [{ index: true, element: <DashboardPage /> }, { path: 'projects/:id', element: <ProjectPage /> }] }] }])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
