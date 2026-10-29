import { StrictMode, lazy, Suspense, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const checkIsMobile = () => typeof window !== 'undefined' && window.location.pathname.startsWith('/mobile')

// Lazy load routes so mobile and desktop bundles remain completely isolated
const MobileDEMViewer = lazy(() => import('./mobile/MobileDEMViewer.jsx'))

const DesktopApp = lazy(async () => {
  const Plotly = await import('plotly.js/dist/plotly.js')
  if (typeof window !== 'undefined') {
    window.Plotly = Plotly.default || Plotly
  }
  return import('./App.jsx')
})

function RootRouter() {
  const [isMobile, setIsMobile] = useState(checkIsMobile)

  useEffect(() => {
    const handlePopState = () => setIsMobile(checkIsMobile())
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  return (
    <Suspense
      fallback={
        <div style={{
          position: 'fixed',
          inset: 0,
          background: '#03080f',
          color: '#00d4ff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'Inter, sans-serif',
          fontSize: '0.85rem',
          letterSpacing: '0.08em',
        }}>
          INITIALIZING...
        </div>
      }
    >
      {isMobile ? <MobileDEMViewer /> : <DesktopApp />}
    </Suspense>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RootRouter />
  </StrictMode>,
)

