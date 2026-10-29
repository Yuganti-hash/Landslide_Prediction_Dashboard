import React, { useState, useEffect } from 'react'

export default function Header() {
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const dateStr = time.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
  const timeStr = time.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })

  return (
    <header className="header" role="banner">
      {/* Brand */}
      <div className="header-left">
        <div className="header-icon" aria-hidden="true">🏔️</div>
        <div className="header-titles">
          <h1 className="header-title">Landslide Intelligence Platform</h1>
          <p className="header-sub">LiDAR Terrain Monitoring System</p>
        </div>
      </div>

      {/* Right */}
      <div className="header-right">
        <div className="header-status" role="status" aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          System Online
        </div>

        <div className="header-location">
          <span>📍 Study Area</span>
          <span style={{ color: 'var(--text-bright)', fontVariantNumeric: 'tabular-nums' }}>
            {dateStr} &nbsp; {timeStr}
          </span>
        </div>
      </div>
    </header>
  )
}
