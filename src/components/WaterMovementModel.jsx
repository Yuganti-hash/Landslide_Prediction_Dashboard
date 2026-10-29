import React, { useEffect, useRef, useState } from 'react'

// ── Camera presets ───────────────────────────────────────────────────────────
const CAMERAS = {
  default: { eye: { x: 1.25, y: 1.25, z: 0.80 } },
  top:     { eye: { x: 0.01, y: 0.01, z: 2.1 } },
  '3d':    { eye: { x: 1.25, y: 1.25, z: 0.80 } },
}

const PAPER_BG = '#060e1a'
const PLOT_BG  = '#03080f'
const GRID_CLR = 'rgba(0,212,255,0.1)'
const TICK_CLR = '#2a4055'
const LBL_CLR  = '#4a6880'

// ── High-Contrast D8 Drainage Accumulation Colorscale ─────────────────────────
// Deep navy / bedrock for low accumulation -> cyan -> cobalt -> electric blue -> blazing azure for main drainage channels
const D8_FLOW_COLORSCALE = [
  [0.00, '#040d1a'], // Ridges / zero runoff
  [0.15, '#072440'], // Gentle hillside overland sheetflow
  [0.35, '#0e4a7a'], // Headwater rills
  [0.55, '#1682c5'], // Intermediate tributary gullies
  [0.75, '#00b4d8'], // Torrential convergence channels
  [0.90, '#48cae4'], // Major valley collector stream
  [1.00, '#caf0f8'], // Peak river confluence / catchment outflow
]

/**
 * MODEL 2 — WATER MOVEMENT (D8 DOWNSLOPE FLOW ROUTING)
 * ============================================================================
 * Calculates steepest-descent D8 downslope flow routing, Directed Acyclic Graph (DAG)
 * topological sorting, and upstream catchment accumulation across 513,608 LiDAR cells.
 * Offloaded to dedicated Web Worker (d8Flow.worker.js).
 * ============================================================================
 */
