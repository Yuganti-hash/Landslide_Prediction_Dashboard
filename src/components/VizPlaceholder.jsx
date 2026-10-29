import React, { useEffect, useMemo, useRef, useState } from 'react'
import Plot from 'react-plotly.js'
import CesiumViewer from './CesiumViewer'
import LiDARWithAerialViewer from './LiDARWithAerialViewer'
import RainFlowOverlay from './RainFlowOverlay'
import RainfallControlPanel from './RainfallControlPanel'
import {
  VIZ_MODES,
  ELEVATION_COLORSCALE,
  SM_COLORSCALE,
  getElevationTicks,
} from '../services/terrainVizModes'

// ── Camera presets ───────────────────────────────────────────────────────────
const CAMERAS = {
  default: { eye: { x: 1.6, y: 1.6, z: 1.0 } },
  top:     { eye: { x: 0,   y: 0,   z: 2.8 } },
  '3d':    { eye: { x: 1.6, y: 1.6, z: 1.0 } },
}

// ── Dashboard colour tokens ──────────────────────────────────────────────────
const PAPER_BG = '#060e1a'
const PLOT_BG  = '#03080f'
const GRID_CLR = 'rgba(0,212,255,0.1)'
const TICK_CLR = '#2a4055'
const LBL_CLR  = '#4a6880'

// ── Known terrain geographic bounding box (GeoTIFF EPSG:26912→WGS84) ────────
const TERRAIN_BBOX = {
  west:  -112.29926877,
  south:  40.46334075,
  east:  -112.06152903,
  north:  40.55593193,
}

// ── Inverse-distance weighting (IDW) soil-moisture interpolation ─────────────
function idwInterpolate(points, lon, lat, power = 2) {
  let weightedSum = 0
  let weightTotal = 0

  for (const pt of points) {
    const dLon = lon - pt.longitude
    const dLat = lat - pt.latitude
    const dist = Math.sqrt(dLon * dLon + dLat * dLat)

    if (dist < 1e-10) {
      return pt.soilMoisture
    }

    const w = 1.0 / Math.pow(dist, power)
    weightedSum += w * pt.soilMoisture
    weightTotal += w
  }

  return weightTotal > 0 ? weightedSum / weightTotal : 0
}

// ── Build a soil-moisture matrix that matches the terrain grid dimensions ────
function buildSoilMoistureMatrix(gridRows, gridCols, smPoints) {
  const { west, east, south, north } = TERRAIN_BBOX
  const lonSpan = east - west
  const latSpan = north - south

  const matrix = []
  for (let r = 0; r < gridRows; r++) {
    const row = new Float32Array(gridCols)
    const lat = north - (r / (gridRows - 1)) * latSpan

    for (let c = 0; c < gridCols; c++) {
      const lon = west + (c / (gridCols - 1)) * lonSpan
      row[c] = idwInterpolate(smPoints, lon, lat)
    }
    matrix.push(Array.from(row))
  }
  return matrix
}

// ── Loading overlay ──────────────────────────────────────────────────────────
function LoadingState() {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 12,
      background: PLOT_BG, color: '#4a6880',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        border: '2px solid rgba(0,212,255,0.15)',
        borderTop: '2px solid #00d4ff',
        animation: 'spin 1s linear infinite',
      }} />
      <p style={{ fontSize: '0.7rem', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
        Loading LiDAR terrain & Soil Moisture data…
      </p>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

// ── Error overlay ────────────────────────────────────────────────────────────
function ErrorState({ message }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 8,
      background: PLOT_BG,
    }}>
      <p style={{ fontSize: '0.8rem', color: '#ff3355', letterSpacing: '0.06em' }}>
        ⚠ Failed to load terrain data
      </p>
      <p style={{ fontSize: '0.65rem', color: '#4a6880', maxWidth: 320, textAlign: 'center' }}>
        {message}
      </p>
      <p style={{ fontSize: '0.6rem', color: '#2a4055', marginTop: 4 }}>
        Make sure <code style={{ color: '#00aacc' }}>public/terrain_web.json</code> exists and dev server is running.
      </p>
    </div>
  )
}

