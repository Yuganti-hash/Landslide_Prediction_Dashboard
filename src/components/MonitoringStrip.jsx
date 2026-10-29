import React from 'react'

const MONITORS = [
  { indicator: 'green', label: 'Terrain Status',   value: 'Active',    cls: 'green' },
  { indicator: 'cyan',  label: 'LiDAR Data',       value: 'Loaded',    cls: 'cyan'  },
  { indicator: 'cyan',  label: 'Elevation Model',  value: 'Available', cls: 'cyan'  },
  { indicator: 'green', label: 'Processing',       value: 'Ready',     cls: 'green' },
]

export default function MonitoringStrip() {
  return (
    <div className="monitoring-strip" role="status" aria-label="System monitoring indicators">
      {MONITORS.map(({ indicator, label, value, cls }) => (
        <div key={label} className="monitor-item">
          <span className={`monitor-indicator ${indicator}`} aria-hidden="true" />
          <span className="monitor-label">{label}:</span>
          <span className={`monitor-value ${cls}`}>{value}</span>
        </div>
      ))}
    </div>
  )
}
