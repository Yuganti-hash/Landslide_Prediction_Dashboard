import React, { useEffect, useRef, useState } from 'react'

/**
 * SoilThicknessModel — ANALYTICAL LAYER 3: TERRAIN-DERIVED SOIL THICKNESS ESTIMATE
 * ============================================================================
 * Offloads terrain geomorphometry and depth proxy calculations to Web Worker.
 * Fully unloads WebGL resources and terminates worker on model switch.
 * ============================================================================
 */

// ── Camera presets ─────────────────────────────────────────────────────────────
const CAMERAS = {
  default: { eye: { x: 1.25, y: 1.25, z: 0.80 } },
  top:     { eye: { x: 0.001, y: 0.001, z: 2.50 } },
  '3d':    { eye: { x: 1.25, y: 1.25, z: 0.80 } },
}

const PAPER_BG = '#060e1a'
const PLOT_BG  = '#03080f'
const GRID_CLR = 'rgba(0,212,255,0.1)'
const TICK_CLR = '#2a4055'
const LBL_CLR  = '#4a6880'

// Smooth continuous perceptual gradient:
// LOW SOIL THICKNESS  → dark/deeper brown
// MEDIUM SOIL THICKNESS → brown/earth tones
// HIGH SOIL THICKNESS   → warm yellow / bright yellow
const SOIL_COLORSCALE = [
  [0.00, '#3E1B04'],  // 0.00: Lowest soil thickness — Dark / Deep Brown
  [0.15, '#5C2B0B'],  // 0.15: Thin soil — Deep Earth Brown
  [0.30, '#7C3F10'],  // 0.30: Moderate-low — Earth Brown
  [0.45, '#A45819'],  // 0.45: Moderate — Warm Terracotta Brown
  [0.60, '#C9731E'],  // 0.60: Moderate-high — Golden Ochre / Amber
  [0.75, '#E89620'],  // 0.75: High thickness — Warm Amber-Yellow
  [0.88, '#FFBA08'],  // 0.88: Very high — Warm Golden Yellow
  [1.00, '#FFD700'],  // 1.00: Maximum thickness — Bright Luminous Warm Yellow
]

// Legend ticks: bottom = thin/steep/deep-brown, top = thick/gentle/bright-yellow
const LEGEND_TICKS = [
  { pct: 1.00, label: 'Thick Soil — Gentle (Max)',   color: '#FFD700' },
  { pct: 0.75, label: 'High Thickness — Deposition', color: '#FFBA08' },
  { pct: 0.50, label: 'Moderate — Mid Slope',        color: '#C9731E' },
  { pct: 0.25, label: 'Thin Soil — Steep',           color: '#7C3F10' },
  { pct: 0.00, label: 'Thinnest Soil — Cliffs (Min)', color: '#3E1B04' },
]

