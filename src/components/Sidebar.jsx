import React from 'react'

const NAV_ITEMS = [
  { icon: '⬡',  label: 'Overview',   active: false },
  { icon: '◈',  label: 'LiDAR',      active: true  },
  { icon: '▲',  label: 'Elevation',  active: false },
  { icon: '▦',  label: 'Terrain',    active: false },
  { icon: '⚠',  label: 'Risk',       active: false },
  { icon: '🔔', label: 'Alerts',     active: false },
]

export default function Sidebar() {
  return (
    <nav className="sidebar" role="navigation" aria-label="Primary navigation">
      {NAV_ITEMS.map(({ icon, label, active }, idx) => (
        <React.Fragment key={label}>
          {/* divider before Alerts */}
          {idx === 5 && <div className="nav-divider" aria-hidden="true" />}
          <div
            className={`nav-item${active ? ' active' : ''}`}
            role="menuitem"
            tabIndex={0}
            aria-current={active ? 'page' : undefined}
            aria-label={label}
            title={label}
          >
            <span className="nav-icon" aria-hidden="true">{icon}</span>
            <span className="nav-label">{label}</span>
          </div>
        </React.Fragment>
      ))}
    </nav>
  )
}
