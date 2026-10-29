import React, { useEffect, useMemo, useRef, useState } from 'react'
import RainFlowOverlay from './RainFlowOverlay'
import StreamFlowCanvas from './StreamFlowCanvas'
import { MODEL2_SATURATION_COLORSCALE } from '../services/terrainVizModes'
import { buildTerrainDerivatives, getCompassDirection } from '../services/terrainDerivatives'
import {
  STANDARD_SOIL_PROFILE,
  initializeSoilWaterState,
  stepSoilWaterSimulation,
  saturationTo2DMatrix,
  runModel2Validation,
  buildDisplayIndexMaps,
  downsampleElevation2D,
  downsampleSaturationTo2D,
  downsampleDiagnosticTo2D,
  downsampleBlendedSurfaceColor2D,
} from '../services/soilSaturationSimulation'

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

// ── Geographic bounding box for GeoTIFF EPSG:26912 → WGS84 ───────────────────
const TERRAIN_BBOX = {
  west:  -112.29926877,
  south:  40.46334075,
  east:  -112.06152903,
  north:  40.55593193,
}

// ── Overlay Legends for Diagnostic & Saturation Layers ────────────────────────
const LAYER_LEGENDS = {
  moisture: {
    icon: '💧',
    title: 'SOIL SATURATION',
    gradient: 'linear-gradient(to top, #FFF9C4 0%, #FDE047 25%, #EAB308 38%, #CA8A04 48%, #1E3A8A 60%, #1E40AF 72%, #0284C7 85%, #38BDF8 94%, #BAE6FD 100%)',
    ticks: [
      { pct: 1.00, label: '100% — Water Streams / Saturated', color: '#bae6fd' },
      { pct: 0.85, label: '85% — High Saturation',            color: '#38bdf8' },
      { pct: 0.70, label: '70% — Wetting Flow',               color: '#1e40af' },
      { pct: 0.55, label: '55% — Infiltration Flow',          color: '#1e3a8a' },
      { pct: 0.38, label: '38% — Moderate Moisture',          color: '#eab308' },
      { pct: 0.20, label: '20% — Dry Baseline',               color: '#fde047' },
      { pct: 0.00, label: '0% — Low Saturation (Dry)',        color: '#fff9c4' },
    ],
    note: 'Physical soil saturation S / S_max',
    range: '0% – 100% Saturation',
  },
  slope: {
    icon: '📐',
    title: 'SLOPE GRADIENT',
    gradient: 'linear-gradient(to top, #ffffb2 0%, #fecc5c 25%, #fd8d3c 50%, #f03b20 75%, #bd0026 100%)',
    ticks: [
      { pct: 1.0,  label: '60°+ — CLIFF' },
      { pct: 0.75, label: '45° — STEEP' },
      { pct: 0.50, label: '30° — MODERATE' },
      { pct: 0.25, label: '15° — GENTLE' },
      { pct: 0.0,  label: '0° — FLAT' },
    ],
    note: 'LiDAR surface gradient',
    range: '0° – 60°',
  },
  aspect: {
    icon: '🧭',
    title: 'ASPECT / AZIMUTH',
    gradient: 'linear-gradient(to top, #ff0000 0%, #ffff00 25%, #00ff00 50%, #00ffff 75%, #0000ff 100%)',
    ticks: [
      { pct: 1.0,  label: '360° — N' },
      { pct: 0.75, label: '270° — W' },
      { pct: 0.50, label: '180° — S' },
      { pct: 0.25, label: '90° — E' },
      { pct: 0.0,  label: '0° — N' },
    ],
    note: 'Downslope orientation',
    range: '0° – 360°',
  },
  profile_curv: {
    icon: '〰',
    title: 'PROFILE CURV',
    gradient: 'linear-gradient(to top, #0571b0 0%, #92c5de 35%, #f7f7f7 50%, #f4a582 65%, #ca0020 100%)',
    ticks: [
      { pct: 1.0,  label: '+0.04 CONCAVE' },
      { pct: 0.5,  label: '0.00 PLANAR' },
      { pct: 0.0,  label: '-0.04 CONVEX' },
    ],
    note: 'Slope acceleration/decel',
    range: 'Along-slope curvature',
  },
  plan_curv: {
    icon: '➿',
    title: 'PLAN CURVATURE',
    gradient: 'linear-gradient(to top, #0c2c84 0%, #1d91c0 35%, #ffffcc 50%, #fe9929 65%, #d95f0e 100%)',
    ticks: [
      { pct: 1.0,  label: '+0.04 CONVERGENT' },
      { pct: 0.5,  label: '0.00 PLANAR' },
      { pct: 0.0,  label: '-0.04 DIVERGENT' },
    ],
    note: 'Flow convergence/focus',
    range: 'Across-slope curvature',
  },
}

// ── Inverse-distance weighting (IDW) interpolation of NSIDC points ──────────
function idwInterpolate(points, lon, lat, power = 2) {
  let weightedSum = 0
  let weightTotal = 0

  for (const pt of points) {
    const dLon = lon - pt.longitude
    const dLat = lat - pt.latitude
    const dist = Math.sqrt(dLon * dLon + dLat * dLat)

    if (dist < 1e-10) return pt.soilMoisture

    const w = 1.0 / Math.pow(dist, power)
    weightedSum += w * pt.soilMoisture
    weightTotal += w
  }

  return weightTotal > 0 ? weightedSum / weightTotal : 0
}

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

/**
 * MODEL 2 — TIME-DEPENDENT SOIL WATER STORAGE & SATURATION SIMULATION
 *
 * Physical Model:
 * RAIN INTENSITY (mm/hr)
 *       ↓
 * RAINFALL INPUT OVER TIME (mm)
 *       ↓
 * INFILTRATION INTO SOIL (bounded by K_sat & saturation)
 *       ↓
 * SOIL WATER STORAGE: S(t+Δt) = S(t) + Infiltration - Runoff - Drainage (mm)
 *       ↓
 * SATURATION RATIO = S / S_max (0.0 to 1.0)
 *       ↓
 * GRADUAL BLUE SHADING (0–95%)
 *       ↓
 * CRITICAL SATURATION (≥ 95%) & D8 DOWNSLOPE FLOW PATHS → RED
 */
