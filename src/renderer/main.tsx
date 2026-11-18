import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import './styles.css'
import { AppLayout } from './layouts/app-layout'
import { DashboardPage } from './pages/dashboard'

const router = createHashRouter([{ path: '/', element: <AppLayout />, children: [{ index: true, element: <DashboardPage /> }] }])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
