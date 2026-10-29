import React from 'react'

/*
  Elevation profile — synthetic cross-section shape derived from normalised
  RAW samples, with Y-axis labels driven by the REAL min/max elevation values
  from terrain_web.json (passed via terrainStats prop from App.jsx).
  The shape itself remains a smooth illustration; only the axis labels are real.
*/

// 40 synthetic elevation sample points (normalized 0–1)
const RAW = [
  0.42, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.72, 0.68, 0.62,
  0.58, 0.64, 0.75, 0.82, 0.88, 0.92, 0.95, 0.90, 0.83, 0.76,
  0.70, 0.65, 0.72, 0.80, 0.85, 0.78, 0.70, 0.62, 0.55, 0.50,
  0.46, 0.50, 0.58, 0.63, 0.58, 0.52, 0.48, 0.44, 0.42, 0.40,
]

// Map normalised values to SVG coords (W=100%, H=80px viewbox)
const W = 400
const H = 80
const PAD = { left: 30, right: 8, top: 6, bottom: 18 }
const plotW = W - PAD.left - PAD.right
const plotH = H - PAD.top - PAD.bottom

const pts = RAW.map((v, i) => ({
  x: PAD.left + (i / (RAW.length - 1)) * plotW,
  y: PAD.top  + (1 - v) * plotH,
}))

const lineD   = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
const areaD   = `${lineD} L${pts[pts.length-1].x.toFixed(1)},${(PAD.top + plotH).toFixed(1)} L${PAD.left},${(PAD.top + plotH).toFixed(1)} Z`

// Y-axis tick positions (normalised 0–1). Labels are injected at render time
// from the real terrain min/max values so they are never hardcoded.
const Y_TICK_POSITIONS = [0.0, 0.5, 1.0]

export default function ElevationProfile({ terrainStats }) {
  // Build Y-axis tick labels from real terrain range, falling back to '—' while loading
  const minE = terrainStats?.minElevation  ?? null
  const maxE = terrainStats?.maxElevation  ?? null
  const midE = (minE != null && maxE != null) ? Math.round((minE + maxE) / 2) : null

  const yTickLabels = [
    minE != null ? `${Math.round(minE)}m` : '—',
    midE != null ? `${midE}m`             : '—',
    maxE != null ? `${Math.round(maxE)}m` : '—',
  ]

  const badgeCls  = terrainStats ? 'green' : 'amber'
  const badgeText = terrainStats ? 'Live'  : 'Loading'

  return (
    <div className="bottom-panel">
      <div className="panel-header">
        <span className="panel-title">Elevation Profile</span>
        <span className={`panel-badge ${badgeCls}`}>{badgeText}</span>
      </div>

      <div className="panel-body" style={{ padding: '8px 10px 4px' }}>
        <div className="elev-svg-wrap" aria-label="Dummy elevation profile chart" role="img">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="elev-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor="#00d4ff" stopOpacity="0.25" />
                <stop offset="100%" stopColor="#00d4ff" stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {/* Grid lines */}
            {Y_TICK_POSITIONS.map((val) => {
              const y = PAD.top + (1 - val) * plotH
              return (
                <line
                  key={val}
                  x1={PAD.left} y1={y} x2={W - PAD.right} y2={y}
                  stroke="rgba(0,212,255,0.08)" strokeWidth="1"
                />
              )
            })}

            {/* Filled area */}
            <path d={areaD} fill="url(#elev-fill)" />

            {/* Profile line */}
            <path
              d={lineD}
              fill="none"
              stroke="#00d4ff"
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* Y-axis labels — real values from terrain_web.json */}
            {Y_TICK_POSITIONS.map((val, idx) => {
              const y     = PAD.top + (1 - val) * plotH
              const label = yTickLabels[idx]
              return (
                <text
                  key={val}
                  className="elev-axis-label"
                  x={PAD.left - 3}
                  y={y + 3}
                  textAnchor="end"
                  fontSize="8"
                  fill="#2a4055"
                >
                  {label}
                </text>
              )
            })}

            {/* X-axis labels */}
            {['0', '12', '25', '37', '40'].map((label, i, arr) => {
              const x = PAD.left + (i / (arr.length - 1)) * plotW
              return (
                <text
                  key={label}
                  className="elev-axis-label"
                  x={x}
                  y={H - 4}
                  textAnchor="middle"
                  fontSize="7"
                  fill="#2a4055"
                >
                  {label}
                </text>
              )
            })}
          </svg>
        </div>
        <p style={{ fontSize: '0.52rem', color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2 }}>
          Illustrative cross-section · real Y-axis range · sample index →
        </p>
      </div>
    </div>
  )
}
