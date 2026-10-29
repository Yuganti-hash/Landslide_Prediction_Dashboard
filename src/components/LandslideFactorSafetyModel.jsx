import React, { useEffect, useMemo, useRef, useState } from 'react'
import RainFlowOverlay from './RainFlowOverlay'
import { MODEL3_FOS_COLORSCALE, getFoSContinuousColor } from '../services/terrainVizModes'
import { buildTerrainDerivatives } from '../services/terrainDerivatives'
import {
  NORTH_INDIAN_ALLUVIAL_LOAM_PROFILE,
  calculatePorePressure,
  getPorePressureState,
  classifyFactorOfSafety,
  calculateFoSMatrix,
  downsampleFoSTo2D,
  validateFoSResults,
} from '../services/factorOfSafetyEngine'
import {
  buildDisplayIndexMaps,
  downsampleElevation2D,
  initializeSoilWaterState,
  stepSoilWaterSimulation,
  buildSoilThicknessFlat,
  STANDARD_SOIL_PROFILE,
} from '../services/soilSaturationSimulation'

// ── Camera presets ────────────────────────────────────────────────────────────
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

// Soil profile used for this component (single source of truth)
const SOIL = NORTH_INDIAN_ALLUVIAL_LOAM_PROFILE



/**
 * MODEL 4 — PHYSICS-BASED LANDSLIDE FACTOR OF SAFETY ENGINE
 *
 * Scientific Model:  Infinite-Slope Theory
 * Soil Profile:      North Indian Alluvial Loam (Reference)
 * Pore Pressure:     Prototype saturation-based approximation (u = γw × S × z)
 * Slope Input:       LiDAR DEM via buildTerrainDerivatives() (EPSG:26912 verified)
 * Saturation Input:  Model 2 saturationRatio Float32Array (passed via props)
 *
 * FoS Equation:
 *   FoS = [c' + (γz·cos²θ − u)·tanφ'] / [γz·sinθ·cosθ]
 *
 * FoS ≤ 1.0 indicates theoretical limit-equilibrium (potential instability).
 * It does NOT confirm that a landslide has occurred.
 *
 * ── RENDERING ARCHITECTURE ───────────────────────────────────────────────────
 * Plotly is managed FULLY IMPERATIVELY (no <Plot> React component rendered):
 *   • window.Plotly?.newPlot()  — called ONCE when elevation geometry is ready
 *   • window.Plotly?.restyle()  — used for ALL color updates (never resets camera)
 *   • window.Plotly?.relayout() — used only for camera-preset button clicks
 *
 * Two Plotly surface traces:
 *   [0] FoS surface  — surfacecolor = normalised FoS matrix, MODEL3_FOS_COLORSCALE
 *   [1] Sat warning  — surfacecolor = raw saturation matrix, SAT_WARNING_COLORSCALE
 *                      visible only when maxSat ≥ 95 %
 */