export default function RainSoilMoistureModel({
  onHydrologyStatsChange,
  onSaturationChange,              // NEW: shares raw saturationRatio with Model 4 (FoS)
  rainfallMm: propRainfallMm,      // Rainfall Intensity in mm/hr (0–200) — used in constant mode
  onRainfallChange,
  rainfallMode = 'constant',       // 'constant' | 'schedule'
  hourlyRainfall,                  // number[24] — only used in schedule mode
  onScheduleComplete,              // () => void — called when simulation reaches hour 24
  isPaused: propIsPaused,
  onTogglePause,
  onResetRain,
  showRainParticles: propShowRainParticles,
  onToggleRainParticles,
  resetCounter = 0,
  isActive = true,
}) {
  const containerRef = useRef(null)
  const graphDivRef = useRef(null)
  const plotInitialized = useRef(false)
  const cameraRef = useRef(CAMERAS['3d'])   // live user camera — updated via onRelayout (no re-render)
  const hoverHandlerRef = useRef(null)
  const relayoutHandlerRef = useRef(null)
  const [activeView, setActiveView] = useState('3d')
  const [activeLayer, setActiveLayer] = useState('moisture') // 'moisture' | 'slope' | 'aspect' | 'profile_curv' | 'plan_curv'
  const [status, setStatus] = useState('loading')
  const [errMsg, setErrMsg] = useState('')

  const [terrain, setTerrain] = useState(null)
  const [soilMoisture, setSoilMoisture] = useState(null)

  // Simulation State kept in Ref to eliminate React re-render lag of 513,608 cells
  const simStateRef = useRef(null)
  // Lightweight UI telemetry state for HUD display
  const [telemetry, setTelemetry] = useState(null)
  const [timestepMin] = useState(5) // 5 minutes per simulation step
  const [tickSpeedMs] = useState(350) // Clock interval: 350ms per step

  // Local fallbacks if not controlled by parent
  const [internalRainfallMm, setInternalRainfallMm] = useState(50)
  const [internalIsPaused, setInternalIsPaused]     = useState(false)
  const [internalShowRain, setInternalShowRain]     = useState(true)
  const [showHUD, setShowHUD]                       = useState(true)
  const [showTooltip, setShowTooltip]               = useState(true)
  const [hudOpacity, setHudOpacity]                 = useState(100)
  const [showPhysicsPanel, setShowPhysicsPanel]     = useState(false)

  const rainfallMm = propRainfallMm !== undefined ? propRainfallMm : internalRainfallMm
  const setRainfallMm = onRainfallChange || setInternalRainfallMm
  const isPaused = propIsPaused !== undefined ? propIsPaused : internalIsPaused
  const togglePause = onTogglePause || (() => setInternalIsPaused((p) => !p))
  const showRainParticles = propShowRainParticles !== undefined ? propShowRainParticles : internalShowRain
  const toggleRainParticles = onToggleRainParticles || (() => setInternalShowRain((p) => !p))

  // Current hovered terrain cell details for interactive inspection
  const [hoveredCell, setHoveredCell] = useState(null)

  // Explicit unmount cleanup for memory stability & WebGL context disposal
  useEffect(() => {
    return () => {
      if (hoverThrottleTimerRef.current) clearTimeout(hoverThrottleTimerRef.current)
      const gd = graphDivRef.current
      if (gd && window.Plotly) {
        try {
          window.Plotly.purge(gd)
        } catch {
          // ignore
        }
      }
      simStateRef.current = null
      graphDivRef.current = null
      plotInitialized.current = false
    }
  }, [])

  // 1. Fetch real LiDAR DEM and real NSIDC SMAP observations with AbortController
  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')

    const terrainPromise = fetch('/terrain_web.json', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`terrain_web.json: HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (!data.elevation || !Array.isArray(data.elevation)) {
          throw new Error('terrain_web.json missing elevation matrix')
        }
        return data
      })

    const smPromise = fetch('/soil_moisture_region.json', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`soil_moisture_region.json: HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (!data.points || !Array.isArray(data.points) || data.points.length === 0) {
          throw new Error('soil_moisture_region.json missing points')
        }
        return data
      })

    Promise.all([terrainPromise, smPromise])
      .then(([terrainData, smData]) => {
        setTerrain(terrainData)
        setSoilMoisture(smData)
        setStatus('ready')
      })
      .catch((err) => {
        if (err.name === 'AbortError') return
        setErrMsg(err.message)
        setStatus('error')
      })

    return () => {
      controller.abort()
    }
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

  // Capture user camera changes (rotate/pan/zoom) WITHOUT triggering React re-render
  const handlePlotlyRelayout = (eventData) => {
    if (!eventData) return
    setActiveView('custom')
    if (eventData['scene.camera']) {
      cameraRef.current = eventData['scene.camera']
    } else if (eventData['scene.camera.eye'] || eventData['scene.camera.center'] || eventData['scene.camera.up']) {
      cameraRef.current = {
        ...(cameraRef.current || {}),
        eye: eventData['scene.camera.eye'] ?? cameraRef.current?.eye,
        center: eventData['scene.camera.center'] ?? cameraRef.current?.center,
        up: eventData['scene.camera.up'] ?? cameraRef.current?.up,
      }
    } else if (eventData['scene.camera.eye.x'] !== undefined) {
      const prevEye = cameraRef.current?.eye || { x: 1.25, y: 1.25, z: 0.80 }
      cameraRef.current = {
        ...(cameraRef.current || {}),
        eye: {
          x: eventData['scene.camera.eye.x'] ?? prevEye.x,
          y: eventData['scene.camera.eye.y'] ?? prevEye.y,
          z: eventData['scene.camera.eye.z'] ?? prevEye.z,
        },
      }
    }
  }

  relayoutHandlerRef.current = handlePlotlyRelayout

  // ResizeObserver ensures canvas always fills container without resetting camera
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

  // 2. Baseline IDW matrix using real NSIDC soil moisture points
  const baseSmMatrix = useMemo(() => {
    if (!terrain || !soilMoisture?.points) return null
    return buildSoilMoistureMatrix(terrain.height, terrain.width, soilMoisture.points)
  }, [terrain, soilMoisture])

  // 3. Precompute static DEM geomorphometry derivatives (Slope, Aspect, Curvatures, D8 routing)
  const terrainHydrology = useMemo(() => {
    if (!terrain) return null
    return buildTerrainDerivatives(terrain)
  }, [terrain])

  // 4. Optimized Display Grid Index Maps (~291 cols x 197 rows)
  // FULL RESOLUTION SIMULATION (872 x 589) is strictly preserved underneath for all physics.
  // Display grid is deterministically sampled from the exact same LiDAR DEM bounds.
  const displayMaps = useMemo(() => {
    if (!terrain?.width || !terrain?.height) return null
    return buildDisplayIndexMaps(terrain.width, terrain.height, 3)
  }, [terrain?.width, terrain?.height])

  // Static display terrain geometry created ONCE
  const displayElevation = useMemo(() => {
    if (!terrain?.elevation || !displayMaps) return null
    return downsampleElevation2D(terrain.elevation, displayMaps.rowMap, displayMaps.colMap)
  }, [terrain?.elevation, displayMaps])

  const displayX = useMemo(() => {
    if (!displayMaps) return null
    return Array.from(displayMaps.colMap)
  }, [displayMaps])

  const displayY = useMemo(() => {
    if (!displayMaps) return null
    return Array.from(displayMaps.rowMap)
  }, [displayMaps])

  const safeRestyle = (gd, update, indices = [0]) => {
    try {
      if (gd && window.Plotly && plotInitialized.current && Array.isArray(gd.data) && gd.data.length > 0) {
        window.Plotly.restyle(gd, update, indices)
      }
    } catch {
      // ignore transient restyle calls during unmount / transition
    }
  }

  // Mouse interaction state tracking to prioritize camera movement over hover re-renders & color restyle
  const isMouseDownRef = useRef(false)
  const hoverThrottleTimerRef = useRef(null)
  const lastTelemetryTimeRef = useRef(0)

  // ── Global pointerup listener (ensures isMouseDownRef resets even if mouse released outside canvas)
  useEffect(() => {
    const handleGlobalPointerUp = () => {
      isMouseDownRef.current = false
    }
    window.addEventListener('pointerup', handleGlobalPointerUp)
    return () => window.removeEventListener('pointerup', handleGlobalPointerUp)
  }, [])

  // Helper to publish stats cleanly without flooding React state
  const publishStats = (stats, intensity) => {
    if (!terrainHydrology || !onHydrologyStatsChange) return
    const hydroStats = terrainHydrology.stats
    onHydrologyStatsChange({
      rainfallMm: intensity,
      rainfallIntensityMmPerHr: intensity,
      elapsedTimeMin: stats.elapsedTimeMin,
      accumulatedRainfallMm: stats.accumulatedRainfallMm,
      meanSaturationPct: stats.meanSaturationPct,
      minSaturationPct: stats.minSaturationPct,
      maxSaturationPct: stats.maxSaturationPct,
      criticalCells: stats.criticalCells,
      excessFlowCells: stats.excessFlowCells,
      meanMoisture: Number(((stats.meanSaturationPct / 100) * STANDARD_SOIL_PROFILE.porosity).toFixed(4)),
      meanSlope: hydroStats.meanSlope,
      meanAspect: hydroStats.meanAspect,
      meanAspectCompass: hydroStats.meanAspectCompass,
      meanProfileCurvature: hydroStats.meanProfileCurvature,
      meanPlanCurvature: hydroStats.meanPlanCurvature,
      activeLayer,
      status: intensity === 0 ? 'NO RAINFALL' : isPaused ? 'PAUSED' : 'SIMULATION ACTIVE',
      soilProfile: STANDARD_SOIL_PROFILE.label,
      soilThickness: STANDARD_SOIL_PROFILE.thicknessLabel,
    })
  }

  // 5. Initialize soil water state at t = 0 or on Reset (Full 872x589 Resolution)
  useEffect(() => {
    if (terrain && baseSmMatrix && terrainHydrology) {
      const initial = initializeSoilWaterState(terrain, baseSmMatrix, terrainHydrology, STANDARD_SOIL_PROFILE)
      simStateRef.current = initial
      setTelemetry(initial.stats)
      onSaturationChange?.(initial.saturationRatio)
      publishStats(initial.stats, rainfallMm)
      // Execute self-tests in development environment
      runModel2Validation(terrain, terrainHydrology)
    }
  }, [terrain, baseSmMatrix, terrainHydrology, resetCounter])

  // 6. Active Simulation Clock Tick (Runs at full 872x589 resolution)
  // Mathematical physics is strictly separated from rendering:
  // - Scientific equations run at full 872x589 resolution in simStateRef (ZERO React re-renders)
  // - Surface color is updated via Plotly.restyle() (never rebuilds camera, traces, or React components)
  // - While user is dragging/rotating camera, restyling is paused for buttery 60fps rotation
  useEffect(() => {
    if (isPaused || status !== 'ready' || !terrain || !terrainHydrology || !simStateRef.current) return

    const timer = setInterval(() => {
      if (!simStateRef.current) return

      let currentIntensity = rainfallMm // constant mode default

      if (rainfallMode === 'schedule' && Array.isArray(hourlyRainfall)) {
        const elapsed = simStateRef.current.elapsedTimeMin
        if (elapsed >= 24 * 60) {
          onScheduleComplete?.()
          return
        }
        const hourIdx = Math.min(23, Math.floor(elapsed / 60))
        currentIntensity = hourlyRainfall[hourIdx] ?? 0
      }

      const next = stepSoilWaterSimulation(
        simStateRef.current,
        currentIntensity,
        timestepMin,
        terrain,
        terrainHydrology,
        STANDARD_SOIL_PROFILE
      )
      simStateRef.current = next

      // Share raw Float32Array saturation with Model 3 (held in ref by parent)
      onSaturationChange?.(next.saturationRatio)

      // Visual surface color restyle (only if mouse is NOT actively dragging camera)
      if (activeLayer === 'moisture' && displayMaps && !isMouseDownRef.current) {
        const dispSat = downsampleBlendedSurfaceColor2D(
          next.saturationRatio,
          terrain.elevation,
          terrain.minElevation,
          terrain.maxElevation,
          terrain.width,
          terrain.height,
          displayMaps.rowMap,
          displayMaps.colMap,
          next.accumulatedRainfallMm ?? next.stats?.accumulatedRainfallMm ?? 0,
          terrainHydrology
        )
        requestAnimationFrame(() => {
          const gd = graphDivRef.current
          if (gd && !isMouseDownRef.current && gd.offsetWidth > 0) {
            safeRestyle(gd, { surfacecolor: [dispSat] }, [0])
          }
        })
      }

      // Throttled UI telemetry update to RightPanel (once every 500ms)
      const now = performance.now()
      if (now - lastTelemetryTimeRef.current >= 500) {
        lastTelemetryTimeRef.current = now
        setTelemetry(next.stats)
        publishStats(next.stats, currentIntensity)
      }
    }, tickSpeedMs)

    return () => clearInterval(timer)
  }, [isPaused, status, terrain, terrainHydrology, rainfallMm, rainfallMode, hourlyRainfall, timestepMin, tickSpeedMs, activeLayer, displayMaps, onSaturationChange, onScheduleComplete])

  // Sync telemetry when pause state, rainfall, or mode changes
  useEffect(() => {
    if (simStateRef.current && terrainHydrology) {
      let currentIntensity = rainfallMm
      if (rainfallMode === 'schedule' && Array.isArray(hourlyRainfall)) {
        const hourIdx = Math.min(23, Math.floor((simStateRef.current.elapsedTimeMin || 0) / 60))
        currentIntensity = hourlyRainfall[hourIdx] ?? 0
      }
      publishStats(simStateRef.current.stats, currentIntensity)
    }
  }, [isPaused, rainfallMm, rainfallMode, activeLayer])

  // Re-apply surfacecolor when tab becomes active
  useEffect(() => {
    if (!isActive) return
    const gd = graphDivRef.current
    if (!gd || !displayMaps || !terrain) return
    if (activeLayer === 'moisture' && simStateRef.current?.saturationRatio) {
      const dispSat = downsampleBlendedSurfaceColor2D(
        simStateRef.current.saturationRatio,
        terrain.elevation,
        terrain.minElevation,
        terrain.maxElevation,
        terrain.width,
        terrain.height,
        displayMaps.rowMap,
        displayMaps.colMap,
        simStateRef.current.accumulatedRainfallMm ?? 0,
        terrainHydrology
      )
      requestAnimationFrame(() => {
        if (gd && gd.offsetWidth > 0) {
          safeRestyle(gd, { surfacecolor: [dispSat] }, [0])
        }
      })
    }
  }, [isActive])

  // Reset simulation handler
  const handleReset = () => {
    if (terrain && baseSmMatrix && terrainHydrology && displayMaps) {
      const initial = initializeSoilWaterState(terrain, baseSmMatrix, terrainHydrology, STANDARD_SOIL_PROFILE)
      simStateRef.current = initial
      setTelemetry(initial.stats)
      onHydrologyStatsChange?.(initial.stats)
      onSaturationChange?.(initial.saturationRatio)
      if (activeLayer === 'moisture') {
        const dispSat = downsampleBlendedSurfaceColor2D(
          initial.saturationRatio,
          terrain.elevation,
          terrain.minElevation,
          terrain.maxElevation,
          terrain.width,
          terrain.height,
          displayMaps.rowMap,
          displayMaps.colMap,
          0,
          terrainHydrology
        )
        const gd = graphDivRef.current
        safeRestyle(gd, { surfacecolor: [dispSat] }, [0])
      }
    }
    onScheduleComplete?.(false)
    onResetRain?.()
  }

  // Baseline/initial blended matrix for static plotData setup:
  // At t = 0 (before rainfall/saturation), this computes the 100% elevation-driven yellow map!
  const initialDisplaySaturation = useMemo(() => {
    if (!displayMaps || !terrain) return null
    return downsampleBlendedSurfaceColor2D(
      simStateRef.current?.saturationRatio ?? null,
      terrain.elevation,
      terrain.minElevation,
      terrain.maxElevation,
      terrain.width,
      terrain.height,
      displayMaps.rowMap,
      displayMaps.colMap,
      simStateRef.current?.accumulatedRainfallMm ?? 0,
      terrainHydrology
    )
  }, [displayMaps, terrain, terrainHydrology, resetCounter, activeLayer === 'moisture'])

  // On-demand 2D matrices for diagnostic layers (downsampled to display grid)
  const displayDiagnosticMatrix = useMemo(() => {
    if (!terrainHydrology || !displayMaps || activeLayer === 'moisture') return null
    let flat = null
    if (activeLayer === 'slope') flat = terrainHydrology.slopeMatrix
    else if (activeLayer === 'aspect') flat = terrainHydrology.aspectMatrix
    else if (activeLayer === 'profile_curv') flat = terrainHydrology.profileCurvatureMatrix
    else if (activeLayer === 'plan_curv') flat = terrainHydrology.planCurvatureMatrix
    if (!flat) return null
    return downsampleDiagnosticTo2D(flat, terrain.width, terrain.height, displayMaps.rowMap, displayMaps.colMap)
  }, [terrainHydrology, displayMaps, activeLayer, terrain?.width, terrain?.height])

  // Hover handler on 3D Plotly surface (throttled & disabled during mouse drag)
  const handlePlotlyHover = (eventData) => {
    if (isMouseDownRef.current) return // Zero hover interference while rotating/panning
    if (hoverThrottleTimerRef.current) return
    hoverThrottleTimerRef.current = setTimeout(() => {
      hoverThrottleTimerRef.current = null
    }, 60)

    const pt = eventData?.points?.[0]
    if (!pt || pt.x == null || pt.y == null || !terrain || !terrainHydrology) return

    const c = Math.max(0, Math.min(terrain.width - 1, Math.round(pt.x)))
    const r = Math.max(0, Math.min(terrain.height - 1, Math.round(pt.y)))
    const idx = r * terrain.width + c

    const satVal = simStateRef.current?.saturationRatio?.[idx] ?? null
    const storageVal = simStateRef.current?.storage?.[idx] ?? null
    const isCrit = satVal != null && satVal >= STANDARD_SOIL_PROFILE.criticalSaturationThreshold

    setHoveredCell({
      x: c,
      y: r,
      z: pt.z,
      slope: terrainHydrology.slopeMatrix[idx],
      aspect: terrainHydrology.aspectMatrix[idx],
      profileCurv: terrainHydrology.profileCurvatureMatrix[idx],
      planCurv: terrainHydrology.planCurvatureMatrix[idx],
      saturation: satVal,
      storageMm: storageVal,
      isCritical: isCrit,
    })
  }
  hoverHandlerRef.current = handlePlotlyHover

  const config = {
    responsive:     true,
    displayModeBar: false,
    displaylogo:    false,
  }

  // ── Build the base layout (structural config only — NO camera recreation) ────
  const buildLayout = (terrainData) => ({
    paper_bgcolor: PAPER_BG,
    plot_bgcolor:  PLOT_BG,
    margin:        { l: 0, r: 0, t: 0, b: 0 },
    autosize:      true,
    uirevision:    'model2-stable-camera', // stable constant — NEVER reset camera on data update
    scene: {
      bgcolor: PLOT_BG,
      uirevision: 'model2-stable-camera',
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
        ...(terrainData ? { range: [terrainData.minElevation, terrainData.maxElevation] } : {}),
      },
      camera:      cameraRef.current, // live camera angle preserved
      aspectmode:  'manual',
      aspectratio: { x: 1.45, y: 1.35, z: 0.68 },
    },
  })

  // ── 7. Initialize Plotly ONCE with newPlot() ─────────────────────────────
  // Initialized directly with initial saturation trace.
  // All subsequent updates use restyle() → camera, zoom, and orientation are NEVER disturbed.
  useEffect(() => {
    if (status !== 'ready' || !displayElevation || !displayX || !displayY || !terrain) return
    const gd = graphDivRef.current
    if (!gd || !window.Plotly || plotInitialized.current) return

    plotInitialized.current = true

    const initialColor = initialDisplaySaturation ?? displayElevation

    const surfaceTrace = {
      type: 'surface',
      x: displayX,
      y: displayY,
      z: displayElevation,
      surfacecolor: initialColor,
      cmin: 0.0,
      cmax: 1.0,
      colorscale: MODEL2_SATURATION_COLORSCALE,
      showscale: false,
      hoverinfo: showTooltip ? 'all' : 'none',
      hovertemplate: showTooltip ? (
        '<b>Soil Saturation:</b> %{surfacecolor:.1%}<br>' +
        '<b>Elevation:</b> %{z:.1f} m ASL<br>' +
        '<b>Grid:</b> (%{x}, %{y})<br>' +
        '<extra>Soil Saturation Layer</extra>'
      ) : '',
      contours: {
        z: {
          show: false,
          usecolormap: false,
          highlightcolor: '#00d4ff',
          project: { z: false },
        },
      },
      lighting: {
        ambient:   0.56,
        diffuse:   0.84,
        roughness: 0.40,
        specular:  0.42,
        fresnel:   0.22,
      },
      lightposition: { x: 120, y: 220, z: 850 },
    }

    const plotPromise = window.Plotly?.newPlot(gd, [surfaceTrace], buildLayout(terrain), config)
    if (plotPromise && typeof plotPromise.then === 'function') {
      plotPromise.then(() => {
        plotInitialized.current = true
        if (gd && initialColor) {
          safeRestyle(gd, { surfacecolor: [initialColor] }, [0])
        }
      }).catch(() => {})
    } else {
      plotInitialized.current = true
    }

    gd.on('plotly_hover', (d) => hoverHandlerRef.current?.(d))
    gd.on('plotly_unhover', () => setHoveredCell(null))
    gd.on('plotly_relayout', (d) => relayoutHandlerRef.current?.(d))

    return () => {
      if (gd && window.Plotly) {
        try {
          window.Plotly.purge(gd)
        } catch {
          // ignore
        }
      }
      plotInitialized.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayElevation, displayX, displayY, terrain])

  // ── 8. Restyle surface color when activeLayer changes ────────────────────
  // restyle() never resets camera, pan, or zoom.
  useEffect(() => {
    const gd = graphDivRef.current
    if (!gd || !window.Plotly || !plotInitialized.current) return
    let surfacecolor = null
    let cmin = 0.0
    let cmax = 1.0
    let colorscale = MODEL2_SATURATION_COLORSCALE

    if (activeLayer === 'moisture') {
      if (simStateRef.current && displayMaps && terrain) {
        surfacecolor = downsampleBlendedSurfaceColor2D(
          simStateRef.current.saturationRatio,
          terrain.elevation,
          terrain.minElevation,
          terrain.maxElevation,
          terrain.width,
          terrain.height,
          displayMaps.rowMap,
          displayMaps.colMap,
          simStateRef.current.accumulatedRainfallMm ?? 0,
          terrainHydrology
        )
      } else {
        surfacecolor = initialDisplaySaturation
      }
    } else if (activeLayer === 'slope' && displayDiagnosticMatrix) {
      surfacecolor = displayDiagnosticMatrix
      cmin = 0
      cmax = 60
      colorscale = 'YlOrRd'
    } else if (activeLayer === 'aspect' && displayDiagnosticMatrix) {
      surfacecolor = displayDiagnosticMatrix
      cmin = 0
      cmax = 360
      colorscale = 'HSV'
    } else if (activeLayer === 'profile_curv' && displayDiagnosticMatrix) {
      surfacecolor = displayDiagnosticMatrix
      cmin = -0.04
      cmax = 0.04
      colorscale = 'RdBu'
    } else if (activeLayer === 'plan_curv' && displayDiagnosticMatrix) {
      surfacecolor = displayDiagnosticMatrix
      cmin = -0.04
      cmax = 0.04
      colorscale = 'Portland'
    }

    if (surfacecolor) {
      safeRestyle(gd, {
        surfacecolor: [surfacecolor],
        cmin: [cmin],
        cmax: [cmax],
        colorscale: [colorscale],
      }, [0])
    }
  }, [activeLayer, displayDiagnosticMatrix, initialDisplaySaturation, displayMaps, terrain])

  const resLabel = terrain?.dx != null
    ? `${Number(terrain.dx).toFixed(1)} × ${Number(terrain.dy ?? terrain.dx).toFixed(1)} m/cell`
    : '22.9 × 17.0 m/cell'

  const effectiveIntensity = (() => {
    if (rainfallMode === 'schedule' && Array.isArray(hourlyRainfall)) {
      const hourIdx = Math.min(23, Math.floor((telemetry?.elapsedTimeMin ?? 0) / 60))
      return hourlyRainfall[hourIdx] ?? 0
    }
    return rainfallMm
  })()

  const infoLabel = terrain
    ? `${terrain.width} × ${terrain.height} pts  |  Rain: ${effectiveIntensity} mm/hr  |  T: ${telemetry?.elapsedTimeMin ?? 0}m  |  Res: ${resLabel}`
    : 'loading…'

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Viewport Toolbar */}
      <div className="viz-toolbar" role="toolbar" aria-label="Model 2 controls">
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

        {/* Diagnostic Layer Selector */}
        <span className="viz-toolbar-label" style={{ color: '#00d4ff' }}>Layer:</span>
        <button
          id="btn-layer-moisture"
          className={`viz-btn${activeLayer === 'moisture' ? ' active' : ''}`}
          onClick={() => setActiveLayer('moisture')}
          title="Soil Water Saturation (Gradual Blue -> Red Critical at >= 95%)"
        >
          💧 Soil Saturation
        </button>
        <button
          id="btn-layer-slope"
          className={`viz-btn${activeLayer === 'slope' ? ' active' : ''}`}
          onClick={() => setActiveLayer('slope')}
          title="Topographic Slope Gradient (°)"
        >
          📐 Slope
        </button>
        <button
          id="btn-layer-aspect"
          className={`viz-btn${activeLayer === 'aspect' ? ' active' : ''}`}
          onClick={() => setActiveLayer('aspect')}
          title="Downslope Aspect / Azimuth (0–360°)"
        >
          🧭 Aspect
        </button>
        <button
          id="btn-layer-prof-curv"
          className={`viz-btn${activeLayer === 'profile_curv' ? ' active' : ''}`}
          onClick={() => setActiveLayer('profile_curv')}
          title="Profile Curvature (Curvature along slope direction)"
        >
          〰 Prof Curv
        </button>
        <button
          id="btn-layer-plan-curv"
          className={`viz-btn${activeLayer === 'plan_curv' ? ' active' : ''}`}
          onClick={() => setActiveLayer('plan_curv')}
          title="Plan Curvature (Across-slope convergence)"
        >
          ➿ Plan Curv
        </button>

        <span className="viz-toolbar-divider" />

        {/* Simulation Clock Controls */}
        <button
          id="btn-sim-play-pause"
          className={`viz-btn ${!isPaused ? 'active' : ''}`}
          onClick={togglePause}
          title={isPaused ? 'Resume time-dependent simulation' : 'Pause time-dependent simulation'}
          style={{ fontWeight: 800, color: isPaused ? '#ffaa00' : '#22c55e' }}
        >
          {isPaused ? '▶ PLAY' : '⏸ PAUSE'}
        </button>

        <button
          id="btn-sim-reset"
          className="viz-btn"
          onClick={handleReset}
          title="Reset simulation time and restore baseline soil water"
        >
          ↻ RESET
        </button>

        {/* Simulation Clock Readout */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'rgba(0, 212, 255, 0.08)',
          border: '1px solid rgba(0, 212, 255, 0.22)',
          borderRadius: 3,
          padding: '2px 7px',
          fontSize: '0.52rem',
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          <span style={{ color: '#00d4ff' }}>⏱️ T: {telemetry?.elapsedTimeMin ?? 0} min</span>
          <span style={{ color: '#4a6880' }}>|</span>
          <span style={{ color: '#38bdf8' }}>P_tot: {telemetry?.accumulatedRainfallMm != null ? telemetry.accumulatedRainfallMm.toFixed(1) : '0.0'} mm</span>
          <span style={{ color: '#4a6880' }}>|</span>
          <span style={{ color: (telemetry?.criticalCells ?? 0) > 0 ? '#ef4444' : '#22c55e' }}>
            Crit: {telemetry?.criticalCells ?? 0}
          </span>
        </div>

        <span className="viz-toolbar-divider" />

        <button
          id="btn-toggle-rain-anim"
          className={`viz-btn${showRainParticles ? ' active' : ''}`}
          onClick={toggleRainParticles}
          title={showRainParticles ? 'Disable atmospheric rain visualization' : 'Enable atmospheric rain visualization'}
        >
          {showRainParticles ? '🌧️ Rain: ON' : '☁️ Rain: OFF'}
        </button>
        <button
          id="btn-toggle-tooltip"
          className={`viz-btn${showTooltip ? ' active' : ''}`}
          onClick={() => {
            const next = !showTooltip
            setShowTooltip(next)
            const gd = graphDivRef.current
            if (gd && window.Plotly) {
              safeRestyle(gd, {
                hoverinfo: [next ? 'all' : 'none'],
              }, [0])
            }
          }}
          title={showTooltip ? 'Hide 3D hover tooltip on terrain' : 'Show 3D hover tooltip on terrain'}
        >
          {showTooltip ? '🎯 Tooltip: ON' : '🎯 Tooltip: OFF'}
        </button>
        <button
          id="btn-toggle-hud"
          className={`viz-btn${showHUD ? ' active' : ''}`}
          onClick={() => setShowHUD((h) => !h)}
          title={showHUD ? 'Hide overlay panels' : 'Show overlay panels'}
        >
          {showHUD ? '👁️ HUD: ON' : '👁️ HUD: OFF'}
        </button>

        {showHUD && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 4px', fontSize: '0.48rem', color: '#8ab4cc' }}>
            <span>HUD Opacity:</span>
            <input
              type="range"
              min="10"
              max="100"
              value={hudOpacity}
              onChange={(e) => setHudOpacity(Number(e.target.value))}
              style={{ width: 55, height: 4, accentColor: '#00d4ff', cursor: 'pointer' }}
              title="Adjust HUD overlay opacity"
            />
            <span style={{ minWidth: 24, fontFamily: 'monospace' }}>{hudOpacity}%</span>
          </div>
        )}

        <span className="viz-toolbar-spacer" />
        <span className="viz-coord">{infoLabel}</span>
      </div>

      {status === 'loading' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, background: PLOT_BG, color: '#4a6880' }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', border: '2px solid rgba(0,212,255,0.15)', borderTop: '2px solid #00d4ff', animation: 'spin 1s linear infinite' }} />
          <p style={{ fontSize: '0.7rem', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Initializing Time-Dependent LiDAR Hydrology & Soil Profile…</p>
        </div>
      )}

      {status === 'error' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: PLOT_BG }}>
          <p style={{ fontSize: '0.8rem', color: '#ff3355' }}>⚠ Failed to load data: {errMsg}</p>
        </div>
      )}

      {status === 'ready' && (
        <div
          className="plotly-wrap"
          ref={containerRef}
          onPointerDown={() => { isMouseDownRef.current = true }}
        >
          <div
            ref={graphDivRef}
            id="rain-soil-plotly-canvas"
            style={{ width: '100%', height: '100%' }}
          />

          {/* Top-Left Overlays: Soil Saturation Legend + Terrain & Soil Inspector + Physics Panel */}
          {showHUD && (
          <div
            style={{
              position: 'absolute',
              top: 12,
              left: 12,
              zIndex: 10,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              pointerEvents: 'none',
              maxWidth: 'calc(100% - 180px)',
              flexWrap: 'wrap',
              opacity: hudOpacity / 100,
              transition: 'opacity 0.15s ease',
            }}
          >
            {/* Model 2 Saturation Legend */}
            {LAYER_LEGENDS[activeLayer] && (
              <div
                className="sm-legend-overlay"
                style={{
                  position: 'relative',
                  top: 'auto',
                  left: 'auto',
                  pointerEvents: 'auto',
                  flexShrink: 0,
                  width: 162,
                  minWidth: 162,
                }}
                aria-label={`${LAYER_LEGENDS[activeLayer].title} colour legend`}
              >
                <div className="sm-legend-header">
                  <span className="sm-legend-icon">{LAYER_LEGENDS[activeLayer].icon}</span>
                  <span>{LAYER_LEGENDS[activeLayer].title}</span>
                </div>

                <div className="sm-legend-scale-wrap" style={{ height: 148 }}>
                  <div
                    style={{
                      width: 14,
                      borderRadius: 3,
                      flexShrink: 0,
                      background: LAYER_LEGENDS[activeLayer].gradient,
                      border: '1px solid rgba(0, 240, 255, 0.25)',
                      boxShadow: '0 0 8px rgba(0, 240, 255, 0.2)',
                    }}
                  />
                  <div className="sm-legend-ticks">
                    {LAYER_LEGENDS[activeLayer].ticks.map(({ pct, label, color }) => (
                      <div key={pct} className="sm-legend-tick" style={{ bottom: `${pct * 100}%` }}>
                        <span className="sm-tick-line" />
                        <span className="sm-tick-label" style={color ? { color } : undefined}>{label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="sm-legend-footer">
                  <span className="sm-footer-note">{LAYER_LEGENDS[activeLayer].note}</span>
                  <span className="sm-footer-range">{LAYER_LEGENDS[activeLayer].range}</span>
                </div>
              </div>
            )}

            {/* Terrain & Soil Saturation Inspector */}
            <div
              style={{
                position: 'relative',
                background: 'rgba(6, 14, 26, 0.92)',
                backdropFilter: 'blur(10px)',
                border: '1px solid rgba(0, 212, 255, 0.28)',
                borderRadius: 6,
                padding: '8px 12px',
                minWidth: 220,
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                pointerEvents: 'auto',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ fontSize: 12 }}>⛰️</span>
                  <span style={{ fontSize: '0.62rem', fontWeight: 800, color: '#00d4ff', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    TERRAIN & SOIL STATE
                  </span>
                </div>
                <span style={{
                  fontSize: '0.48rem',
                  fontWeight: 700,
                  color: hoveredCell ? '#22c55e' : '#8ab4cc',
                  background: hoveredCell ? 'rgba(34, 197, 94, 0.15)' : 'rgba(255,255,255,0.06)',
                  border: hoveredCell ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 3,
                  padding: '1px 4px',
                }}>
                  {hoveredCell ? `CELL (${hoveredCell.x}, ${hoveredCell.y})` : 'REGIONAL MEAN'}
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 8px', fontSize: '0.54rem' }}>
                <div>
                  <div style={{ color: '#8ab4cc', fontSize: '0.48rem', textTransform: 'uppercase' }}>Slope</div>
                  <strong style={{ color: '#00f0ff', fontFamily: 'JetBrains Mono, monospace' }}>
                    {hoveredCell?.slope != null ? `${hoveredCell.slope.toFixed(1)}°` : `${terrainHydrology?.stats?.meanSlope ?? '…'}°`}
                  </strong>
                </div>
                <div>
                  <div style={{ color: '#8ab4cc', fontSize: '0.48rem', textTransform: 'uppercase' }}>Aspect</div>
                  <strong style={{ color: '#00f0ff', fontFamily: 'JetBrains Mono, monospace' }}>
                    {hoveredCell?.aspect != null
                      ? `${hoveredCell.aspect.toFixed(0)}° (${getCompassDirection(hoveredCell.aspect)})`
                      : `${terrainHydrology?.stats?.meanAspect ?? '…'}° (${terrainHydrology?.stats?.meanAspectCompass ?? ''})`}
                  </strong>
                </div>
                <div>
                  <div style={{ color: '#8ab4cc', fontSize: '0.48rem', textTransform: 'uppercase' }}>Soil Saturation</div>
                  <strong style={{
                    color: hoveredCell?.isCritical ? '#ef4444' : hoveredCell?.saturation >= 0.90 ? '#f59e0b' : '#38bdf8',
                    fontFamily: 'JetBrains Mono, monospace',
                  }}>
                    {hoveredCell?.saturation != null
                      ? `${(hoveredCell.saturation * 100).toFixed(1)}%`
                      : `${telemetry?.meanSaturationPct != null ? telemetry.meanSaturationPct.toFixed(1) : 22}%`}
                  </strong>
                </div>
                <div>
                  <div style={{ color: '#8ab4cc', fontSize: '0.48rem', textTransform: 'uppercase' }}>Water Stored</div>
                  <strong style={{ color: '#7dd3fc', fontFamily: 'JetBrains Mono, monospace' }}>
                    {hoveredCell?.storageMm != null
                      ? `${hoveredCell.storageMm.toFixed(1)} mm`
                      : `${(((telemetry?.meanSaturationPct ?? 22) / 100) * STANDARD_SOIL_PROFILE.maxStorageMm).toFixed(1)} mm`}
                  </strong>
                </div>
              </div>

              <div style={{ fontSize: '0.44rem', color: '#4a6880', marginTop: 5, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 4 }}>
                {hoveredCell
                  ? `Elev: ${hoveredCell.z != null ? hoveredCell.z.toFixed(1) : '—'}m | Status: ${hoveredCell.isCritical ? '⚠️ CRITICAL SATURATION (RED)' : hoveredCell.saturation >= 0.90 ? '⚠️ NEAR SATURATION (ORANGE)' : 'Normal Soil Water'}`
                  : 'Hover over 3D terrain to inspect local saturation & storage'}
              </div>
            </div>

            {/* Physics & Assumptions Panel Overlay */}
            <div
              style={{
                position: 'relative',
                background: 'rgba(6, 14, 26, 0.92)',
                backdropFilter: 'blur(10px)',
                border: '1px solid rgba(0, 212, 255, 0.30)',
                borderRadius: 6,
                padding: showPhysicsPanel ? '8px 12px' : '5px 8px',
                maxWidth: 325,
                boxShadow: '0 4px 20px rgba(0,0,0,0.6), 0 0 12px rgba(0, 212, 255, 0.12)',
                pointerEvents: 'auto',
                transition: 'all 0.2s ease',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: showPhysicsPanel ? 6 : 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13 }}>⚙️</span>
                  <span style={{ fontSize: '0.62rem', fontWeight: 800, color: '#00d4ff', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    MODEL ASSUMPTIONS & PHYSICS
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    fontSize: '0.46rem',
                    fontWeight: 800,
                    letterSpacing: '0.06em',
                    color: '#00e5ff',
                    background: 'rgba(0, 229, 255, 0.15)',
                    border: '1px solid rgba(0, 229, 255, 0.4)',
                    borderRadius: 3,
                    padding: '2px 5px',
                  }}>
                    TIME ENGINE
                  </span>
                  <button
                    onClick={() => setShowPhysicsPanel((prev) => !prev)}
                    title={showPhysicsPanel ? 'Collapse Physics Panel' : 'Expand Physics Panel'}
                    style={{
                      background: 'rgba(0,212,255,0.1)',
                      border: '1px solid rgba(0,212,255,0.3)',
                      color: '#00d4ff',
                      borderRadius: 3,
                      cursor: 'pointer',
                      fontSize: '0.60rem',
                      padding: '1px 5px',
                      lineHeight: '1',
                    }}
                  >
                    {showPhysicsPanel ? '▲' : '▼'}
                  </button>
                </div>
              </div>

              {showPhysicsPanel && (
                <>
                  <div style={{ fontSize: '0.50rem', color: '#8ab4cc', lineHeight: '1.4', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ color: '#22c55e' }}>✓</span> <span><strong>Soil Profile:</strong> Standard Reference (Prototype Assumption)</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ color: '#22c55e' }}>✓</span> <span><strong>Soil Thickness:</strong> 1.0 m (Prototype Assumption)</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ color: '#22c55e' }}>✓</span> <span><strong>Storage:</strong> S_max = 450 mm (Porosity 45%, K_sat = 22 mm/hr)</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ color: '#22c55e' }}>✓</span> <span><strong>Accumulated Rain:</strong> P_total = Intensity × Elapsed Time</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ color: '#22c55e' }}>✓</span> <span><strong>Dynamic Infiltration:</strong> Constrained by K_sat & available pore space</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ color: '#22c55e' }}>✓</span> <span><strong>D8 Routing:</strong> Saturated excess water flows strictly downhill</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ color: '#ef4444' }}>●</span> <span><strong>Critical Saturation:</strong> ≥ 95% threshold transitions to RED</span>
                    </div>
                  </div>

                  {/* Summary Metric Badges */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                    <div style={{ background: 'rgba(0,212,255,0.06)', borderRadius: 3, padding: '3px 4px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.44rem', color: '#4a6880' }}>S_MAX</div>
                      <div style={{ fontSize: '0.55rem', fontWeight: 700, color: '#00f0ff' }}>
                        450 mm
                      </div>
                    </div>
                    <div style={{ background: 'rgba(0,212,255,0.06)', borderRadius: 3, padding: '3px 4px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.44rem', color: '#4a6880' }}>K_SAT</div>
                      <div style={{ fontSize: '0.55rem', fontWeight: 700, color: '#00f0ff' }}>
                        22 mm/h
                      </div>
                    </div>
                    <div style={{ background: 'rgba(0,212,255,0.06)', borderRadius: 3, padding: '3px 4px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.44rem', color: '#4a6880' }}>TIME STEP</div>
                      <div style={{ fontSize: '0.55rem', fontWeight: 700, color: '#7dd3fc' }}>
                        5 min
                      </div>
                    </div>
                    <div style={{ background: 'rgba(0,212,255,0.06)', borderRadius: 3, padding: '3px 4px', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.44rem', color: '#4a6880' }}>THRESHOLD</div>
                      <div style={{ fontSize: '0.55rem', fontWeight: 700, color: '#ef4444' }}>
                        95%
                      </div>
                    </div>
                  </div>

                  <div style={{ fontSize: '0.44rem', color: '#4a6880', marginTop: 5, fontStyle: 'italic' }}>
                    * High soil saturation indicates elevated pore-water condition; it does not constitute an automatic landslide prediction.
                  </div>
                </>
              )}
            </div>
          </div>
          )}

          {/* Real-time Atmospheric Rainfall Animation over 3D terrain */}
          <RainFlowOverlay
            rainfallMm={rainfallMm}
            isPaused={isPaused}
            enabled={showRainParticles}
          />

          {/* D8 Stream Flow Canvas — animated particles along drainage network */}
          {activeLayer === 'moisture' && terrainHydrology && (
            <StreamFlowCanvas
              hydroStatic={terrainHydrology}
              rainfallMm={rainfallMm}
              accumulatedRainMm={telemetry?.accumulatedRainfallMm ?? 0}
              isPaused={isPaused}
              visible={showHUD && rainfallMm > 0}
              containerRef={containerRef}
            />
          )}
        </div>
      )}
    </div>
  )
}