export default function SoilThicknessModel({ onSoilThicknessStatsChange }) {
  const graphDivRef        = useRef(null)
  const containerRef       = useRef(null)
  const workerRef          = useRef(null)
  const cameraRef          = useRef(CAMERAS['3d'])
  const plotInitialized    = useRef(false)
  const relayoutHandlerRef = useRef(null)
  const isMouseDownRef     = useRef(false)

  const [activeView, setActiveView] = useState('3d')
  const [status, setStatus]         = useState('loading')
  const [errMsg, setErrMsg]         = useState('')
  const [thicknessStats, setThicknessStats] = useState(null)
  const [cellCount, setCellCount]   = useState(null)

  // 1. Fetch DEM and execute Web Worker
  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')

    fetch('/terrain_web.json', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`terrain_web.json: HTTP ${res.status}`)
        return res.json()
      })
      .then((terrainData) => {
        if (!terrainData.elevation || !Array.isArray(terrainData.elevation)) {
          throw new Error('terrain_web.json missing elevation matrix')
        }
        setCellCount(`${terrainData.width} × ${terrainData.height}`)

        // Spawn Web Worker for off-thread calculation
        const worker = new Worker(
          new URL('../workers/soilThickness.worker.js', import.meta.url),
          { type: 'module' }
        )
        workerRef.current = worker

        worker.onmessage = (e) => {
          const { type, payload, error } = e.data
          if (type === 'SOIL_THICKNESS_ERROR') {
            setErrMsg(error)
            setStatus('error')
            return
          }

          if (type === 'SOIL_THICKNESS_SUCCESS') {
            const { displayElevation, displayColor, displayThickness, displayX, displayY, thicknessStats: tStats } = payload
            setThicknessStats(tStats)
            onSoilThicknessStatsChange?.(tStats)

            // Render Plotly Surface with continuous per-vertex soil thickness
            const gd = graphDivRef.current
            if (gd && window.Plotly) {
              const surfaceTrace = {
                type: 'surface',
                x: displayX,
                y: displayY,
                z: displayElevation,
                surfacecolor: displayColor,
                customdata: displayThickness,
                cmin: 0.0,
                cmax: 1.0,
                colorscale: SOIL_COLORSCALE,
                showscale: false,
                hovertemplate:
                  '<b>Soil Thickness:</b> %{customdata:.2f} m<br>' +
                  '<b>Elevation:</b> %{z:.1f} m ASL<br>' +
                  '<b>Grid:</b> (%{x}, %{y})<br>' +
                  '<extra>Soil Thickness · Geomorphic Estimate</extra>',
                contours: { z: { show: false } },
                lighting: { ambient: 0.75, diffuse: 0.55, roughness: 0.80, specular: 0.06, fresnel: 0.06 },
                lightposition: { x: 150, y: 250, z: 700 },
              }

              const layout = {
                paper_bgcolor: PAPER_BG,
                plot_bgcolor:  PLOT_BG,
                margin:        { l: 0, r: 0, t: 0, b: 0 },
                autosize:      true,
                uirevision:    'soil-thickness-stable-cam',
                scene: {
                  bgcolor: PLOT_BG,
                  uirevision: 'soil-thickness-stable-cam',
                  xaxis: { title: { text: 'X (grid col)', font: { color: LBL_CLR, size: 9 } }, tickfont: { color: TICK_CLR, size: 8 }, gridcolor: GRID_CLR, backgroundcolor: PLOT_BG, showbackground: true },
                  yaxis: { title: { text: 'Y (grid row)', font: { color: LBL_CLR, size: 9 } }, tickfont: { color: TICK_CLR, size: 8 }, gridcolor: GRID_CLR, backgroundcolor: PLOT_BG, showbackground: true },
                  zaxis: {
                    title: { text: 'Elev (m)', font: { color: LBL_CLR, size: 9 } },
                    tickfont: { color: TICK_CLR, size: 8 },
                    gridcolor: GRID_CLR,
                    backgroundcolor: '#020609',
                    showbackground: true,
                    range: [terrainData.minElevation, terrainData.maxElevation],
                  },
                  camera: cameraRef.current,
                  aspectmode: 'manual',
                  aspectratio: { x: 1.45, y: 1.35, z: 0.68 },
                },
              }

              window.Plotly.newPlot(gd, [surfaceTrace], layout, { responsive: true, displayModeBar: false })
                .then(() => {
                  plotInitialized.current = true
                  relayoutHandlerRef.current = (ev) => {
                    if (ev?.['scene.camera']) cameraRef.current = ev['scene.camera']
                  }
                  gd.on('plotly_relayout', (d) => relayoutHandlerRef.current?.(d))
                })
                .catch(() => {})
            }

            setStatus('ready')
          }
        }

        worker.postMessage({
          type: 'CALCULATE_SOIL_THICKNESS',
          terrain: terrainData,
          downsampleFactor: 3,
        })
      })
      .catch((err) => {
        if (err.name === 'AbortError') return
        setErrMsg(err.message)
        setStatus('error')
      })

    return () => {
      // 1. Abort fetch
      controller.abort()
      // 2. Terminate worker
      if (workerRef.current) {
        workerRef.current.terminate()
        workerRef.current = null
      }
      // 3. Purge WebGL & Plotly
      const gd = graphDivRef.current
      if (gd && window.Plotly) {
        try {
          window.Plotly.purge(gd)
        } catch {
          // ignore
        }
      }
      plotInitialized.current = false
    }
  }, [onSoilThicknessStatsChange])

  // ResizeObserver
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      const gd = graphDivRef.current
      if (gd && window.Plotly && plotInitialized.current) window.Plotly.Plots.resize(gd)
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  // Global pointer-up
  useEffect(() => {
    const up = () => { isMouseDownRef.current = false }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])

  const applyCamera = (viewKey) => {
    const cam = CAMERAS[viewKey] ?? CAMERAS.default
    cameraRef.current = cam
    setActiveView(viewKey)
    const gd = graphDivRef.current
    if (gd && window.Plotly) window.Plotly.relayout(gd, { 'scene.camera': cam })
  }

  const infoLabel = cellCount
    ? `${cellCount} cells  |  Soil Thickness (Derived Estimate)  |  Range: ${thicknessStats ? `${thicknessStats.min.toFixed(1)}–${thicknessStats.max.toFixed(1)} m` : '…'}`
    : 'loading…'

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Toolbar */}
      <div className="viz-toolbar" role="toolbar" aria-label="Soil Thickness layer controls">
        <span className="viz-toolbar-label">Camera:</span>
        <button id="st-cam-reset" className={`viz-btn${activeView === 'default' ? ' active' : ''}`} onClick={() => applyCamera('default')} disabled={status !== 'ready'} title="Reset">Reset</button>
        <button id="st-cam-top"   className={`viz-btn${activeView === 'top'     ? ' active' : ''}`} onClick={() => applyCamera('top')}     disabled={status !== 'ready'} title="Top-Down">Top</button>
        <button id="st-cam-3d"    className={`viz-btn${activeView === '3d'      ? ' active' : ''}`} onClick={() => applyCamera('3d')}      disabled={status !== 'ready'} title="3D Perspective">3D</button>

        <span className="viz-toolbar-divider" />
        <span className="viz-toolbar-label" style={{ color: '#FFC107' }}>Incline:</span>
        {[
          { label: 'GENTLE',   bg: '#FFD700' },
          { label: 'MODERATE', bg: '#E67E22' },
          { label: 'STEEP',    bg: '#A0522D' },
        ].map(({ label, bg }) => (
          <span key={label} style={{ fontSize: '0.46rem', fontWeight: 700, background: bg + '28', border: `1px solid ${bg}99`, color: bg, borderRadius: 3, padding: '2px 6px', letterSpacing: '0.03em' }}>
            {label}
          </span>
        ))}

        <span className="viz-toolbar-divider" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(255,193,7,0.08)', border: '1px solid rgba(255,193,7,0.40)', borderRadius: 3, padding: '2px 8px' }}>
          <span style={{ fontSize: '0.50rem', fontWeight: 800, color: '#FFD700', letterSpacing: '0.06em' }}>⚠ TERRAIN-DERIVED VISUALIZATION</span>
          <span style={{ fontSize: '0.44rem', color: '#8a7040', fontFamily: 'JetBrains Mono, monospace' }}>No measured dataset</span>
        </div>

        <span className="viz-toolbar-spacer" />
        <span className="viz-coord">{infoLabel}</span>
      </div>

      {/* Loading */}
      {status === 'loading' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, background: PLOT_BG, color: '#4a6880' }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', border: '2px solid rgba(180,120,0,0.18)', borderTop: '2px solid #c8a46e', animation: 'spin 1s linear infinite' }} />
          <p style={{ fontSize: '0.7rem', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Computing terrain-derived soil thickness…</p>
        </div>
      )}

      {/* Error */}
      {status === 'error' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: PLOT_BG }}>
          <p style={{ fontSize: '0.8rem', color: '#ff3355' }}>⚠ Failed to load terrain: {errMsg}</p>
        </div>
      )}

      {/* Ready */}
      <div
        className="plotly-wrap"
        ref={containerRef}
        style={{ display: status === 'ready' ? 'block' : 'none', position: 'relative', flex: 1 }}
        onPointerDown={() => { isMouseDownRef.current = true }}
        onPointerUp={() => { isMouseDownRef.current = false }}
        onPointerLeave={() => { isMouseDownRef.current = false }}
      >
        <div ref={graphDivRef} id="st-plotly-canvas" style={{ width: '100%', height: '100%' }} />

        {/* Legend */}
        <div
          className="sm-legend-overlay"
          style={{ width: 200, minWidth: 200 }}
          aria-label="Soil thickness colour legend"
        >
          <div className="sm-legend-header" style={{ borderBottom: '1px solid rgba(255,193,7,0.25)' }}>
            <span className="sm-legend-icon">⛰️</span>
            <span style={{ color: '#FFD700', letterSpacing: '0.06em' }}>SOIL THICKNESS</span>
          </div>
          <div style={{ fontSize: '0.42rem', fontWeight: 800, color: '#FFD700', letterSpacing: '0.10em', textAlign: 'center', paddingTop: 5, paddingBottom: 2 }}>▲ THICKER</div>
          <div className="sm-legend-scale-wrap" style={{ height: 180 }}>
            <div style={{
              width: 14, borderRadius: 3, flexShrink: 0,
              background: 'linear-gradient(to top, #3E1B04 0%, #7C3F10 25%, #C9731E 50%, #FFBA08 75%, #FFD700 100%)',
              border: '1px solid rgba(255,193,7,0.45)',
              boxShadow: '0 0 10px rgba(255,215,0,0.25), 0 0 4px rgba(255,193,7,0.15)',
            }} />
            <div className="sm-legend-ticks">
              {LEGEND_TICKS.map(({ pct, label, color }) => (
                <div key={pct} className="sm-legend-tick" style={{ bottom: `${pct * 100}%` }}>
                  <span className="sm-tick-line" />
                  <span className="sm-tick-label" style={{ color, fontWeight: pct === 1.00 || pct === 0.00 ? 700 : 400 }}>
                    {label}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ fontSize: '0.42rem', fontWeight: 800, color: '#C9731E', letterSpacing: '0.10em', textAlign: 'center', paddingTop: 2, paddingBottom: 4 }}>▼ THINNER</div>
          <div className="sm-legend-footer" style={{ borderTop: '1px solid rgba(255,193,7,0.18)' }}>
            <span className="sm-footer-note" style={{ color: '#FFD700' }}>Calculated Depth</span>
            <span className="sm-footer-range" style={{ color: '#FFBA08' }}>
              {thicknessStats ? `${thicknessStats.min.toFixed(2)}–${thicknessStats.max.toFixed(2)} m` : '0.30–3.50 m'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
