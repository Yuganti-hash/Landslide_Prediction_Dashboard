import React, { useCallback, useEffect, useRef, useState, Suspense } from 'react'
import Header          from './components/Header'
import MonitoringStrip from './components/MonitoringStrip'
import Sidebar         from './components/Sidebar'
import RightPanel      from './components/RightPanel'

// ── True Single-Model Code Splitting (React.lazy) ─────────────────────────────
// Each model's JS bundle and WebGL/Plotly resources are downloaded and mounted
// ONLY when the user explicitly selects that model.
const ElevationModel     = React.lazy(() => import('./components/ElevationModel'))
const WaterMovementModel = React.lazy(() => import('./components/WaterMovementModel'))
const SoilThicknessModel = React.lazy(() => import('./components/SoilThicknessModel'))
const SaturationModel    = React.lazy(() => import('./components/SaturationModel'))
const FoSModel           = React.lazy(() => import('./components/FoSModel'))

// ── Model metadata for loading overlay (as specified) ─────────────────────────
const MODEL_LABELS = {
  elevation:  'Loading Elevation Model...',
  water:      'Loading Water Movement...',
  soil:       'Loading Soil Thickness...',
  saturation: 'Loading Saturation...',
  fos:        'Loading Factor of Safety...',
}

class ModelErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }
  componentDidCatch(error, info) {
    console.error('Model render error caught by boundary:', error, info)
  }
  componentDidUpdate(prevProps) {
    if (prevProps.activeModel !== this.props.activeModel && this.state.hasError) {
      this.setState({ hasError: false, error: null })
    }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#03080f',
          color: '#f87171',
          padding: 24,
          textAlign: 'center',
          gap: 16,
          zIndex: 40,
        }}>
          <div style={{ fontSize: '2rem' }}>⚠️</div>
          <h3 style={{ margin: 0, color: '#fca5a5', fontSize: '1rem', letterSpacing: '0.05em' }}>
            Model Render Error
          </h3>
          <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.82rem', maxWidth: 500, fontFamily: 'monospace' }}>
            {this.state.error?.message || 'An unexpected error occurred while rendering this model.'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '8px 18px',
              background: 'rgba(0, 212, 255, 0.15)',
              border: '1px solid #00d4ff',
              color: '#00d4ff',
              borderRadius: 4,
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.78rem',
            }}
          >
            Retry Model
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * Lightweight Loading Overlay shown during model transitions and lazy chunk loads
 */
function ModelLoadingOverlay({ label }) {
  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      zIndex: 50,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(3, 8, 15, 0.88)',
      backdropFilter: 'blur(4px)',
      pointerEvents: 'none',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 38,
          height: 38,
          borderRadius: '50%',
          border: '2px solid rgba(0, 212, 255, 0.15)',
          borderTop: '2px solid #00d4ff',
          animation: 'spin 0.8s linear infinite',
        }} />
        <p style={{
          fontSize: '0.72rem',
          color: '#00d4ff',
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
          margin: 0,
          fontWeight: 600,
        }}>
          {label ?? 'Loading Model...'}
        </p>
      </div>
    </div>
  )
}

/**
 * Main Landslide Intelligence Dashboard Application
 *
 * Five Analytical Layers:
 * 1. Elevation — LiDAR/DEM terrain
 * 2. Water Movement — D8 flow routing
 * 3. Soil Thickness — terrain-derived soil thickness
 * 4. Saturation — rainfall + soil moisture
 * 5. Factor of Safety (FoS) — infinite-slope geotechnical model
 */
