import React, { useState } from 'react'
import { RISK_CONFIGS } from '../services/cesiumBeaconManager'

export default function BeaconInspectorPanel({ beacon, onClose, onFlyTo, onTriggerEvacuation }) {
  const [evacuationActive, setEvacuationActive] = useState(false)
  const [alertSent, setAlertSent] = useState(false)

  if (!beacon) return null

  const data = beacon.rawOptions || beacon
  const riskLevel = data.risk_level || 'HIGH'
  const config = RISK_CONFIGS[riskLevel] || RISK_CONFIGS['HIGH']
  const probPercent = Math.round((data.risk_probability || 0.85) * 100)

  const handleEvacuationToggle = () => {
    setEvacuationActive(!evacuationActive)
    if (onTriggerEvacuation) onTriggerEvacuation(beacon, !evacuationActive)
  }

  const handleDispatchAlert = () => {
    setAlertSent(true)
    setTimeout(() => setAlertSent(false), 4000)
  }

  return (
    <aside className="beacon-inspector-panel" aria-label="Landslide Risk Inspector">
      {/* Header */}
      <div className="inspector-header">
        <div className="inspector-title-wrap">
          <span className="inspector-risk-indicator" style={{ background: config.colorHex, boxShadow: `0 0 10px ${config.colorHex}` }} />
          <div>
            <h2 className="inspector-title">{data.name || 'Landslide Risk Zone'}</h2>
            <p className="inspector-coords">
              LAT: {data.latitude?.toFixed(4)}° N &nbsp;|&nbsp; LON: {data.longitude?.toFixed(4)}° E
            </p>
          </div>
        </div>
        <button className="inspector-close-btn" onClick={onClose} title="Close Inspector">✕</button>
      </div>

      <div className="inspector-body">
        {/* Risk Probability Gauge Block */}
        <div className="inspector-risk-card" style={{ borderColor: config.badgeBorder, background: config.badgeBg }}>
          <div className="risk-card-top">
            <div className="risk-badge-large" style={{ color: config.badgeText, borderColor: config.badgeBorder }}>
              {riskLevel} RISK
            </div>
            <div className="risk-status-pill">{config.status}</div>
          </div>

          <div className="prob-meter-row">
            <div className="prob-value-wrap">
              <span className="prob-label">ML Risk Probability</span>
              <span className="prob-number" style={{ color: config.colorHex }}>{probPercent}%</span>
            </div>
            <div className="prob-bar-track">
              <div
                className="prob-bar-fill"
                style={{
                  width: `${probPercent}%`,
                  background: `linear-gradient(90deg, #FFAA00 0%, ${config.colorHex} 100%)`,
                  boxShadow: `0 0 8px ${config.colorHex}`,
                }}
              />
            </div>
          </div>
        </div>

        {/* Contributing Environmental Factors */}
        <div className="inspector-section">
          <h3 className="section-heading">Contributing Geo-Environmental Factors</h3>
          <div className="factor-grid">
            <div className="factor-card">
              <span className="factor-icon">🌧️</span>
              <div>
                <span className="factor-name">Precipitation (24h)</span>
                <span className="factor-val high">{data.rainfall || '148.5 mm'}</span>
              </div>
            </div>

            <div className="factor-card">
              <span className="factor-icon">💧</span>
              <div>
                <span className="factor-name">Soil Moisture</span>
                <span className="factor-val high">{data.soil_moisture || '0.462 m³/m³'}</span>
              </div>
            </div>

            <div className="factor-card">
              <span className="factor-icon">📐</span>
              <div>
                <span className="factor-name">Terrain Slope</span>
                <span className="factor-val critical">{data.slope || '38.5°'}</span>
              </div>
            </div>

            <div className="factor-card">
              <span className="factor-icon">🌿</span>
              <div>
                <span className="factor-name">Vegetation NDVI</span>
                <span className="factor-val">{data.ndvi || '0.22'}</span>
              </div>
            </div>
          </div>

          {data.geology && (
            <div className="geology-row">
              <span className="geology-label">Lithology / Strata:</span>
              <span className="geology-val">{data.geology}</span>
            </div>
          )}

          <div className="timestamp-row">
            <span>Detection Timestamp:</span>
            <span>{data.timestamp || new Date().toISOString()}</span>
          </div>
        </div>

        {/* Affected Infrastructure & Settlements */}
        <div className="inspector-section">
          <h3 className="section-heading">Affected Infrastructure &amp; Settlements</h3>
          <ul className="affected-list">
            {(data.affected_infrastructure || [
              'Primary Transit Corridor (High Vulnerability)',
              'Downslope Habitation Buffer Zone',
              'Power Grid Line Section',
            ]).map((item, idx) => (
              <li key={idx} className="affected-item">
                <span className="affected-bullet">⚠</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Recommended Mitigation Protocol */}
        {data.recommended_action && (
          <div className="inspector-section action-protocol">
            <h3 className="section-heading">Recommended SOP Protocol</h3>
            <p className="protocol-text">{data.recommended_action}</p>
          </div>
        )}

        {/* Interactive Operations Buttons */}
        <div className="inspector-actions">
          <button
            className="action-btn primary"
            onClick={() => onFlyTo && onFlyTo(beacon.id)}
          >
            🎯 Fly To Epicenter
          </button>

          <button
            className={`action-btn ${evacuationActive ? 'active-warning' : 'secondary'}`}
            onClick={handleEvacuationToggle}
          >
            {evacuationActive ? '🛡️ Buffer Active (1.5 km)' : '📏 Simulate Hazard Buffer'}
          </button>

          <button
            className={`action-btn ${alertSent ? 'alert-dispatched' : 'danger'}`}
            onClick={handleDispatchAlert}
            disabled={alertSent}
          >
            {alertSent ? '✓ Alert Broadcast Sent!' : '🚨 Broadcast Early Warning'}
          </button>
        </div>
      </div>
    </aside>
  )
}
