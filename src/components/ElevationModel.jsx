import React, { useEffect, useRef, useState } from 'react'
import Plot from 'react-plotly.js'
import {
  ELEVATION_COLORSCALE,
  getElevationTicks,
} from '../services/terrainVizModes'

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

/**
 * MODEL 1 — LiDAR ELEVATION MODEL
 * Purpose: Show ONLY the real LiDAR terrain elevation.
 * Data: public/terrain_web.json (Z = terrain.elevation)
 * Color: Continuous elevation gradient.
 * Pure terrain: Fully unloaded when not active; purges WebGL on unmount.
 */
export default function ElevationModel() {
  const plotRef = useRef(null)
  const [activeView, setActiveView] = useState('3d')
  const [status, setStatus] = useState('loading')
  const [errMsg, setErrMsg] = useState('')
  const [terrain, setTerrain] = useState(null)

  // Fetch real LiDAR DEM data with AbortController
  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')

    fetch('/terrain_web.json', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`terrain_web.json: HTTP ${res.status} — ${res.statusText}`)
        return res.json()
      })
      .then((data) => {
        if (!data.elevation || !Array.isArray(data.elevation)) {
          throw new Error('terrain_web.json is missing the "elevation" matrix field.')
        }
        setTerrain(data)
        setStatus('ready')
      })
      .catch((err) => {
        if (err.name === 'AbortError') return
        setErrMsg(err.message)
        setStatus('error')
      })

    return () => {
      // 1. Abort inflight network request
      controller.abort()
      // 2. Explicitly purge Plotly & WebGL context to free GPU memory
      if (plotRef.current?.el && window.Plotly) {
        try {
          window.Plotly.purge(plotRef.current.el)
        } catch {
          // ignore cleanup error
        }
      }
      setTerrain(null)
    }
  }, [])

  const applyCamera = (viewKey) => {
    setActiveView(viewKey)
    if (!plotRef.current) return
    const el = plotRef.current.el
    if (el) {
      window.Plotly?.relayout(el, { 'scene.camera': CAMERAS[viewKey] ?? CAMERAS.default })
    }
  }

  const elevTicks = terrain
    ? getElevationTicks(terrain.minElevation, terrain.maxElevation)
    : []

  const plotData = terrain ? [
    {
      type: 'surface',
      z: terrain.elevation,
      surfacecolor: terrain.elevation,
      cmin: terrain.minElevation,
      cmax: terrain.maxElevation,
      colorscale: ELEVATION_COLORSCALE,
      showscale: true,

      hovertemplate:
        '<b>Elevation:</b> %{z:.1f} m ASL<br>' +
        '<b>Grid Pos:</b> (%{x}, %{y})' +
        '<extra>Model 1 · LiDAR Elevation</extra>',

      colorbar: {
        title: {
          text: 'ELEVATION (m)<br><span style="font-size:8px;color:#4a6880">ASL · DEM Range</span>',
          font: { color: '#00d4ff', size: 11, family: 'Inter, sans-serif' },
          side: 'right',
        },
        tickvals: elevTicks.map(t => t.val),
        ticktext: elevTicks.map(t => `${Math.round(t.val)} m`),
        tickfont:  { color: '#8ab4cc', size: 8, family: 'JetBrains Mono, monospace' },
        thickness: 16,
        len:       0.78,
        x:         1.02,
        bordercolor: 'rgba(0,212,255,0.25)',
        borderwidth: 1,
        bgcolor:   'rgba(6,14,26,0.7)',
        outlinewidth: 0,
      },

      contours: {
        z: {
          show: false,
          usecolormap: false,
          highlightcolor: '#00d4ff',
          project: { z: false },
        },
      },

      lighting: {
        ambient:   0.76,
        diffuse:   0.92,
        roughness: 0.36,
        specular:  0.35,
        fresnel:   0.20,
      },
      lightposition: { x: 150, y: 250, z: 700 },
    },
  ] : []

  const layout = {
    paper_bgcolor: PAPER_BG,
    plot_bgcolor:  PLOT_BG,
    margin:        { l: 0, r: 55, t: 0, b: 0 },
    autosize:      true,
    uirevision:    'elevation-stable-camera',
    scene: {
      bgcolor:    PLOT_BG,
      uirevision: 'elevation-stable-camera',
      xaxis: {
        title:           { text: 'X (grid col)', font: { color: LBL_CLR, size: 9 } },
        tickfont:        { color: TICK_CLR, size: 8 },
        gridcolor:       GRID_CLR,
        zerolinecolor:   GRID_CLR,
        backgroundcolor: PLOT_BG,
        showbackground:  true,
      },
      yaxis: {
        title:           { text: 'Y (grid row)', font: { color: LBL_CLR, size: 9 } },
        tickfont:        { color: TICK_CLR, size: 8 },
        gridcolor:       GRID_CLR,
        zerolinecolor:   GRID_CLR,
        backgroundcolor: PLOT_BG,
        showbackground:  true,
      },
      zaxis: {
        title:           { text: 'Elev (m)', font: { color: LBL_CLR, size: 9 } },
        tickfont:        { color: TICK_CLR, size: 8 },
        gridcolor:       GRID_CLR,
        zerolinecolor:   GRID_CLR,
        backgroundcolor: '#020609',
        showbackground:  true,
        ...(terrain ? { range: [terrain.minElevation, terrain.maxElevation] } : {}),
      },
      camera:      CAMERAS[activeView] ?? CAMERAS['3d'],
      aspectmode:  'manual',
      aspectratio: { x: 1.45, y: 1.35, z: 0.68 },
    },
  }

  const config = {
    responsive:             true,
    displayModeBar:         true,
    modeBarButtonsToRemove: ['toImage', 'sendDataToCloud'],
    displaylogo:            false,
  }

  const infoLabel = terrain
    ? `${terrain.width} × ${terrain.height} pts  |  Z: ${Math.round(terrain.minElevation)}–${Math.round(terrain.maxElevation)} m ASL  |  ΔZ: ${Math.round(terrain.maxElevation - terrain.minElevation)} m  |  Res: 1.0 m/px`
    : 'loading…'

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Viewport Toolbar */}
      <div className="viz-toolbar" role="toolbar" aria-label="Model 1 camera controls">
        <span className="viz-toolbar-label">Camera:</span>
        <button
          id="cam-btn-reset"
          className={`viz-btn${activeView === 'default' ? ' active' : ''}`}
          onClick={() => applyCamera('default')}
          disabled={status !== 'ready'}
          title="Reset Camera View"
        >
          Reset
        </button>
        <button
          id="cam-btn-top"
          className={`viz-btn${activeView === 'top' ? ' active' : ''}`}
          onClick={() => applyCamera('top')}
          disabled={status !== 'ready'}
          title="Top View (Nadir)"
        >
          Top
        </button>
        <button
          id="cam-btn-3d"
          className={`viz-btn${activeView === '3d' ? ' active' : ''}`}
          onClick={() => applyCamera('3d')}
          disabled={status !== 'ready'}
          title="3D Perspective View"
        >
          3D
        </button>

        <span className="viz-toolbar-divider" />
        <span style={{ fontSize: '0.6rem', color: '#00d4ff', fontWeight: 700, letterSpacing: '0.08em' }}>
          MODEL 1: LiDAR ELEVATION
        </span>

        <span className="viz-toolbar-spacer" />
        <span className="viz-coord">{infoLabel}</span>
      </div>

      {status === 'loading' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, background: PLOT_BG, color: '#4a6880' }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', border: '2px solid rgba(0,212,255,0.15)', borderTop: '2px solid #00d4ff', animation: 'spin 1s linear infinite' }} />
          <p style={{ fontSize: '0.7rem', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Loading Model 1 LiDAR terrain…</p>
        </div>
      )}

      {status === 'error' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: PLOT_BG }}>
          <p style={{ fontSize: '0.8rem', color: '#ff3355' }}>⚠ Failed to load terrain data: {errMsg}</p>
        </div>
      )}

      {status === 'ready' && (
        <div className="plotly-wrap">
          <Plot
            ref={plotRef}
            data={plotData}
            layout={layout}
            config={config}
            style={{ width: '100%', height: '100%' }}
            useResizeHandler
          />

          {/* Elevation Color Legend Overlay */}
          {terrain && (
            <div className="sm-legend-overlay elev-legend-overlay" aria-label="LiDAR elevation colour legend">
              <div className="sm-legend-header">
                <span className="sm-legend-icon">⛰️</span>
                <span>ELEVATION (m)</span>
              </div>
              <div className="sm-legend-scale-wrap" style={{ height: 160 }}>
                <div className="elev-legend-bar" />
                <div className="sm-legend-ticks">
                  {elevTicks.map(({ pct, val, emoji }) => (
                    <div key={pct} className="sm-legend-tick" style={{ bottom: `${pct * 100}%` }}>
                      <span className="sm-tick-line" />
                      <span className="sm-tick-label">
                        {emoji} {Math.round(val)} m
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="sm-legend-footer">
                <span className="sm-footer-note">USGS LiDAR · 1.0m DEM</span>
                <span className="sm-footer-range">
                  {Math.round(terrain.minElevation)}m – {Math.round(terrain.maxElevation)}m ASL
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