export default function LandslideFactorSafetyModel({
  saturationRatio,          // Float32Array from Model 2 (872×589), can be null
  saturationRatioRef,       // Ref to live Float32Array from Model 2 (avoids re-rendering parent)
  rainfallMm = 50,          // Dynamic rainfall intensity from Model 2 (read-only)
  hydrologyStats = null,    // Dynamic simulation stats from Model 2 (read-only)
  isPaused = false,         // Simulation pause status from Model 2
  resetCounter = 0,         // Reset trigger counter
  showRainParticles = true, // Whether rain overlay is enabled
  onToggleRainParticles,    // Toggle rain particles
  onFoSStatsChange,         // Callback to send stats to RightPanel
}) {
  // ── Refs ──────────────────────────────────────────────────────────────────
  const graphDivRef        = useRef(null)   // raw DOM element for Plotly
  const containerRef       = useRef(null)   // outer plotly-wrap div for ResizeObserver
  const cameraRef          = useRef(CAMERAS['3d'])
  const plotInitialized    = useRef(false)
  const hoverHandlerRef    = useRef(null)   // stable ref → avoids stale closure in event listener
  const clickHandlerRef    = useRef(null)
  const relayoutHandlerRef = useRef(null)
  const isMouseDownRef     = useRef(false)
  const hoverThrottleRef   = useRef(null)
  const cursorPosRef       = useRef({ x: 0, y: 0 })  // tracks latest cursor position on canvas

  // ── State ─────────────────────────────────────────────────────────────────
  const [activeView, setActiveView]         = useState('3d')
  const [status, setStatus]                 = useState('loading')
  const [errMsg, setErrMsg]                 = useState('')
  const [showHUD, setShowHUD]               = useState(true)
  const [showTooltip, setShowTooltip]       = useState(true)
  const [hudOpacity, setHudOpacity]         = useState(100)
  const [showAssumptions, setShowAssumptions] = useState(false)
  const [hoveredCell, setHoveredCell]       = useState(null)
  const [selectedCoord, setSelectedCoord]   = useState(null)
  const [terrain, setTerrain]               = useState(null)

  const safeRestyle = (gd, update, indices = [0]) => {
    try {
      if (gd && window.Plotly && plotInitialized.current && Array.isArray(gd.data) && gd.data.length > 0) {
        window.Plotly.restyle(gd, update, indices)
      }
    } catch {
      // ignore
    }
  }

  // ── Explicit unmount cleanup for memory stability & WebGL context disposal ─
  useEffect(() => {
    return () => {
      if (hoverThrottleRef.current) clearTimeout(hoverThrottleRef.current)
      const gd = graphDivRef.current
      if (gd && window.Plotly) {
        try {
          window.Plotly.purge(gd)
        } catch {
          // ignore
        }
      }
      plotInitialized.current = false
      graphDivRef.current = null
    }
  }, [])

  // ── 1. Fetch LiDAR DEM with AbortController ──────────────────────────────
  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')

    fetch('/terrain_web.json', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`terrain_web.json: HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (!data.elevation || !Array.isArray(data.elevation)) {
          throw new Error('terrain_web.json missing elevation matrix')
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
      controller.abort()
    }
  }, [])

  // ── 2. Terrain derivatives (slope matrix) ────────────────────────────────
  const terrainHydrology = useMemo(() => {
    if (!terrain) return null
    return buildTerrainDerivatives(terrain)
  }, [terrain])

  // ── 3. Display index maps (3× downsampling) ───────────────────────────────
  const displayMaps = useMemo(() => {
    if (!terrain?.width || !terrain?.height) return null
    return buildDisplayIndexMaps(terrain.width, terrain.height, 3)
  }, [terrain?.width, terrain?.height])

  // ── 4. Static elevation geometry (created once) ───────────────────────────
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

  // ── 4b. Soil Column Thickness Field (Model 3 integration) ────────────────
  const soilThicknessFlat = useMemo(() => {
    if (!terrainHydrology?.derivatives || !terrainHydrology?.elevFlat) return null
    return buildSoilThicknessFlat(terrainHydrology.derivatives, terrainHydrology.elevFlat)
  }, [terrainHydrology])

  // ── 4c. Dynamic Soil Saturation State (Driven by rainfall intensity) ───────
  const simStateRef = useRef(null)
  const [internalSat, setInternalSat] = useState(null)
  const [simTimeMin, setSimTimeMin] = useState(0)

  // Initialize or reset soil water state at t = 0
  useEffect(() => {
    if (terrain && terrainHydrology) {
      const initial = initializeSoilWaterState(terrain, null, terrainHydrology, STANDARD_SOIL_PROFILE)
      simStateRef.current = initial
      setInternalSat(initial.saturationRatio)
      setSimTimeMin(0)
    }
  }, [terrain, terrainHydrology, resetCounter])

  // Active time progression clock when not paused (advances step by step)
  useEffect(() => {
    if (isPaused || !terrain || !terrainHydrology || !simStateRef.current) return
    const timer = setInterval(() => {
      if (!simStateRef.current) return
      const nextSim = stepSoilWaterSimulation(
        simStateRef.current,
        rainfallMm,
        5,
        terrain,
        terrainHydrology,
        STANDARD_SOIL_PROFILE
      )
      simStateRef.current = nextSim
      setInternalSat(nextSim.saturationRatio)
      setSimTimeMin((t) => t + 5)
    }, 1000)
    return () => clearInterval(timer)
  }, [isPaused, rainfallMm, terrain, terrainHydrology])

  // Resolve current saturation array (from ref or internal simulation)
  const currentSatRatio = saturationRatioRef?.current ?? internalSat

  // ── 5. FoS matrix (physics engine) ───────────────────────────────────────
  // Always computed — this component is only mounted when the FoS tab is active.
  const fosResult = useMemo(() => {
    if (!terrainHydrology) return null
    const { slopeMatrix, width, height } = terrainHydrology
    const satFlat = currentSatRatio ?? new Float32Array(width * height).fill(0)
    return calculateFoSMatrix(slopeMatrix, satFlat, width, height, SOIL, soilThicknessFlat)
  }, [terrainHydrology, currentSatRatio, soilThicknessFlat])

  // ── 6. Downsampled FoS colour matrix (Trace 0) ───────────────────────────
  const displayFoSMatrix = useMemo(() => {
    if (!fosResult?.fosMatrix || !displayMaps || !terrain) return null
    return downsampleFoSTo2D(
      fosResult.fosMatrix,
      terrain.width,
      terrain.height,
      displayMaps.rowMap,
      displayMaps.colMap
    )
  }, [fosResult, displayMaps, terrain])

  // ── 8. Critical-saturation statistics (independent of FoS) ───────────────
  const criticalSatStats = useMemo(() => {
    if (!currentSatRatio) return { hasCritical: false, criticalCount: 0 }
    let criticalCount = 0
    for (let i = 0; i < currentSatRatio.length; i++) {
      if (currentSatRatio[i] >= 0.95) criticalCount++
    }
    return { hasCritical: criticalCount > 0, criticalCount }
  }, [currentSatRatio])

  // ── Derived hydrology stats (read-only from Model 2) ─────────────────────
  const elapsedTimeMin = hydrologyStats?.elapsedTimeMin ?? simTimeMin

  const meanSatPct = hydrologyStats?.meanSaturationPct != null
    ? Number(hydrologyStats.meanSaturationPct.toFixed(1))
    : (() => {
        if (!currentSatRatio) return 0
        let sum = 0; let n = 0
        for (let i = 0; i < currentSatRatio.length; i++) {
          const s = currentSatRatio[i]; if (s >= 0) { sum += s; n++ }
        }
        return n > 0 ? Number(((sum / n) * 100).toFixed(1)) : 0
      })()

  const maxSatPct = hydrologyStats?.maxSaturationPct != null
    ? Number(hydrologyStats.maxSaturationPct.toFixed(1))
    : (() => {
        if (!currentSatRatio) return 0
        let max = 0
        for (let i = 0; i < currentSatRatio.length; i++) {
          if (currentSatRatio[i] > max) max = currentSatRatio[i]
        }
        return Number((max * 100).toFixed(1))
      })()

  // ── 9. Publish stats to RightPanel ───────────────────────────────────────
  useEffect(() => {
    if (!fosResult?.stats || !terrainHydrology || !onFoSStatsChange) return
    const { stats } = fosResult
    const avgState = getPorePressureState(meanSatPct / 100, SOIL.soilDepth, SOIL)
    onFoSStatsChange({
      ...stats,
      meanSatPct,
      maxSatPct,
      rainfallMm,
      elapsedTimeMin,
      soilName:      SOIL.name,
      soilDepth:     SOIL.soilDepth,
      cohesion:      SOIL.cohesion_c_kPa,
      frictionAngle: SOIL.frictionAngle_phi_deg,
      unitWeight:    SOIL.unitWeight_gamma_kN_m3,
      meanSlope:     terrainHydrology.stats.meanSlope,
      alpha:         SOIL.alpha,
      n:             SOIL.n,
      m:             SOIL.m,
      theta_s:       SOIL.theta_s,
      theta_r:       SOIL.theta_r,
      avgPorePressure:   avgState.porePressure,
      avgPressureHead:   avgState.pressureHead,
      avgMatricPressure: avgState.matricPressure,
      avgMatricSuction:  avgState.matricSuction,
      avgWaterContent:   avgState.waterContent,
    })
  }, [fosResult, meanSatPct, maxSatPct, rainfallMm, elapsedTimeMin, terrainHydrology, onFoSStatsChange])

  // ── 10. Validate FoS (development diagnostics) ───────────────────────────
  useEffect(() => {
    if (!fosResult?.fosMatrix || !terrainHydrology) return
    validateFoSResults(
      fosResult.fosMatrix,
      terrainHydrology.slopeMatrix,
      currentSatRatio,
      terrain?.width ?? 872,
      terrain?.height ?? 589,
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!fosResult])

  // ── Layout builder ────────────────────────────────────────────────────────
  const buildLayout = (terrainData) => ({
    paper_bgcolor: PAPER_BG,
    plot_bgcolor:  PLOT_BG,
    margin:        { l: 0, r: 0, t: 0, b: 0 },
    autosize:      true,
    // Stable uirevision → Plotly preserves camera / zoom across ANY restyle call
    uirevision: 'model4-fos-stable-camera',
    scene: {
      bgcolor:    PLOT_BG,
      uirevision: 'model4-fos-stable-camera',
      // Explicitly set dragmode so Plotly initialises its camera matrix correctly
      // 'turntable' = standard orbit: left-drag rotates, right-drag pans, scroll zooms
      dragmode: 'turntable',
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
      camera:      cameraRef.current,
      aspectmode:  'manual',
      aspectratio: { x: 1.45, y: 1.35, z: 0.68 },
    },
  })

  const plotConfig = {
    responsive:   true,
    displayModeBar: false,
    displaylogo:  false,
    scrollZoom:   true,   // Ensure scroll-zoom stays active even without mode bar
    staticPlot:   false,  // Drag interaction must remain enabled
  }

  // ── Hover & Click inspection ──────────────────────────────────────────────
  const handlePlotlyHover = (eventData) => {
    if (isMouseDownRef.current) return
    if (hoverThrottleRef.current) return
    hoverThrottleRef.current = setTimeout(() => { hoverThrottleRef.current = null }, 60)

    const pt = eventData?.points?.[0]
    if (!pt || pt.x == null || pt.y == null || (pt.curveNumber ?? 0) !== 0) return
    if (!terrain || !terrainHydrology || !fosResult) return

    const c   = Math.max(0, Math.min(terrain.width  - 1, Math.round(pt.x)))
    const r   = Math.max(0, Math.min(terrain.height - 1, Math.round(pt.y)))
    const idx = r * terrain.width + c

    const slopeDeg = terrainHydrology.slopeMatrix[idx] ?? 0
    const satRaw   = currentSatRatio?.[idx] ?? 0
    const sat      = Math.max(0, Math.min(1, satRaw))
    const pState   = getPorePressureState(sat, SOIL.soilDepth, SOIL)
    const fos      = fosResult.fosMatrix[idx]
    const classification = classifyFactorOfSafety(fos < 0 ? null : (fos === 0 ? 99.0 : fos))

    setHoveredCell({
      x: c, y: r,
      elevation: pt.z,
      slopeDeg,
      saturation: sat,
      effectiveSaturation: pState.effectiveSaturation,
      waterContent: pState.waterContent,
      pressureHead: pState.pressureHead,
      porePressure: pState.porePressure,
      matricPressure: pState.matricPressure,
      matricSuction: pState.matricSuction,
      positivePorePressure: pState.positivePorePressure,
      fos:            fos < 0 ? null : (fos === 0 ? 99.0 : fos),
      classification,
      isCriticalSat:  sat >= 0.95,
    })
  }

  const handlePlotlyClick = (eventData) => {
    const pt = eventData?.points?.[0]
    if (!pt || pt.x == null || pt.y == null || (pt.curveNumber ?? 0) !== 0) return
    if (!terrain) return
    const c = Math.max(0, Math.min(terrain.width  - 1, Math.round(pt.x)))
    const r = Math.max(0, Math.min(terrain.height - 1, Math.round(pt.y)))
    setSelectedCoord({ x: c, y: r, elevation: pt.z })
  }

  // Always point refs to the latest closures (avoids stale-closure in Plotly event listeners)
  hoverHandlerRef.current    = handlePlotlyHover
  clickHandlerRef.current    = handlePlotlyClick
  relayoutHandlerRef.current = (eventData) => {
    if (eventData?.['scene.camera']) cameraRef.current = eventData['scene.camera']
  }

  // ── Selected cell pinned state (dynamically updates in real-time when Model 2 saturation changes) ─
  const selectedCell = useMemo(() => {
    if (!selectedCoord || !terrain || !terrainHydrology || !fosResult) return null
    const c = Math.max(0, Math.min(terrain.width - 1, selectedCoord.x))
    const r = Math.max(0, Math.min(terrain.height - 1, selectedCoord.y))
    const idx = r * terrain.width + c

    const slopeDeg = terrainHydrology.slopeMatrix[idx] ?? 0
    const satRaw   = currentSatRatio?.[idx] ?? 0
    const sat      = Math.max(0, Math.min(1, satRaw))
    const pState   = getPorePressureState(sat, SOIL.soilDepth, SOIL)
    const fos      = fosResult.fosMatrix[idx]
    const classification = classifyFactorOfSafety(fos < 0 ? null : (fos === 0 ? 99.0 : fos))

    return {
      x: c, y: r,
      elevation: terrain.elevation?.[r]?.[c] ?? selectedCoord.elevation ?? 0,
      slopeDeg,
      saturation: sat,
      effectiveSaturation: pState.effectiveSaturation,
      waterContent: pState.waterContent,
      pressureHead: pState.pressureHead,
      porePressure: pState.porePressure,
      matricPressure: pState.matricPressure,
      matricSuction: pState.matricSuction,
      positivePorePressure: pState.positivePorePressure,
      fos: fos < 0 ? null : (fos === 0 ? 99.0 : fos),
      classification,
      isCriticalSat: sat >= 0.95,
      isPinned: true,
    }
  }, [selectedCoord, terrain, terrainHydrology, fosResult, currentSatRatio])

  const inspectedCell = hoveredCell || selectedCell

  // ── Global pointerup listener (ensures isMouseDownRef resets even if mouse released outside canvas)
  useEffect(() => {
    const handlePointerUp = () => { isMouseDownRef.current = false }
    window.addEventListener('pointerup', handlePointerUp)
    return () => window.removeEventListener('pointerup', handlePointerUp)
  }, [])

  // ── 11. Initialize Plotly ONCE with newPlot() ─────────────────────────────
  // Initialized directly with FoS colour matrix. All subsequent data updates
  // use restyle() → camera, zoom, and orientation are NEVER disturbed.
  useEffect(() => {
    if (!displayElevation || !displayX || !displayY || !terrain || !displayFoSMatrix) return
    const gd = graphDivRef.current
    if (!gd || plotInitialized.current) return

    // Track component mount so cleanup can abort async callbacks
    let mounted = true

    // Trace 0: FoS surface — starts directly with computed per-cell FoS numeric matrix
    const fosSurface = {
      type:        'surface',
      x:           displayX,
      y:           displayY,
      z:           displayElevation,
      surfacecolor: displayFoSMatrix,
      cmin: 0.80,
      cmax: 6.00,
      colorscale:  MODEL3_FOS_COLORSCALE,
      showscale:   false,
      hoverinfo:   showTooltip ? 'all' : 'none',
      hovertemplate: showTooltip ? (
        '<b>Elevation:</b> %{z:.1f} m ASL<br>' +
        '<b>Grid:</b> (%{x}, %{y})<br>' +
        '<b>Cell FoS:</b> %{surfacecolor:.2f}<br>' +
        '<extra>Model 4 · Factor of Safety</extra>'
      ) : '',
      contours:      { z: { show: false, usecolormap: false, project: { z: false } } },
      lighting:      { ambient: 0.58, diffuse: 0.82, roughness: 0.42, specular: 0.38, fresnel: 0.20 },
      lightposition: { x: 120, y: 220, z: 850 },
    }

    const plotPromise = window.Plotly?.newPlot(gd, [fosSurface], buildLayout(terrain), plotConfig)
    if (plotPromise && typeof plotPromise.then === 'function') {
      plotPromise.then(() => {
        if (!mounted) return  // Component unmounted before newPlot resolved — skip
        // ── Set plotInitialized ONLY after newPlot fully resolves ──
        // This prevents safeRestyle from firing before Plotly's internal drag
        // event handlers are bound, which would corrupt camera interaction.
        plotInitialized.current = true
        if (gd && displayFoSMatrix) {
          safeRestyle(gd, {
            surfacecolor: [displayFoSMatrix],
            cmin: [0.80],
            cmax: [6.00],
            colorscale: [MODEL3_FOS_COLORSCALE],
          }, [0])
        }
      }).catch(() => {})
    } else {
      // Synchronous newPlot (older Plotly) — safe to set immediately
      plotInitialized.current = true
    }

    // Attach events via Plotly's own event bus (ref pattern avoids stale closures)
    gd.on('plotly_hover',    (d) => hoverHandlerRef.current?.(d))
    gd.on('plotly_unhover',  () => setHoveredCell(null))
    gd.on('plotly_click',    (d) => clickHandlerRef.current?.(d))
    gd.on('plotly_relayout', (d) => relayoutHandlerRef.current?.(d))

    return () => {
      mounted = false  // Prevent async newPlot callback from setting plotInitialized
      if (gd && window.Plotly) window.Plotly.purge(gd)
      plotInitialized.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayElevation, displayX, displayY, terrain])

  // ── 12. Restyle Trace 0 with FoS colour matrix ────────────────────────────
  // restyle() never resets camera, pan, or zoom.
  useEffect(() => {
    const gd = graphDivRef.current
    if (!gd || !displayFoSMatrix || !plotInitialized.current) return
    safeRestyle(gd, {
      surfacecolor: [displayFoSMatrix],
      cmin: [0.80],
      cmax: [6.00],
      colorscale: [MODEL3_FOS_COLORSCALE],
    }, [0])
  }, [displayFoSMatrix])

  // ── 14. On mount: trigger canvas resize (model is always active when mounted) ──
  useEffect(() => {
    // Give Plotly time to finish newPlot before resizing
    const t = setTimeout(() => {
      const gd = graphDivRef.current
      if (gd && window.Plotly && plotInitialized.current) window.Plotly?.Plots?.resize(gd)
    }, 80)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 15. ResizeObserver ────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      const gd = graphDivRef.current
      if (gd && window.Plotly && plotInitialized.current) window.Plotly?.Plots?.resize(gd)
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  // ── 16. Cursor-Relative Scroll Zoom ──────────────────────────────────────
  //
  // Plotly's default scrollZoom for 3D scenes zooms toward the fixed scene
  // origin/center. This effect intercepts the wheel event and instead zooms
  // toward the point under the cursor, giving the natural "zoom to cursor"
  // behavior found in professional 3D viewers.
  //
  // How it works:
  //   1. Track cursor position with pointermove on the Plotly canvas.
  //   2. On wheel: compute normalised cursor offset from canvas center [-1, 1].
  //   3. Scale the camera eye vector (zoom in/out).
  //   4. Shift the camera center toward the cursor direction proportionally.
  //   5. Apply via Plotly.relayout (no FoS data touched).
  //
  useEffect(() => {
    const gd = graphDivRef.current
    if (!gd) return

    // Track mouse position relative to the canvas at all times
    const onPointerMove = (e) => {
      const rect = gd.getBoundingClientRect()
      cursorPosRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        w: rect.width,
        h: rect.height,
      }
    }

    // Track pointerdown to suppress hover during drag rotation
    const onPointerDown = () => { isMouseDownRef.current = true }

    const onWheel = (e) => {
      if (!plotInitialized.current) return

      // Stop Plotly's own scroll (which zooms toward origin)
      e.preventDefault()
      e.stopPropagation()

      const fullCam = gd._fullLayout?.scene?.camera || gd._fullLayout?.scene?._scene?.getCamera?.()
      const cam = fullCam || cameraRef.current || CAMERAS['3d']
      const eye = { ...(cam.eye ?? { x: 1.25, y: 1.25, z: 0.80 }) }
      const ctr = { ...(cam.center ?? { x: 0, y: 0, z: 0 }) }
      const up  = { ...(cam.up ?? { x: 0, y: 0, z: 1 }) }

      // Zoom factor: positive deltaY = scroll down = zoom out
      const zoomDir   = e.deltaY > 0 ? 1.0 : -1.0   // 1 = zoom out, -1 = zoom in
      const zoomSpeed = 0.12
      const zoomFactor = 1.0 + zoomDir * zoomSpeed

      // --- Cursor-relative offset: map canvas pixel to [-1, 1] ---
      const { x = 0, y = 0, w = 1, h = 1 } = cursorPosRef.current
      // Normalised offset from canvas center: (-1,-1) = top-left, (1,1) = bottom-right
      const nx = (x / w - 0.5) * 2   // horizontal: left(-1) … right(+1)
      const ny = (y / h - 0.5) * 2   // vertical:   top(-1) … bottom(+1)

      // --- Compute a shifted center that leans toward the cursor ---
      // The amount we shift the focal point scales with zoom step and cursor offset.
      // When cursor is at canvas center, shift is 0 (standard zoom).
      // When cursor is at edge, shift pans the focal point noticeably.
      const panStrength = 0.08 * zoomSpeed * Math.abs(1.0 - zoomFactor)
      const shiftX = nx * panStrength
      const shiftY = -ny * panStrength  // canvas Y is inverted relative to scene Y

      // --- Determine right and up vectors of the camera for panning ---
      // right vector = eye cross up (normalised)
      const eyeLen = Math.hypot(eye.x, eye.y, eye.z) || 1
      const eN = { x: eye.x / eyeLen, y: eye.y / eyeLen, z: eye.z / eyeLen }
      const right = {
        x: eN.y * up.z - eN.z * up.y,
        y: eN.z * up.x - eN.x * up.z,
        z: eN.x * up.y - eN.y * up.x,
      }
      const rLen = Math.hypot(right.x, right.y, right.z) || 1
      const rN = { x: right.x / rLen, y: right.y / rLen, z: right.z / rLen }

      // Pan the camera center in screen-right and screen-up directions
      const newCenter = {
        x: ctr.x + shiftX * rN.x + shiftY * up.x,
        y: ctr.y + shiftX * rN.y + shiftY * up.y,
        z: ctr.z + shiftX * rN.z + shiftY * up.z,
      }

      // --- Scale the eye toward/away from the new center ---
      // Eye relative to new center, then scale, then add back new center
      const relEye = {
        x: eye.x - newCenter.x,
        y: eye.y - newCenter.y,
        z: eye.z - newCenter.z,
      }

      // Clamp zoom: prevent flying through the surface or zooming too far out
      const currentDist  = Math.hypot(relEye.x, relEye.y, relEye.z)
      const proposedDist = currentDist * zoomFactor
      const MIN_DIST     = 0.08
      const MAX_DIST     = 6.0
      const clampedScale = Math.max(MIN_DIST / currentDist, Math.min(MAX_DIST / currentDist, zoomFactor))

      const newEye = {
        x: newCenter.x + relEye.x * clampedScale,
        y: newCenter.y + relEye.y * clampedScale,
        z: newCenter.z + relEye.z * clampedScale,
      }

      const newCamera = { eye: newEye, center: newCenter, up }
      cameraRef.current = newCamera

      // Apply to Plotly without touching FoS data
      const gdEl = graphDivRef.current
      if (gdEl && window.Plotly) {
        window.Plotly.relayout(gdEl, { 'scene.camera': newCamera }).catch(() => {})
      }
    }

    // Attach with { passive: false } so preventDefault() works
    gd.addEventListener('pointerdown', onPointerDown, { passive: true })
    gd.addEventListener('pointermove', onPointerMove, { passive: true })
    gd.addEventListener('wheel',       onWheel,       { passive: false })

    return () => {
      gd.removeEventListener('pointerdown', onPointerDown)
      gd.removeEventListener('pointermove', onPointerMove)
      gd.removeEventListener('wheel',       onWheel)
    }
  // Runs once on mount; graphDivRef.current is stable after mount.
  // onWheel is guarded by plotInitialized.current internally.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyCamera = (viewKey) => {
    const cam = CAMERAS[viewKey] ?? CAMERAS.default
    cameraRef.current = cam
    setActiveView(viewKey)
    const gd = graphDivRef.current
    if (gd && window.Plotly) window.Plotly.relayout(gd, { 'scene.camera': cam })
  }

  // ── Derived display stats ─────────────────────────────────────────────────
  const stats      = fosResult?.stats ?? {}
  const avgFoS     = stats.meanFoS  != null ? stats.meanFoS.toFixed(2)  : '—'
  const minFoS     = stats.minFoS   != null ? stats.minFoS.toFixed(2)   : '—'
  const failCells  = stats.failureCount  ?? 0
  const riskCells  = stats.highRiskCount ?? 0
  const hasPotentialFailure = failCells > 0

  const avgSat = (() => {
    const arr = currentSatRatio ?? saturationRatio
    if (!arr) return 0
    let s = 0; let n = 0
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]; if (v >= 0) { s += v; n++ }
    }
    return n > 0 ? s / n : 0
  })()
  const avgPoreState = getPorePressureState(avgSat, SOIL.soilDepth, SOIL)
  const avgPorePressure = avgPoreState.porePressure

  const infoLabel = terrain
    ? `${terrain.width} × ${terrain.height} cells  |  FoS Model: Infinite-Slope  |  Res: ${terrain.dx?.toFixed(1)} × ${terrain.dy?.toFixed(1)} m/cell`
    : 'loading…'

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="viz-container" style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>


      {/* ── Visualizer Toolbar ────────────────────────────────────────────── */}
      <div className="viz-toolbar">
        <span className="viz-mode-badge" style={{ borderColor: '#f97316', color: '#f97316' }}>
          ⚖️ MODEL 4: INFINITE-SLOPE FoS
        </span>

        {/* Camera presets */}
        {['default', 'top', '3d'].map((key) => (
          <button
            key={key}
            type="button"
            className={`viz-btn ${activeView === key ? 'active' : ''}`}
            onClick={() => applyCamera(key)}
          >
            {key.toUpperCase()}
          </button>
        ))}

        {/* Reset Camera */}
        <button
          type="button"
          className="viz-btn"
          onClick={() => applyCamera('default')}
          title="Reset Camera"
        >
          RESET
        </button>

        {/* Rain overlay toggle */}
        <button
          type="button"
          className={`viz-btn ${showRainParticles ? 'active' : ''}`}
          onClick={onToggleRainParticles}
          title="Toggle Topographic Rainfall Overlay"
        >
          🌧️ RAIN: {showRainParticles ? 'ON' : 'OFF'}
        </button>

        {/* Tooltip toggle */}
        <button
          type="button"
          className={`viz-btn ${showTooltip ? 'active' : ''}`}
          onClick={() => setShowTooltip((t) => !t)}
          title="Toggle Hover Tooltips"
        >
          🎯 TOOLTIP: {showTooltip ? 'ON' : 'OFF'}
        </button>

        {/* HUD toggle */}
        <button
          type="button"
          className={`viz-btn ${showHUD ? 'active' : ''}`}
          onClick={() => setShowHUD((h) => !h)}
          title="Toggle HUD overlays"
        >
          👁️ HUD: {showHUD ? 'ON' : 'OFF'}
        </button>

        {/* HUD Opacity Slider */}
        {showHUD && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.65rem', color: '#8ab4cc', marginLeft: 8 }}>
            <span>Opacity:</span>
            <input
              type="range"
              min="20"
              max="100"
              value={hudOpacity}
              onChange={(e) => setHudOpacity(Number(e.target.value))}
              style={{ width: 60, accentColor: '#00d4ff', cursor: 'pointer' }}
              title="Adjust HUD overlay opacity"
            />
            <span style={{ minWidth: 24, fontFamily: 'monospace' }}>{hudOpacity}%</span>
          </div>
        )}

        <span className="viz-toolbar-spacer" />
        <span className="viz-coord">{infoLabel}</span>
      </div>

      {/* ── Loading ───────────────────────────────────────────────────────── */}
      {status === 'loading' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, background: PLOT_BG, color: '#4a6880' }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', border: '2px solid rgba(249,115,22,0.15)', borderTop: '2px solid #f97316', animation: 'spin 1s linear infinite' }} />
          <p style={{ fontSize: '0.7rem', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Initializing Factor of Safety Engine…</p>
        </div>
      )}

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {status === 'error' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: PLOT_BG }}>
          <p style={{ fontSize: '0.8rem', color: '#ff3355' }}>⚠ Failed to load terrain: {errMsg}</p>
        </div>
      )}

      {/* ── Ready — Imperative Plotly canvas ─────────────────────────────── */}
      {status === 'ready' && (
        <div
          className="plotly-wrap"
          ref={containerRef}
          onPointerDown={() => { isMouseDownRef.current = true }}
          onPointerUp={() => { isMouseDownRef.current = false }}
          onPointerLeave={() => { isMouseDownRef.current = false }}
        >
          {/* Raw div — window.Plotly?.newPlot() attaches here; NO <Plot> component rendered */}
          <div
            ref={graphDivRef}
            id="model4-plotly-canvas"
            style={{ width: '100%', height: '100%' }}
          />

          {/* ── HUD Overlays ─────────────────────────────────────────────── */}
          {showHUD && (
            <div style={{
              position: 'absolute', top: 12, left: 12, zIndex: 10,
              display: 'flex', alignItems: 'flex-start', gap: 10,
              pointerEvents: 'none', maxWidth: 'calc(100% - 180px)', flexWrap: 'wrap',
              opacity: hudOpacity / 100,
              transition: 'opacity 0.15s ease',
            }}>

              {/* ── FoS Legend ─────────────────────────────────────────── */}
              <div
                className="sm-legend-overlay"
                style={{ position: 'relative', top: 'auto', left: 'auto', pointerEvents: 'auto', flexShrink: 0, width: 176, minWidth: 176 }}
                aria-label="Factor of Safety colour legend"
              >
                <div className="sm-legend-header">
                  <span className="sm-legend-icon">⚖️</span>
                  <span>FACTOR OF SAFETY</span>
                </div>
                <div className="sm-legend-scale-wrap" style={{ height: 215 }}>
                  <div style={{
                    width: 14, borderRadius: 3, flexShrink: 0,
                    background: 'linear-gradient(to top, #B91C1C 0%, #EF4444 3.85%, #EA580C 8.65%, #F97316 15.38%, #EAB308 23.08%, #FFEB3B 30.77%, #A3E635 38.46%, #86EFAC 46.15%, #4ADE80 61.54%, #22C55E 76.92%, #16A34A 88.46%, #15803D 100%)',
                    border: '1px solid rgba(74,222,128,0.35)',
                    boxShadow: '0 0 10px rgba(34,197,94,0.25)',
                  }} />
                  <div className="sm-legend-ticks">
                    {[
                      { pct: 1.000, label: '≥ 6.00  MODERATELY DARK GREEN', color: '#15803d' },
                      { pct: 0.769, label: '4.80    MEDIUM GREEN',          color: '#22c55e' },
                      { pct: 0.615, label: '4.00    SOFT GREEN',            color: '#4ade80' },
                      { pct: 0.462, label: '3.20    LIGHT GREEN (BASE)',    color: '#86efac' },
                      { pct: 0.308, label: '2.40    LIGHT YELLOW',          color: '#ffeb3b' },
                      { pct: 0.231, label: '2.00    DARK YELLOW',           color: '#eab308' },
                      { pct: 0.154, label: '1.60    ORANGE',                color: '#f97316' },
                      { pct: 0.087, label: '1.25    DARK ORANGE',           color: '#ea580c' },
                      { pct: 0.038, label: '1.00    FoS LIMIT (CRITICAL)',  color: '#ef4444' },
                      { pct: 0.000, label: '< 1.00  POTENTIAL FAILURE',     color: '#b91c1c' },
                    ].map(({ pct, label, color }) => (
                      <div key={pct} className="sm-legend-tick" style={{ bottom: `${pct * 100}%` }}>
                        <span className="sm-tick-line" />
                        <span className="sm-tick-label" style={{ color, fontWeight: 700 }}>{label}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="sm-legend-footer">
                  <span className="sm-footer-note">Continuous Geotechnical Gradient</span>
                  <span className="sm-footer-range">FoS 0.80 – ≥6.00</span>
                </div>
              </div>



              {/* ── Cell Inspector ─────────────────────────────────────── */}
              <div style={{
                position: 'relative',
                background: 'rgba(6,14,26,0.92)', backdropFilter: 'blur(10px)',
                border: inspectedCell?.classification?.level === 'failure'
                  ? '1px solid rgba(239,68,68,0.65)'
                  : inspectedCell?.classification?.level === 'high_risk'
                  ? '1px solid rgba(249,115,22,0.55)'
                  : inspectedCell?.classification?.level === 'watch'
                  ? '1px solid rgba(234,179,8,0.50)'
                  : '1px solid rgba(0,212,255,0.28)',
                borderRadius: 6, padding: '8px 12px', minWidth: 248,
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)', pointerEvents: 'auto',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 12 }}>⚖️</span>
                    <span style={{ fontSize: '0.62rem', fontWeight: 800, color: '#f97316', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                      TERRAIN INSPECTOR
                    </span>
                  </div>
                  <span style={{
                    fontSize: '0.46rem', fontWeight: 700,
                    color: inspectedCell ? (inspectedCell.classification?.color ?? '#22c55e') : '#8ab4cc',
                    background: inspectedCell ? `${inspectedCell.classification?.color ?? '#22c55e'}22` : 'rgba(255,255,255,0.06)',
                    border: inspectedCell ? `1px solid ${inspectedCell.classification?.color ?? '#22c55e'}55` : '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 3, padding: '1px 4px',
                  }}>
                    {inspectedCell ? `CELL (${inspectedCell.x}, ${inspectedCell.y})${inspectedCell.isPinned ? ' [SELECTED]' : ''}` : 'CLICK / HOVER TO INSPECT'}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 10px', fontSize: '0.54rem' }}>
                  {[
                    { label: 'Elevation',           val: inspectedCell?.elevation != null ? `${inspectedCell.elevation.toFixed(1)} m` : '—' },
                    { label: 'Slope θ',             val: inspectedCell?.slopeDeg != null ? `${inspectedCell.slopeDeg.toFixed(1)}°` : `${terrainHydrology?.stats?.meanSlope?.toFixed(1) ?? '—'}°` },
                    { label: 'Saturation S',        val: inspectedCell != null ? `${(inspectedCell.saturation * 100).toFixed(1)}%` : `${(avgSat * 100).toFixed(1)}%` },
                    { label: 'Effective Sat Se',    val: inspectedCell?.effectiveSaturation != null ? `${(inspectedCell.effectiveSaturation * 100).toFixed(1)}%` : `${(avgPoreState.effectiveSaturation * 100).toFixed(1)}%` },
                    { label: 'Water Content θ',     val: inspectedCell?.waterContent != null ? `${inspectedCell.waterContent.toFixed(3)} m³/m³` : `${avgPoreState.waterContent.toFixed(3)} m³/m³` },
                    { label: 'Pressure Head h',     val: inspectedCell?.pressureHead != null ? `${inspectedCell.pressureHead.toFixed(3)} m` : `${avgPoreState.pressureHead.toFixed(3)} m` },
                    { label: 'Pore Pressure u',     val: inspectedCell != null ? `${inspectedCell.porePressure.toFixed(2)} kPa` : `${avgPoreState.porePressure.toFixed(2)} kPa` },
                    { label: "Cohesion c'",         val: `${SOIL.cohesion_c_kPa} kPa (ref)` },
                    { label: "Friction φ'",         val: `${SOIL.frictionAngle_phi_deg}° (ref)` },
                    { label: 'Soil Depth z',        val: `${SOIL.soilDepth} m` },
                  ].map(({ label, val }) => (
                    <div key={label}>
                      <div style={{ color: '#8ab4cc', fontSize: '0.46rem', textTransform: 'uppercase' }}>{label}</div>
                      <strong style={{ color: '#00f0ff', fontFamily: 'JetBrains Mono, monospace' }}>{val}</strong>
                    </div>
                  ))}
                </div>

                {/* ── FoS Result (physics-based, cell-by-cell single source of truth) */}
                <div style={{ marginTop: 8, paddingTop: 7, borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: '0.46rem', color: '#8ab4cc', textTransform: 'uppercase' }}>Factor of Safety</div>
                    <strong style={{
                      fontSize: '0.90rem', fontFamily: 'JetBrains Mono, monospace',
                      color: inspectedCell?.classification?.color ?? (avgFoS !== '—' ? getFoSContinuousColor(parseFloat(avgFoS)) : '#4a6880'),
                    }}>
                      {inspectedCell?.fos != null
                        ? (isFinite(inspectedCell.fos) ? (inspectedCell.fos >= 90 ? '>10 (STABLE)' : inspectedCell.fos.toFixed(2)) : '∞')
                        : (avgFoS !== '—' ? avgFoS : '—')}
                    </strong>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.42rem', color: '#8ab4cc', textTransform: 'uppercase', marginBottom: 2 }}>STATUS</div>
                    <div style={{
                      fontSize: '0.50rem', fontWeight: 800, letterSpacing: '0.06em',
                      color: inspectedCell?.classification?.color ?? '#22c55e',
                      background: (inspectedCell?.classification?.color ?? '#22c55e') + '22',
                      border: `1px solid ${(inspectedCell?.classification?.color ?? '#22c55e')}55`,
                      borderRadius: 4, padding: '3px 7px', textTransform: 'uppercase',
                    }}>
                      {inspectedCell?.classification?.label ?? 'STABLE'}
                    </div>
                  </div>
                </div>

                {/* ── Cell saturation warning badge (SEPARATE from FoS) ── */}
                {inspectedCell?.isCriticalSat && (
                  <div style={{
                    marginTop: 5, paddingTop: 5, borderTop: '1px solid rgba(255,60,30,0.25)',
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}>
                    <span style={{ fontSize: 10 }}>⚠️</span>
                    <span style={{ fontSize: '0.46rem', color: '#ff7755', fontWeight: 700, fontStyle: 'italic' }}>
                      S = {(inspectedCell.saturation * 100).toFixed(1)}% — Critical saturation (soil-moisture warning)
                    </span>
                  </div>
                )}

                <div style={{ fontSize: '0.42rem', color: '#4a6880', marginTop: 5, fontStyle: 'italic' }}>
                  {inspectedCell
                    ? 'FoS ≤ 1.0 = limit-equilibrium, not confirmed landslide'
                    : 'Showing regional averages — click or hover terrain for cell values'}
                </div>
              </div>

              {/* ── Model Info Panel ───────────────────────────────────── */}
              <div style={{
                position: 'relative',
                background: 'rgba(6,14,26,0.92)', backdropFilter: 'blur(10px)',
                border: '1px solid rgba(249,115,22,0.30)', borderRadius: 6,
                padding: showAssumptions ? '8px 12px' : '5px 8px', maxWidth: 320,
                boxShadow: '0 4px 20px rgba(0,0,0,0.6), 0 0 12px rgba(249,115,22,0.10)',
                pointerEvents: 'auto', transition: 'all 0.2s ease',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: showAssumptions ? 6 : 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13 }}>⚗️</span>
                    <span style={{ fontSize: '0.62rem', fontWeight: 800, color: '#f97316', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                      MODEL 4 · FACTOR OF SAFETY
                    </span>
                  </div>
                  <button
                    onClick={() => setShowAssumptions((p) => !p)}
                    style={{ background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.3)', color: '#f97316', borderRadius: 3, cursor: 'pointer', fontSize: '0.60rem', padding: '1px 5px', lineHeight: '1' }}
                  >
                    {showAssumptions ? '▲' : '▼'}
                  </button>
                </div>

                {showAssumptions && (
                  <>
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: '0.50rem', fontWeight: 700, color: '#f97316', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Soil: {SOIL.name}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 8px', fontSize: '0.48rem', color: '#94a3b8' }}>
                        <span>Depth z = {SOIL.soilDepth} m</span>
                        <span>c' = {SOIL.cohesion_c_kPa} kPa (ref)</span>
                        <span>φ' = {SOIL.frictionAngle_phi_deg}° (ref)</span>
                        <span>γ = {SOIL.unitWeight_gamma_kN_m3} kN/m³ (ref)</span>
                        <span>θs = {SOIL.theta_s} m³/m³</span>
                        <span>θr = {SOIL.theta_r} m³/m³</span>
                        <span>α = {SOIL.alpha} m⁻¹ (ref)</span>
                        <span>n = {SOIL.n} · m = {SOIL.m.toFixed(3)}</span>
                      </div>
                      <div style={{ fontSize: '0.40rem', color: '#64748b', marginTop: 3 }}>
                        * Reference values (Carsel & Parrish 1988 USDA Loam) — not site-measured.
                      </div>
                    </div>

                    <div style={{ fontSize: '0.48rem', color: '#8ab4cc', lineHeight: '1.45', borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 6 }}>
                      {[
                        ['⚖️', 'Physics Model:', 'Infinite-Slope Factor of Safety'],
                        ['💧', 'Hydraulic Model:', 'Van Genuchten soil-water retention (1980)'],
                        ['🌧️', 'Hydrology Driver:', 'Model 2 simulation (rainfall & saturation)'],
                        ['📊', 'Retention Params:', 'α = 3.6 m⁻¹, n = 1.56, m = 0.359 (Carsel & Parrish 1988)'],
                        ['⚗️', 'Pore Pressure:', 'Calibrated matric suction head + perched water table'],
                        ['⚠️', 'FoS ≤ 1.0:', 'Theoretical limit-equilibrium, not confirmed landslide'],
                        ['📢', 'Sat Warning:', 'S ≥ 95% overlay — independent of FoS class'],
                      ].map(([icon, key, val]) => (
                        <div key={key} style={{ display: 'flex', gap: 4, marginBottom: 2 }}>
                          <span>{icon}</span>
                          <span><strong style={{ color: '#00d4ff' }}>{key}</strong> {val}</span>
                        </div>
                      ))}
                    </div>

                    <div style={{ marginTop: 5, paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.07)', fontSize: '0.40rem', color: '#4a6880', fontStyle: 'italic', lineHeight: 1.3 }}>
                      "Prototype calibration — replace with site-specific soil-water retention and groundwater data for production."
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.07)', marginTop: 6 }}>
                      {[
                        { label: 'AVG FoS',    val: avgFoS,                      color: '#22c55e' },
                        { label: 'MIN FoS',    val: minFoS,                      color: '#f97316' },
                        { label: 'FAIL CELLS', val: failCells.toLocaleString(),  color: '#ef4444' },
                        { label: 'HIGH RISK',  val: riskCells.toLocaleString(),  color: '#f97316' },
                      ].map(({ label, val, color }) => (
                        <div key={label} style={{ background: 'rgba(249,115,22,0.05)', borderRadius: 3, padding: '3px 4px', textAlign: 'center' }}>
                          <div style={{ fontSize: '0.40rem', color: '#4a6880' }}>{label}</div>
                          <div style={{ fontSize: '0.55rem', fontWeight: 700, color }}>{val}</div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>

            </div>
          )}

          {/* Real-time Atmospheric Rainfall Animation synchronized with Model 2 */}
          <RainFlowOverlay
            rainfallMm={rainfallMm}
            isPaused={isPaused}
            enabled={showRainParticles}
          />
        </div>
      )}
    </div>
  )
}