export default function App() {
  // Centralized model manager: 'elevation' | 'water' | 'soil' | 'saturation' | 'fos'
  const [activeModel, setActiveModel] = useState('elevation')
  // Transient flag: true while previous model is being torn down
  const [modelSwitching, setModelSwitching] = useState(false)
  const switchTimeoutRef = useRef(null)

  const [terrainStats, setTerrainStats]             = useState(null)
  const [smStats, setSmStats]                       = useState(null)
  const [soilThicknessStats, setSoilThicknessStats] = useState(null)
  const [hydrologyStats, setHydrologyStats]         = useState(null)
  const [fosStats, setFosStats]                     = useState(null)

  // Centralized rainfall simulation state (Saturation Model)
  const [rainfallMm, setRainfallMm]                 = useState(50)
  const [rainfallMode, setRainfallMode]             = useState('constant')  // 'constant' | 'schedule'
  const [hourlyRainfall, setHourlyRainfall]         = useState(() => new Array(24).fill(0)) // mm/hr per hour
  const [isPaused, setIsPaused]                     = useState(false)
  const [showRainParticles, setShowRainParticles]   = useState(true)
  const [resetCounter, setResetCounter]             = useState(0)
  const [scheduleComplete, setScheduleComplete]     = useState(false)
  const [isRightPanelOpen, setIsRightPanelOpen]     = useState(true)

  // Saturation matrix shared from Saturation Model → FoS engine
  // Held in ref so 513,608-element updates do NOT re-render App.jsx on ticks!
  const saturationRatioRef = useRef(null)

  // Trigger window resize when right panel is toggled so Plotly 3D canvas reflows smoothly
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        window.dispatchEvent(new Event('resize'))
      } catch {
        // ignore
      }
    }, 60)
    return () => clearTimeout(t)
  }, [isRightPanelOpen])

  // Model switch handler:
  // 1. Unload previous model & clear previous resources
  // 2. Display lightweight loading indicator
  // 3. Mount newly selected model
  const handleModelChange = useCallback((nextModel) => {
    if (nextModel === activeModel) return

    // Clear previous saturation reference when leaving saturation model to free RAM
    if (activeModel === 'saturation') {
      saturationRatioRef.current = null
    }

    setModelSwitching(true)
    setActiveModel(nextModel)

    // Allow one React render cycle to complete teardown and GPU context purge, then clear transition flag
    if (switchTimeoutRef.current) clearTimeout(switchTimeoutRef.current)
    switchTimeoutRef.current = setTimeout(() => setModelSwitching(false), 90)
  }, [activeModel])

  const handleResetRain = () => {
    setRainfallMm(50)
    setIsPaused(false)
    setScheduleComplete(false)
    setResetCounter((c) => c + 1)
  }

  const handleScheduleComplete = (val = true) => {
    if (val === false) {
      setScheduleComplete(false)
      return
    }
    setScheduleComplete(true)
    setIsPaused(true)
  }

  const handleHourlyRainfallChange = (hourIndex, value) => {
    setHourlyRainfall((prev) => {
      const next = [...prev]
      const parsed = parseInt(value, 10)
      next[hourIndex] = isNaN(parsed) ? 0 : Math.max(0, Math.min(200, parsed))
      return next
    })
  }

  useEffect(() => {
    // Fetch terrain metadata
    fetch('/terrain_web.json')
      .then((r) => r.json())
      .then((d) => {
        setTerrainStats({
          minElevation:  d.minElevation,
          maxElevation:  d.maxElevation,
          meanElevation: d.meanElevation,
          width:         d.width,
          height:        d.height,
          dx:            d.dx,
          dy:            d.dy,
          crs:           d.crs,
        })
      })
      .catch(() => {})

    // Fetch real soil-moisture observations
    fetch('/soil_moisture_region.json')
      .then((r) => r.json())
      .then((d) => {
        if (!d.points || d.points.length === 0) return
        const values = d.points.map((p) => p.soilMoisture)
        const sum    = values.reduce((a, b) => a + b, 0)
        setSmStats({
          min:   Math.min(...values),
          max:   Math.max(...values),
          mean:  sum / values.length,
          count: values.length,
        })
      })
      .catch(() => {})
  }, [])

  // Trigger window resize after model finishes mounting to ensure WebGL reflows cleanly
  useEffect(() => {
    const handleResize = () => {
      try {
        window.dispatchEvent(new Event('resize'))
      } catch {
        // ignore
      }
    }
    const t = setTimeout(handleResize, 180)
    return () => clearTimeout(t)
  }, [activeModel])

  // Cleanup switch timeout on unmount
  useEffect(() => () => { if (switchTimeoutRef.current) clearTimeout(switchTimeoutRef.current) }, [])

  return (
    <div className="app">
      {/* ── Top bar ──────────────────────────────────────────── */}
      <Header />

      {/* ── Monitoring strip ─────────────────────────────────── */}
      <MonitoringStrip />

      {/* ── Main workspace ───────────────────────────────────── */}
      <div className="workspace">
        {/* Left icon nav */}
        <Sidebar />

        {/* Centre: 3D Models Workspace */}
        <main
          className="centre-panel"
          id="main-content"
          tabIndex={-1}
          style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}
        >
          {/* ── Five Analytical Layer Navigation Selector ── */}
          <div className="model-selector-bar" role="tablist" aria-label="Analytical layer selector">
            <span className="model-selector-label">Layer:</span>
            <button
              id="btn-model-elevation"
              role="tab"
              aria-selected={activeModel === 'elevation'}
              className={`model-selector-btn model-1 ${activeModel === 'elevation' ? 'active' : ''}`}
              onClick={() => handleModelChange('elevation')}
              disabled={modelSwitching}
            >
              ⛰️ ELEVATION
            </button>
            <button
              id="btn-model-water"
              role="tab"
              aria-selected={activeModel === 'water'}
              className={`model-selector-btn model-water ${activeModel === 'water' ? 'active' : ''}`}
              onClick={() => handleModelChange('water')}
              disabled={modelSwitching}
            >
              🌊 WATER MOVEMENT
            </button>
            <button
              id="btn-model-soil"
              role="tab"
              aria-selected={activeModel === 'soil'}
              className={`model-selector-btn model-st ${activeModel === 'soil' ? 'active' : ''}`}
              onClick={() => handleModelChange('soil')}
              disabled={modelSwitching}
            >
              🪨 SOIL THICKNESS
            </button>
            <button
              id="btn-model-saturation"
              role="tab"
              aria-selected={activeModel === 'saturation'}
              className={`model-selector-btn model-2 ${activeModel === 'saturation' ? 'active' : ''}`}
              onClick={() => handleModelChange('saturation')}
              disabled={modelSwitching}
            >
              🌧️ SATURATION
            </button>
            <button
              id="btn-model-fos"
              role="tab"
              aria-selected={activeModel === 'fos'}
              className={`model-selector-btn model-3 ${activeModel === 'fos' ? 'active' : ''}`}
              onClick={() => handleModelChange('fos')}
              disabled={modelSwitching}
            >
              ⚖️ FACTOR OF SAFETY
            </button>

            {/* Sidebar toggle button in top bar */}
            <button
              id="btn-toggle-sidebar"
              className={`model-selector-btn ${!isRightPanelOpen ? 'active' : ''}`}
              onClick={() => setIsRightPanelOpen((prev) => !prev)}
              title={isRightPanelOpen ? 'Collapse right analytics panel' : 'Expand right analytics panel'}
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                borderColor: !isRightPanelOpen ? '#00d4ff' : 'rgba(0, 212, 255, 0.25)',
                color: !isRightPanelOpen ? '#00d4ff' : '#94a3b8',
                background: !isRightPanelOpen ? 'rgba(0, 212, 255, 0.15)' : 'rgba(3, 8, 15, 0.6)',
              }}
            >
              {isRightPanelOpen ? '◧ HIDE PANEL' : '◨ SHOW PANEL'}
            </button>
          </div>

          {/* Floating side toggle button pinned to right edge */}
          <button
            id="floating-sidebar-toggle"
            onClick={() => setIsRightPanelOpen((prev) => !prev)}
            title={isRightPanelOpen ? 'Collapse side panel for full-width 3D view' : 'Expand side controls and analytics panel'}
            style={{
              position: 'absolute',
              top: '50%',
              right: 0,
              transform: 'translateY(-50%)',
              zIndex: 35,
              background: 'rgba(3, 8, 15, 0.94)',
              border: '1px solid rgba(0, 212, 255, 0.5)',
              borderRight: 'none',
              borderRadius: '6px 0 0 6px',
              padding: isRightPanelOpen ? '10px 5px' : '14px 7px',
              color: '#00d4ff',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              boxShadow: '-4px 0 16px rgba(0, 212, 255, 0.25)',
              transition: 'all 0.2s ease',
            }}
          >
            <span style={{ fontSize: '0.8rem', lineHeight: 1 }}>{isRightPanelOpen ? '▶' : '◀'}</span>
            {!isRightPanelOpen && (
              <span style={{
                writingMode: 'vertical-rl',
                textOrientation: 'mixed',
                fontSize: '0.50rem',
                letterSpacing: '0.12em',
                fontWeight: 700,
                textTransform: 'uppercase',
                color: '#38bdf8',
                marginTop: 2,
              }}>
                CONTROLS & ANALYTICS
              </span>
            )}
          </button>

          {/* ── Loading overlay — shown during model transition ────────── */}
          {modelSwitching && (
            <ModelLoadingOverlay label={MODEL_LABELS[activeModel]} />
          )}

          {/* ── TRUE SINGLE-MODEL CONDITIONAL RENDERING ─────────────────────── */}
          {/* Only ONE model component is mounted in the DOM at any instant.   */}
          {/* Inactive models are unmounted, terminating their Web Workers,     */}
          {/* cancelling animation loops, and purging WebGL GPU memory.         */}
          <ModelErrorBoundary activeModel={activeModel}>
            <Suspense fallback={<ModelLoadingOverlay label={MODEL_LABELS[activeModel]} />}>
              {/* 1. Elevation Model */}
              {activeModel === 'elevation' && (
                <ElevationModel />
              )}

              {/* 2. Water Movement Model */}
              {activeModel === 'water' && (
                <WaterMovementModel
                  onHydrologyStatsChange={setHydrologyStats}
                />
              )}

              {/* 3. Soil Thickness Model */}
              {activeModel === 'soil' && (
                <SoilThicknessModel
                  onSoilThicknessStatsChange={setSoilThicknessStats}
                />
              )}

              {/* 4. Saturation Model */}
              {activeModel === 'saturation' && (
                <SaturationModel
                  onHydrologyStatsChange={setHydrologyStats}
                  onSaturationChange={(sat) => { saturationRatioRef.current = sat }}
                  rainfallMm={rainfallMm}
                  onRainfallChange={setRainfallMm}
                  rainfallMode={rainfallMode}
                  hourlyRainfall={hourlyRainfall}
                  onScheduleComplete={handleScheduleComplete}
                  isPaused={isPaused}
                  onTogglePause={() => setIsPaused((p) => !p)}
                  onResetRain={handleResetRain}
                  showRainParticles={showRainParticles}
                  onToggleRainParticles={() => setShowRainParticles((p) => !p)}
                  resetCounter={resetCounter}
                />
              )}

              {/* 5. Factor of Safety Model */}
              {activeModel === 'fos' && (
                <FoSModel
                  saturationRatioRef={saturationRatioRef}
                  rainfallMm={rainfallMm}
                  hydrologyStats={hydrologyStats}
                  isPaused={isPaused}
                  resetCounter={resetCounter}
                  showRainParticles={showRainParticles}
                  onToggleRainParticles={() => setShowRainParticles((p) => !p)}
                  onFoSStatsChange={setFosStats}
                />
              )}
            </Suspense>
          </ModelErrorBoundary>
        </main>

        {/* Right stats panel — receives stats and activeModel for all 5 layers */}
        {isRightPanelOpen && (
          <RightPanel
            isOpen={isRightPanelOpen}
            onToggle={() => setIsRightPanelOpen((p) => !p)}
            activeModel={activeModel}
            onModelChange={handleModelChange}
            terrainStats={terrainStats}
            smStats={smStats}
            soilThicknessStats={soilThicknessStats}
            hydrologyStats={hydrologyStats}
            fosStats={fosStats}
            rainfallMm={rainfallMm}
            onRainfallChange={setRainfallMm}
            rainfallMode={rainfallMode}
            onRainfallModeChange={setRainfallMode}
            hourlyRainfall={hourlyRainfall}
            onHourlyRainfallChange={handleHourlyRainfallChange}
            scheduleComplete={scheduleComplete}
            isPaused={isPaused}
            onTogglePause={() => setIsPaused((p) => !p)}
            onResetRain={handleResetRain}
            showRainParticles={showRainParticles}
            onToggleRainParticles={() => setShowRainParticles((p) => !p)}
          />
        )}
      </div>
    </div>
  )
}