// ── Main VizPlaceholder Component ─────────────────────────────────────────────
// Props:
//   vizMode: 'elevation' | 'soil_moisture' (defaults to 'soil_moisture')
//   onVizModeChange: (mode) => void
//   onHydrologyStatsChange: (stats) => void
export default function VizPlaceholder({
  vizMode: externalVizMode,
  onVizModeChange,
  onHydrologyStatsChange,
}) {
  // Default main viewer is 'plotly' for the LiDAR Model
  const [viewMode, setViewMode] = useState('plotly') // 'plotly' | 'cesium' | 'lidar-aerial'

  // Internal fallback state if vizMode is not controlled from parent
  const [internalVizMode, setInternalVizMode] = useState(VIZ_MODES.SOIL_MOISTURE)
  const vizMode = externalVizMode ?? internalVizMode
  const setVizMode = onVizModeChange ?? setInternalVizMode

  const isElevationMode = vizMode === VIZ_MODES.ELEVATION

  const plotRef    = useRef(null)
  const [activeView, setActiveView] = useState('3d')
  const [status,    setStatus]      = useState('loading') // 'loading' | 'ready' | 'error'
  const [errMsg,    setErrMsg]      = useState('')

  // terrain: { width, height, minElevation, maxElevation, meanElevation, elevation }
  const [terrain, setTerrain] = useState(null)
  // soilMoisture: { points, min, max, mean }
  const [soilMoisture, setSoilMoisture] = useState(null)

  // ── Rainfall simulation controls & state ──
  // Controls the real-time visual rainfall animation over the 3D terrain
  const [rainfallMm, setRainfallMm] = useState(50)
  const [isPaused, setIsPaused]     = useState(false)

  /* ── Fetch Real LiDAR DEM and Real NSIDC Soil Moisture Data ── */
  useEffect(() => {
    let cancelled = false
    setStatus('loading')

    const terrainPromise = fetch('/terrain_web.json')
      .then((res) => {
        if (!res.ok) throw new Error(`terrain_web.json: HTTP ${res.status} — ${res.statusText}`)
        return res.json()
      })
      .then((data) => {
        if (!data.elevation || !Array.isArray(data.elevation)) {
          throw new Error('terrain_web.json is missing the "elevation" matrix field.')
        }
        return data
      })

    const smPromise = fetch('/soil_moisture_region.json')
      .then((res) => {
        if (!res.ok) throw new Error(`soil_moisture_region.json: HTTP ${res.status} — ${res.statusText}`)
        return res.json()
      })
      .then((data) => {
        if (!data.points || !Array.isArray(data.points) || data.points.length === 0) {
          throw new Error('soil_moisture_region.json is missing the "points" array.')
        }
        const smValues = data.points.map((p) => p.soilMoisture)
        const sum = smValues.reduce((a, b) => a + b, 0)
        return {
          points: data.points,
          count:  data.points.length,
          min:    Math.min(...smValues),
          max:    Math.max(...smValues),
          mean:   sum / smValues.length,
        }
      })
      .catch(() => null)

    Promise.all([terrainPromise, smPromise])
      .then(([terrainData, smData]) => {
        if (cancelled) return
        setTerrain(terrainData)
        setSoilMoisture(smData)
        setStatus('ready')
      })
      .catch((err) => {
        if (cancelled) return
        setErrMsg(err.message)
        setStatus('error')
      })

    return () => { cancelled = true }
  }, [])

  /* ── Camera control for Plotly ── */
  const applyCamera = (viewKey) => {
    setActiveView(viewKey)
    if (!plotRef.current) return
    const el = plotRef.current.el
    if (el) {
      window.Plotly?.relayout(el, { 'scene.camera': CAMERAS[viewKey] ?? CAMERAS.default })
    }
  }

  /* ── Interpolate Real Soil Moisture onto Terrain Grid using IDW ── */
  const smColorMatrix = useMemo(() => {
    if (!terrain || !soilMoisture?.points) return null
    return buildSoilMoistureMatrix(terrain.height, terrain.width, soilMoisture.points)
  }, [terrain, soilMoisture])

  // Sync statistics with parent
  useEffect(() => {
    if (soilMoisture && onHydrologyStatsChange) {
      onHydrologyStatsChange({
        rainfallMm: Math.round(rainfallMm),
        meanMoisture: Number(soilMoisture.mean.toFixed(3)),
        minMoisture: Number(soilMoisture.min.toFixed(3)),
        maxMoisture: Number(soilMoisture.max.toFixed(3)),
        relativeRunoffPct: Math.round((rainfallMm / 200) * 45),
        maxFlowAccumulation: 6.8,
        status: rainfallMm === 0 ? 'NO RAINFALL' : isPaused ? 'PAUSED' : 'SIMULATION ACTIVE',
      })
    }
  }, [soilMoisture, rainfallMm, isPaused, onHydrologyStatsChange])

  /* ── Dynamic Elevation ticks for loaded DEM (Elevation Mode) ── */
  const elevTicks = terrain
    ? getElevationTicks(terrain.minElevation, terrain.maxElevation)
    : []

  /* ── Construct Plotly 3D Surface Trace ──
     ARCHITECTURE:
     - Z / terrain height: REAL LiDAR DEM data from terrain_web.json
     - Surface color: REAL NSIDC soil moisture from soil_moisture_region.json
     - Colorscale: 0.0 bright yellow -> 0.5 bright green -> 1.0 bright blue (SM_COLORSCALE)
     - Rainfall value ONLY controls the visual rainfall animation (does NOT modify elevation or SM)
  ── */
  let plotData = []
  if (terrain) {
    if (isElevationMode) {
      // ═══════════════════════════════════════════════════════════════════════
      // 1. ELEVATION MODE:
      // Surface colored directly by elevation (Z value)
      // ═══════════════════════════════════════════════════════════════════════
      plotData = [
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
            '<extra>LiDAR Elevation</extra>',

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
            bordercolor: 'rgba(0,212,255,0.18)',
            borderwidth: 1,
            bgcolor:     'rgba(6,14,26,0.7)',
            outlinewidth: 0,
          },

          contours: {
            z: {
              show:           false,
              usecolormap:    false,
              highlightcolor: '#00d4ff',
              project:        { z: false },
            },
          },

          lighting: {
            ambient:   0.6,
            diffuse:   0.8,
            roughness: 0.5,
            specular:  0.3,
            fresnel:   0.2,
          },
          lightposition: { x: 100, y: 200, z: 500 },
        },
      ]
    } else if (smColorMatrix) {
      // ═══════════════════════════════════════════════════════════════════════
      // 2. SOIL MOISTURE + RAIN ANIMATION MODE (STEP 10):
      // - Z: REAL LiDAR DEM from terrain_web.json
      // - Surface color: REAL NSIDC soil moisture from soil_moisture_region.json
      // - Colorscale: 0.0 -> bright yellow | 0.5 -> bright green | 1.0 -> bright blue
      // - Rainfall controls the visual rainfall animation over the terrain
      // ═══════════════════════════════════════════════════════════════════════
      plotData = [
        {
          type: 'surface',
          z: terrain.elevation,
          surfacecolor: smColorMatrix,
          customdata: smColorMatrix,
          cmin: 0.0,
          cmax: 1.0,
          colorscale: SM_COLORSCALE,
          showscale: true,

          hovertemplate:
            '<b>Elevation:</b> %{z:.1f} m ASL<br>' +
            '<b>Soil Moisture:</b> %{surfacecolor:.4f} m³/m³<br>' +
            `<b>Rainfall:</b> ${rainfallMm} mm<br>` +
            '<i>Grid pos: (%{x}, %{y})</i><extra>LiDAR + Soil Moisture</extra>',

          colorbar: {
            title: {
              text: 'SOIL MOISTURE (m³/m³)<br><span style="font-size:8px;color:#4a6880">NSIDC SMAP IDW Interpolated</span>',
              font: { color: '#00d4ff', size: 11, family: 'Inter, sans-serif' },
              side: 'right',
            },
            tickvals: [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
            ticktext: ['0.0 (Dry)', '0.2', '0.4', '0.6', '0.8', '1.0 (Saturated)'],
            tickfont:  { color: '#8ab4cc', size: 8, family: 'JetBrains Mono, monospace' },
            thickness: 16,
            len:       0.78,
            x:         1.02,
            bordercolor: 'rgba(0,212,255,0.18)',
            borderwidth: 1,
            bgcolor:     'rgba(6,14,26,0.7)',
            outlinewidth: 0,
          },

          contours: {
            z: {
              show:           false,
              usecolormap:    false,
              highlightcolor: '#00d4ff',
              project:        { z: false },
            },
          },

          lighting: {
            ambient:   0.6,
            diffuse:   0.8,
            roughness: 0.5,
            specular:  0.3,
            fresnel:   0.2,
          },
          lightposition: { x: 100, y: 200, z: 500 },
        },
      ]
    }
  }

  const layout = {
    paper_bgcolor: PAPER_BG,
    plot_bgcolor:  PLOT_BG,
    margin:        { l: 0, r: 55, t: 0, b: 0 },
    autosize:      true,
    scene: {
      bgcolor: PLOT_BG,
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
      aspectratio: { x: 1.4, y: 1.4, z: 0.6 },
    },
  }

  const config = {
    responsive:             true,
    displayModeBar:         true,
    modeBarButtonsToRemove: ['toImage', 'sendDataToCloud'],
    displaylogo:            false,
  }

  /* ── Info strip ── */
  const infoLabel = terrain
    ? isElevationMode
      ? `${terrain.width} × ${terrain.height} pts  |  Z: ${Math.round(terrain.minElevation)}–${Math.round(terrain.maxElevation)} m ASL  |  ΔZ: ${Math.round(terrain.maxElevation - terrain.minElevation)} m  |  Res: 1.0 m/px`
      : `${terrain.width} × ${terrain.height} pts  |  Rainfall: ${rainfallMm} mm  |  Soil Moisture: NSIDC SMAP IDW  |  Res: 1.0 m/px`
    : 'loading…'

  return (
    <section className="terrain-viewer" aria-label="3D terrain and landslide visualization">
      {/* Panel mode switcher header */}
      <div className="panel-header" style={{ gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            id="viewmode-lidar"
            className={`viewmode-tab ${viewMode === 'plotly' ? 'active' : ''}`}
            onClick={() => setViewMode('plotly')}
          >
            ⛰️ LiDAR Model
          </button>
          <button
            id="viewmode-cesium"
            className={`viewmode-tab ${viewMode === 'cesium' ? 'active' : ''}`}
            onClick={() => setViewMode('cesium')}
          >
            🌍 Cesium Globe
          </button>
          <button
            id="viewmode-lidar-aerial"
            className={`viewmode-tab ${viewMode === 'lidar-aerial' ? 'active' : ''}`}
            onClick={() => setViewMode('lidar-aerial')}
          >
            🛰️ LiDAR + Aerial
          </button>
        </div>

        <span
          className={`panel-badge ${
            viewMode === 'cesium'       ? 'red-pulse' :
            viewMode === 'lidar-aerial' ? 'cyan-pulse' :
            status === 'ready'          ? (isElevationMode ? 'green' : 'cyan') : 'amber'
          }`}
        >
          {viewMode === 'cesium'       ? '● Cesium Global GIS' :
           viewMode === 'lidar-aerial' ? '🛰️ Utah LiDAR + Aerial Imagery' :
           status === 'ready'          ? (isElevationMode ? '● Utah LiDAR 3D DEM (Elevation)' : '🌧️ Utah LiDAR + Soil Moisture (Rainfall Active)') : 'Loading…'}
        </span>
      </div>

      {/* ── Cesium 3D GIS View ── */}
      {viewMode === 'cesium' && (
        <CesiumViewer />
      )}

      {/* ── LiDAR + Aerial Imagery View ── */}
      {viewMode === 'lidar-aerial' && (
        <LiDARWithAerialViewer />
      )}

      {/* ── Plotly 3D Surface View (LiDAR Model) ── */}
      {viewMode === 'plotly' && (
        <>
          {/* Viewport Toolbar: Camera Controls + Layer System */}
          <div className="viz-toolbar" role="toolbar" aria-label="View and layer controls">
            <span className="viz-toolbar-label">Camera:</span>
            <button
              id="cam-btn-reset"
              className={`viz-btn${activeView === 'default' ? ' active' : ''}`}
              onClick={() => applyCamera('default')}
              aria-pressed={activeView === 'default'}
              disabled={status !== 'ready'}
              title="Reset Camera View"
            >
              Reset
            </button>
            <button
              id="cam-btn-top"
              className={`viz-btn${activeView === 'top' ? ' active' : ''}`}
              onClick={() => applyCamera('top')}
              aria-pressed={activeView === 'top'}
              disabled={status !== 'ready'}
              title="Top View (Nadir)"
            >
              Top
            </button>
            <button
              id="cam-btn-3d"
              className={`viz-btn${activeView === '3d' ? ' active' : ''}`}
              onClick={() => applyCamera('3d')}
              aria-pressed={activeView === '3d'}
              disabled={status !== 'ready'}
              title="3D Perspective View"
            >
              3D
            </button>

            <span className="viz-toolbar-divider" />

            {/* Layer Selector: [ ELEVATION ] [ SOIL MOISTURE ] [ SLOPE ] */}
            <span className="viz-toolbar-label">Layer:</span>
            <button
              id="layer-btn-soilmoisture"
              className={`viz-btn${vizMode === VIZ_MODES.SOIL_MOISTURE ? ' active' : ''}`}
              onClick={() => setVizMode(VIZ_MODES.SOIL_MOISTURE)}
              aria-pressed={vizMode === VIZ_MODES.SOIL_MOISTURE}
              disabled={status !== 'ready'}
              title="Soil Moisture Layer (NSIDC SMAP data + Rainfall Simulation)"
            >
              💧 Soil Moisture
            </button>
            <button
              id="layer-btn-elevation"
              className={`viz-btn${isElevationMode ? ' active' : ''}`}
              onClick={() => setVizMode(VIZ_MODES.ELEVATION)}
              aria-pressed={isElevationMode}
              disabled={status !== 'ready'}
              title="ELEVATION: Normal LiDAR Elevation Model (Pure Z-gradient)"
            >
              ⛰️ Elevation
            </button>
            <button
              id="layer-btn-slope"
              className="viz-btn disabled-btn"
              disabled
              title="SLOPE: Coming next"
            >
              📐 Slope
            </button>

            <span className="viz-toolbar-spacer" />
            <span className="viz-coord">{infoLabel}</span>
          </div>

          {status === 'loading' && <LoadingState />}
          {status === 'error'   && <ErrorState message={errMsg} />}
          {status === 'ready'   && (
            <div className="plotly-wrap">
              <Plot
                ref={plotRef}
                data={plotData}
                layout={layout}
                config={config}
                style={{ width: '100%', height: '100%' }}
                useResizeHandler
              />

              {/* ── ELEVATION LEGEND OVERLAY (Elevation Mode) ── */}
              {isElevationMode && terrain && (
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

              {/* ── SOIL MOISTURE OVERLAYS (STEP 10) ── */}
              {vizMode === VIZ_MODES.SOIL_MOISTURE && (
                <>
                  {/* Real NSIDC Soil Moisture Color Legend (Yellow -> Green -> Blue) */}
                  <div className="sm-legend-overlay" aria-label="Soil moisture colour legend">
                    <div className="sm-legend-header">
                      <span className="sm-legend-icon">💧</span>
                      <span>SOIL MOISTURE</span>
                    </div>

                    <div className="sm-legend-scale-wrap" style={{ height: 130 }}>
                      {/* Gradient bar: 0.0 bright yellow -> 0.5 green -> 1.0 bright blue */}
                      <div className="sm-legend-bar" />
                      <div className="sm-legend-ticks">
                        {[
                          { pct: 1.0, val: '1.0 (Sat)', emoji: '🔵' },
                          { pct: 0.8, val: '0.8',       emoji: '🩵' },
                          { pct: 0.6, val: '0.6',       emoji: '🟩' },
                          { pct: 0.4, val: '0.4',       emoji: '🟢' },
                          { pct: 0.2, val: '0.2',       emoji: '🟡' },
                          { pct: 0.0, val: '0.0 (Dry)', emoji: '🟨' },
                        ].map(({ pct, val, emoji }) => (
                          <div key={pct} className="sm-legend-tick" style={{ bottom: `${pct * 100}%` }}>
                            <span className="sm-tick-line" />
                            <span className="sm-tick-label">{emoji} {val}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="sm-legend-footer">
                      <span className="sm-footer-note">NSIDC SMAP L4</span>
                      <span className="sm-footer-range">0.0 – 1.0 m³/m³</span>
                    </div>
                  </div>

                  {/* Real-time 60fps Vertical Rainfall Animation falling directly over 3D terrain */}
                  <RainFlowOverlay
                    rainfallMm={rainfallMm}
                    isPaused={isPaused}
                  />

                  {/* RAINFALL Control Panel */}
                  <RainfallControlPanel
                    rainfallMm={rainfallMm}
                    onRainfallChange={setRainfallMm}
                    isPaused={isPaused}
                    onTogglePause={() => setIsPaused(p => !p)}
                    onReset={() => {
                      setRainfallMm(50)
                      setIsPaused(false)
                    }}
                    simStatus={
                      rainfallMm === 0
                        ? 'NO RAINFALL'
                        : isPaused
                          ? 'PAUSED'
                          : 'SIMULATION ACTIVE'
                    }
                  />
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