export default function WaterMovementModel({ onHydrologyStatsChange }) {
  const graphDivRef = useRef(null)
  const containerRef = useRef(null)
  const workerRef = useRef(null)
  const cameraRef = useRef(CAMERAS['3d'])
  const plotInitialized = useRef(false)
  const isMouseDownRef = useRef(false)

  const [activeView, setActiveView] = useState('3d')
  const [status, setStatus] = useState('loading')
  const [errMsg, setErrMsg] = useState('')
  const [stats, setStats] = useState(null)
  const [hoveredCell, setHoveredCell] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')

    // 1. Fetch terrain
    fetch('/terrain_web.json', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`terrain_web.json: HTTP ${res.status}`)
        return res.json()
      })
      .then((terrainData) => {
        // 2. Offload D8 calculations to Web Worker
        const worker = new Worker(
          new URL('../workers/d8Flow.worker.js', import.meta.url),
          { type: 'module' }
        )
        workerRef.current = worker

        worker.onmessage = (e) => {
          const { type, payload, error } = e.data
          if (type === 'D8_ERROR') {
            setErrMsg(error)
            setStatus('error')
            return
          }

          if (type === 'D8_SUCCESS') {
            const { displayAccum2D, maxLogAccum, stats: d8Stats, displayMaps } = payload
            setStats(d8Stats)
            onHydrologyStatsChange?.({
              ...d8Stats,
              model: 'water_movement',
            })

            // Downsample elevation for geometry
            const dH = displayMaps.rowMap.length
            const dW = displayMaps.colMap.length
            const dispElev = new Array(dH)
            for (let ri = 0; ri < dH; ri++) {
              const r = displayMaps.rowMap[ri]
              const row = new Float32Array(dW)
              for (let ci = 0; ci < dW; ci++) {
                const c = displayMaps.colMap[ci]
                row[ci] = terrainData.elevation[r][c]
              }
              dispElev[ri] = Array.from(row)
            }

            // 3. Render 3D Plotly Surface
            const gd = graphDivRef.current
            if (gd && window.Plotly) {
              const trace = {
                type: 'surface',
                x: Array.from(displayMaps.colMap),
                y: Array.from(displayMaps.rowMap),
                z: dispElev,
                surfacecolor: displayAccum2D,
                cmin: 0,
                cmax: maxLogAccum,
                colorscale: D8_FLOW_COLORSCALE,
                showscale: false,
                hovertemplate:
                  '<b>Elevation:</b> %{z:.1f} m ASL<br>' +
                  '<b>Grid:</b> (%{x}, %{y})<br>' +
                  '<b>D8 Accumulation (log):</b> %{surfacecolor:.2f}<br>' +
                  '<extra>Model 2 · D8 Flow Routing</extra>',
                contours: { z: { show: false } },
                lighting: {
                  ambient: 0.75,
                  diffuse: 0.65,
                  roughness: 0.70,
                  specular: 0.10,
                  fresnel: 0.08,
                },
                lightposition: { x: 150, y: 250, z: 700 },
              }

              const layout = {
                paper_bgcolor: PAPER_BG,
                plot_bgcolor:  PLOT_BG,
                margin:        { l: 0, r: 0, t: 0, b: 0 },
                autosize:      true,
                uirevision:    'water-movement-stable-cam',
                scene: {
                  bgcolor: PLOT_BG,
                  uirevision: 'water-movement-stable-cam',
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

              window.Plotly.newPlot(gd, [trace], layout, { responsive: true, displayModeBar: false })
                .then(() => {
                  plotInitialized.current = true
                  gd.on('plotly_relayout', (ev) => {
                    if (ev?.['scene.camera']) cameraRef.current = ev['scene.camera']
                  })
                  gd.on('plotly_hover', (d) => {
                    if (isMouseDownRef.current) return
                    const pt = d.points?.[0]
                    if (pt) {
                      setHoveredCell({
                        x: Math.round(pt.x),
                        y: Math.round(pt.y),
                        z: pt.z,
                        logAccum: pt.surfacecolor,
                      })
                    }
                  })
                  gd.on('plotly_unhover', () => setHoveredCell(null))
                })
                .catch(() => {})
            }

            setStatus('ready')
          }
        }

        worker.postMessage({
          type: 'CALCULATE_D8',
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
      // 1. Abort network request
      controller.abort()
      // 2. Terminate Web Worker immediately
      if (workerRef.current) {
        workerRef.current.terminate()
        workerRef.current = null
      }
      // 3. Purge Plotly & WebGL context
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
  }, [onHydrologyStatsChange])

  // Resize handling
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      const gd = graphDivRef.current
      if (gd && window.Plotly && plotInitialized.current) {
        window.Plotly.Plots.resize(gd)
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  const applyCamera = (viewKey) => {
    const cam = CAMERAS[viewKey] ?? CAMERAS.default
    cameraRef.current = cam
    setActiveView(viewKey)
    const gd = graphDivRef.current
    if (gd && window.Plotly) {
      window.Plotly.relayout(gd, { 'scene.camera': cam })
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Toolbar */}
      <div className="viz-toolbar" role="toolbar" aria-label="Water movement camera controls">
        <span className="viz-toolbar-label">Camera:</span>
        <button
          id="water-cam-reset"
          className={`viz-btn${activeView === 'default' ? ' active' : ''}`}
          onClick={() => applyCamera('default')}
          disabled={status !== 'ready'}
        >
          Reset
        </button>
        <button
          id="water-cam-top"
          className={`viz-btn${activeView === 'top' ? ' active' : ''}`}
          onClick={() => applyCamera('top')}
          disabled={status !== 'ready'}
        >
          Top
        </button>
        <button
          id="water-cam-3d"
          className={`viz-btn${activeView === '3d' ? ' active' : ''}`}
          onClick={() => applyCamera('3d')}
          disabled={status !== 'ready'}
        >
          3D
        </button>

        <span className="viz-toolbar-divider" />
        <span style={{ fontSize: '0.6rem', color: '#00d4ff', fontWeight: 700, letterSpacing: '0.08em' }}>
          MODEL 2: WATER MOVEMENT (D8 FLOW ROUTING)
        </span>

        <span className="viz-toolbar-divider" />
        <span style={{ fontSize: '0.52rem', color: '#7dd3fc', background: 'rgba(0,212,255,0.08)', padding: '2px 6px', borderRadius: 3, border: '1px solid rgba(0,212,255,0.2)' }}>
          Steepest Descent DAG
        </span>

        <span className="viz-toolbar-spacer" />
        <span className="viz-coord">
          {stats ? `${stats.majorStreams ?? 0} Major Channels · ${stats.streamlineCount ?? 0} Streamlines` : 'Computing D8 vectors…'}
        </span>
      </div>

      {status === 'loading' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, background: PLOT_BG, color: '#4a6880' }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', border: '2px solid rgba(0,212,255,0.15)', borderTop: '2px solid #00d4ff', animation: 'spin 1s linear infinite' }} />
          <p style={{ fontSize: '0.7rem', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Routing D8 Flow Vectors & Accumulation…
          </p>
        </div>
      )}

      {status === 'error' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: PLOT_BG }}>
          <p style={{ fontSize: '0.8rem', color: '#ff3355' }}>⚠ Failed to route water flow: {errMsg}</p>
        </div>
      )}

      <div
        className="plotly-wrap"
        ref={containerRef}
        style={{ display: status === 'ready' ? 'block' : 'none', position: 'relative', flex: 1 }}
        onPointerDown={() => { isMouseDownRef.current = true }}
        onPointerUp={() => { isMouseDownRef.current = false }}
      >
        <div ref={graphDivRef} style={{ width: '100%', height: '100%' }} />

        {/* Legend Overlay */}
        <div className="sm-legend-overlay" style={{ width: 210 }}>
          <div className="sm-legend-header">
            <span className="sm-legend-icon">🌊</span>
            <span style={{ color: '#00d4ff', letterSpacing: '0.06em' }}>D8 FLOW CHANNELS</span>
          </div>
          <div style={{ fontSize: '0.42rem', color: '#caf0f8', textAlign: 'center', paddingTop: 4, fontWeight: 700 }}>
            ▲ HIGH ACCUMULATION (VALLEYS)
          </div>
          <div className="sm-legend-scale-wrap" style={{ height: 160 }}>
            <div style={{
              width: 14,
              borderRadius: 3,
              background: 'linear-gradient(to top, #040d1a 0%, #072440 20%, #0e4a7a 40%, #1682c5 60%, #00b4d8 80%, #caf0f8 100%)',
              border: '1px solid rgba(0,212,255,0.3)',
            }} />
            <div className="sm-legend-ticks">
              <div className="sm-legend-tick" style={{ bottom: '90%' }}>
                <span className="sm-tick-line" />
                <span className="sm-tick-label" style={{ color: '#caf0f8' }}>Major Channel</span>
              </div>
              <div className="sm-legend-tick" style={{ bottom: '60%' }}>
                <span className="sm-tick-line" />
                <span className="sm-tick-label" style={{ color: '#00b4d8' }}>Gully Confluence</span>
              </div>
              <div className="sm-legend-tick" style={{ bottom: '30%' }}>
                <span className="sm-tick-line" />
                <span className="sm-tick-label" style={{ color: '#0e4a7a' }}>Headwater Rill</span>
              </div>
              <div className="sm-legend-tick" style={{ bottom: '5%' }}>
                <span className="sm-tick-line" />
                <span className="sm-tick-label" style={{ color: '#4a6880' }}>Ridge / Overland</span>
              </div>
            </div>
          </div>
          <div style={{ fontSize: '0.42rem', color: '#4a6880', textAlign: 'center', paddingBottom: 4 }}>
            ▼ LOW ACCUMULATION (RIDGES)
          </div>
          <div className="sm-legend-footer">
            <span className="sm-footer-note" style={{ color: '#00d4ff' }}>D8 Steepest Descent</span>
            <span className="sm-footer-range" style={{ color: '#7a9bb8' }}>LiDAR 1.0m DEM</span>
          </div>
        </div>

        {/* Hover Inspector HUD */}
        {hoveredCell && (
          <div style={{
            position: 'absolute',
            bottom: 16,
            left: 16,
            zIndex: 15,
            background: 'rgba(6,14,26,0.92)',
            border: '1px solid rgba(0,212,255,0.3)',
            borderRadius: 6,
            padding: '8px 12px',
            fontSize: '0.55rem',
            color: '#c8d8e8',
            backdropFilter: 'blur(6px)',
            pointerEvents: 'none',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div>Cell: <strong>({hoveredCell.x}, {hoveredCell.y})</strong></div>
              <div>Elevation: <strong>{hoveredCell.z != null ? hoveredCell.z.toFixed(1) : '—'} m</strong></div>
              <div>D8 Accumulation (log10): <strong>{hoveredCell.logAccum != null ? hoveredCell.logAccum.toFixed(2) : '—'}</strong></div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
