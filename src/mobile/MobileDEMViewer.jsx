/**
 * MobileDEMViewer.jsx
 *
 * Isolated Mobile-Only 3D DEM Viewer.
 * - Renders ONLY the 3D Elevation / LiDAR DEM model (No Water, Soil, FoS, Saturation, or XGBoost).
 * - Three.js WebGL rendering with OrbitControls touch gestures (1-finger rotate, 2-finger zoom/pan).
 * - Adaptive LOD safeguards based on real-time FPS monitoring.
 * - Minimalist mobile HUD with quick view presets, reset, and fullscreen controls.
 * - Complete GPU and memory resource disposal on unmount.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  MOBILE_DEM_PATH,
  FALLBACK_DEM_PATH,
  MOBILE_CAMERAS,
  PERF_CONFIG,
  getElevationColor,
} from './mobileConfig'
import './mobile.css'

export default function MobileDEMViewer() {
  const containerRef = useRef(null)
  const animFrameRef = useRef(null)
  const sceneRef = useRef(null)
  const cameraRef = useRef(null)
  const rendererRef = useRef(null)
  const controlsRef = useRef(null)
  const meshRef = useRef(null)
  const demDataRef = useRef(null)

  // Status & Data states
  const [status, setStatus] = useState('loading') // 'loading' | 'ready' | 'error'
  const [errorMsg, setErrorMsg] = useState('')
  const [meta, setMeta] = useState(null)
  const [activeCameraView, setActiveCameraView] = useState('3d')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showPerfDetails, setShowPerfDetails] = useState(false)

  // Performance metrics
  const [fps, setFps] = useState(60)
  const [loadDurationMs, setLoadDurationMs] = useState(0)
  const [currentLod, setCurrentLod] = useState('high') // 'high' | 'mid' | 'low'
  const [pointCount, setPointCount] = useState(0)
  const [triangleCount, setTriangleCount] = useState(0)

  // FPS tracking refs to prevent re-rendering during render loop
  const frameCountRef = useRef(0)
  const lastTimeRef = useRef(0)
  const lastFpsCheckRef = useRef(0)
  const lowFpsStrikeRef = useRef(0)
  const highFpsStrikeRef = useRef(0)

  /**
   * Builds a Three.js BufferGeometry from a 2D elevation grid with vertex colors.
   */
  const buildTerrainGeometry = useCallback((grid, minElev, maxElev, cols, rows, aspectRatio = 1.48) => {
    const terrainWidth = 65 * (aspectRatio > 1 ? 1 : aspectRatio)
    const terrainDepth = 65 / (aspectRatio > 1 ? aspectRatio : 1)
    const verticalExaggeration = 14 // Scale height for clear topography

    const geom = new THREE.PlaneGeometry(terrainWidth, terrainDepth, cols - 1, rows - 1)
    geom.rotateX(-Math.PI / 2) // Orient plane horizontally in X-Z space

    const posAttr = geom.attributes.position
    const positions = posAttr.array
    const vertexCount = posAttr.count
    const colors = new Float32Array(vertexCount * 3)

    const elevRange = Math.max(1, maxElev - minElev)

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // PlaneGeometry vertex index from row & column
        const vertexIndex = r * cols + c
        if (vertexIndex >= vertexCount) continue

        const h = grid[r] && grid[r][c] !== undefined ? grid[r][c] : minElev
        const normH = (h - minElev) / elevRange

        // In Three.js: Y is elevation / altitude
        positions[vertexIndex * 3 + 1] = normH * verticalExaggeration

        // Vertex color interpolation
        const [red, green, blue] = getElevationColor(normH)
        colors[vertexIndex * 3]     = red
        colors[vertexIndex * 3 + 1] = green
        colors[vertexIndex * 3 + 2] = blue
      }
    }

    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geom.computeVertexNormals()

    return geom
  }, [])

  /**
   * Mounts or updates the terrain mesh in the active Three.js scene.
   */
  const updateTerrainMesh = useCallback((lodTier) => {
    const dem = demDataRef.current
    if (!dem || !sceneRef.current) return

    // Choose grid by requested LOD
    let grid = dem.elevation
    let cols = dem.width
    let rows = dem.height

    if (dem.lods && dem.lods[lodTier]) {
      grid = dem.lods[lodTier].elevation
      cols = dem.lods[lodTier].cols
      rows = dem.lods[lodTier].rows
    }

    const minElev = dem.minElevation
    const maxElev = dem.maxElevation
    const aspectRatio = dem.aspectRatio || (cols / rows)

    // Dispose previous geometry to prevent memory leak
    if (meshRef.current) {
      sceneRef.current.remove(meshRef.current)
      meshRef.current.geometry.dispose()
      if (Array.isArray(meshRef.current.material)) {
        meshRef.current.material.forEach((m) => m.dispose())
      } else {
        meshRef.current.material.dispose()
      }
      meshRef.current = null
    }

    const geometry = buildTerrainGeometry(grid, minElev, maxElev, cols, rows, aspectRatio)
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.08,
      flatShading: false,
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.castShadow = false
    mesh.receiveShadow = false
    sceneRef.current.add(mesh)
    meshRef.current = mesh

    setCurrentLod(lodTier)
    setPointCount(cols * rows)
    setTriangleCount((cols - 1) * (rows - 1) * 2)
  }, [buildTerrainGeometry])

  /**
   * Initialize Three.js WebGL Scene and fetch Mobile DEM data
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const startTime = performance.now()
    lastTimeRef.current = startTime
    lastFpsCheckRef.current = startTime
    let isDisposed = false

    // 1. Scene setup
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x03080f)
    sceneRef.current = scene

    // 2. Camera setup
    const width = container.clientWidth || window.innerWidth
    const height = container.clientHeight || window.innerHeight
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.5, 500)
    camera.position.set(
      MOBILE_CAMERAS.perspective.position.x,
      MOBILE_CAMERAS.perspective.position.y,
      MOBILE_CAMERAS.perspective.position.z,
    )
    cameraRef.current = camera

    // 3. WebGL Renderer with mobile battery/performance optimizations
    const renderer = new THREE.WebGLRenderer({
      antialias: window.devicePixelRatio < 2, // disable heavy 4x antialias on dense Retina screens
      powerPreference: 'high-performance',
      alpha: false,
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)) // cap pixel ratio at 2 to prevent GPU thermal throttling
    renderer.setSize(width, height)
    renderer.shadowMap.enabled = false // Disable expensive shadows per mobile spec
    container.appendChild(renderer.domElement)
    rendererRef.current = renderer

    // 4. Touch-enabled OrbitControls
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.screenSpacePanning = true
    controls.maxPolarAngle = Math.PI / 2 - 0.02 // prevent going below terrain plane
    controls.minDistance = 12
    controls.maxDistance = 220
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    }
    controlsRef.current = controls

    // 5. Lighting (Topographic hillshade effect)
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.75)
    scene.add(ambientLight)

    const sunLight = new THREE.DirectionalLight(0xfff7ed, 1.15)
    sunLight.position.set(50, 70, 45)
    scene.add(sunLight)

    const rimLight = new THREE.DirectionalLight(0x00d4ff, 0.35)
    rimLight.position.set(-40, 30, -40)
    scene.add(rimLight)

    // 6. Animation loop & Performance FPS Monitor
    const animate = () => {
      if (isDisposed) return
      animFrameRef.current = requestAnimationFrame(animate)

      controls.update()
      renderer.render(scene, camera)

      // Measure FPS
      frameCountRef.current += 1
      const now = performance.now()
      const delta = now - lastTimeRef.current

      if (delta >= 1000) {
        const measuredFps = Math.round((frameCountRef.current * 1000) / delta)
        setFps(measuredFps)
        frameCountRef.current = 0
        lastTimeRef.current = now

        // Adaptive LOD Safeguard
        if (now - lastFpsCheckRef.current > PERF_CONFIG.checkIntervalMs) {
          lastFpsCheckRef.current = now

          if (measuredFps < PERF_CONFIG.lowFpsThreshold) {
            lowFpsStrikeRef.current += 1
            highFpsStrikeRef.current = 0

            // If low FPS sustained for 2 intervals, step down LOD
            if (lowFpsStrikeRef.current >= 2) {
              lowFpsStrikeRef.current = 0
              setCurrentLod((prev) => {
                if (prev === 'high') {
                  updateTerrainMesh('mid')
                  return 'mid'
                }
                if (prev === 'mid') {
                  updateTerrainMesh('low')
                  return 'low'
                }
                return prev
              })
            }
          } else if (measuredFps > PERF_CONFIG.highFpsThreshold) {
            highFpsStrikeRef.current += 1
            lowFpsStrikeRef.current = 0

            // If FPS is reliably high, recover LOD
            if (highFpsStrikeRef.current >= 3) {
              highFpsStrikeRef.current = 0
              setCurrentLod((prev) => {
                if (prev === 'low') {
                  updateTerrainMesh('mid')
                  return 'mid'
                }
                if (prev === 'mid') {
                  updateTerrainMesh('high')
                  return 'high'
                }
                return prev
              })
            }
          }
        }
      }
    }

    animate()

    // 7. Fetch Mobile DEM data (with fallback to desktop DEM if needed)
    const loadDEM = async () => {
      setStatus('loading')
      try {
        let response = await fetch(MOBILE_DEM_PATH)
        if (!response.ok) {
          console.warn(`Mobile DEM not found at ${MOBILE_DEM_PATH}, falling back to ${FALLBACK_DEM_PATH}`)
          response = await fetch(FALLBACK_DEM_PATH)
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: Failed to fetch DEM dataset.`)
        }

        const data = await response.json()
        if (isDisposed) return

        demDataRef.current = data
        setMeta({
          minElevation: Math.round(data.minElevation),
          maxElevation: Math.round(data.maxElevation),
          deltaElevation: Math.round(data.maxElevation - data.minElevation),
        })

        updateTerrainMesh('high')
        setLoadDurationMs(Math.round(performance.now() - startTime))
        setStatus('ready')
      } catch (err) {
        if (!isDisposed) {
          setErrorMsg(err.message || 'Unknown network error loading DEM')
          setStatus('error')
        }
      }
    }

    loadDEM()

    // 8. Responsive window resize handler
    const handleResize = () => {
      if (!container || !rendererRef.current || !cameraRef.current) return
      const w = container.clientWidth || window.innerWidth
      const h = container.clientHeight || window.innerHeight
      cameraRef.current.aspect = w / h
      cameraRef.current.updateProjectionMatrix()
      rendererRef.current.setSize(w, h)
    }

    window.addEventListener('resize', handleResize)

    // 9. Fullscreen change listener
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', handleFsChange)

    // 10. Memory Cleanup on Unmount
    return () => {
      isDisposed = true
      window.removeEventListener('resize', handleResize)
      document.removeEventListener('fullscreenchange', handleFsChange)

      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
      }

      if (controlsRef.current) {
        controlsRef.current.dispose()
      }

      if (meshRef.current) {
        meshRef.current.geometry.dispose()
        if (Array.isArray(meshRef.current.material)) {
          meshRef.current.material.forEach((m) => m.dispose())
        } else {
          meshRef.current.material.dispose()
        }
      }

      if (rendererRef.current) {
        rendererRef.current.dispose()
        if (rendererRef.current.domElement && rendererRef.current.domElement.parentNode) {
          rendererRef.current.domElement.parentNode.removeChild(rendererRef.current.domElement)
        }
      }

      sceneRef.current = null
      cameraRef.current = null
      rendererRef.current = null
      controlsRef.current = null
      meshRef.current = null
      demDataRef.current = null
    }
  }, [updateTerrainMesh])

  /**
   * Camera Controls
   */
  const handleResetView = () => {
    if (!controlsRef.current || !cameraRef.current) return
    setActiveCameraView('3d')
    controlsRef.current.target.set(0, 0, 0)
    cameraRef.current.position.set(
      MOBILE_CAMERAS.perspective.position.x,
      MOBILE_CAMERAS.perspective.position.y,
      MOBILE_CAMERAS.perspective.position.z,
    )
    controlsRef.current.update()
  }

  const handleTopView = () => {
    if (!controlsRef.current || !cameraRef.current) return
    setActiveCameraView('top')
    controlsRef.current.target.set(0, 0, 0)
    cameraRef.current.position.set(
      MOBILE_CAMERAS.top.position.x,
      MOBILE_CAMERAS.top.position.y,
      MOBILE_CAMERAS.top.position.z,
    )
    controlsRef.current.update()
  }

  const handleZoom = (direction) => {
    if (!controlsRef.current || !cameraRef.current) return
    const factor = direction === 'in' ? 0.8 : 1.25
    cameraRef.current.position.multiplyScalar(factor)
    controlsRef.current.update()
  }

  const handleToggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        if (containerRef.current?.requestFullscreen) {
          await containerRef.current.requestFullscreen()
        } else if (containerRef.current?.webkitRequestFullscreen) {
          await containerRef.current.webkitRequestFullscreen()
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen()
        }
      }
    } catch (e) {
      console.warn('Fullscreen request denied or unsupported:', e)
    }
  }

  // Determine FPS indicator color class
  const fpsClass = fps < 30 ? 'low' : fps < 48 ? 'mid' : ''

  return (
    <div className="mobile-viewer-root" ref={containerRef}>
      {/* ── Top Header ────────────────────────────────────────── */}
      <header className="mobile-header">
        <div className="mobile-brand">
          <span className="mobile-app-title">Landslide Intelligence</span>
          <h1 className="mobile-viewer-subtitle">Mobile DEM Viewer</h1>
        </div>

        {/* Real-time FPS & Perf Pill Button */}
        <button
          className="mobile-hud-badge"
          onClick={() => setShowPerfDetails((p) => !p)}
          title="Toggle Performance Details"
          aria-label="Toggle performance stats"
        >
          <span>FPS</span>
          <span className={`mobile-fps-val ${fpsClass}`}>{fps}</span>
          <span>•</span>
          <span>{currentLod.toUpperCase()}</span>
        </button>
      </header>

      {/* ── Performance Details Flyout ─────────────────────────── */}
      {showPerfDetails && (
        <div className="mobile-perf-panel" role="region" aria-label="Performance details">
          <div className="mobile-perf-row">
            <span className="mobile-perf-label">Status:</span>
            <span className="mobile-perf-val" style={{ color: '#00e676' }}>ONLINE</span>
          </div>
          <div className="mobile-perf-row">
            <span className="mobile-perf-label">FPS:</span>
            <span className={`mobile-perf-val ${fpsClass}`}>{fps} FPS</span>
          </div>
          <div className="mobile-perf-row">
            <span className="mobile-perf-label">LOD Tier:</span>
            <span className="mobile-perf-val">{currentLod.toUpperCase()}</span>
          </div>
          <div className="mobile-perf-row">
            <span className="mobile-perf-label">Vertices:</span>
            <span className="mobile-perf-val">{pointCount.toLocaleString()}</span>
          </div>
          <div className="mobile-perf-row">
            <span className="mobile-perf-label">Triangles:</span>
            <span className="mobile-perf-val">{triangleCount.toLocaleString()}</span>
          </div>
          <div className="mobile-perf-row">
            <span className="mobile-perf-label">Load Time:</span>
            <span className="mobile-perf-val">{loadDurationMs} ms</span>
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <button
              onClick={() => updateTerrainMesh('low')}
              style={{
                flex: 1,
                padding: '4px 6px',
                fontSize: '0.58rem',
                background: currentLod === 'low' ? '#00d4ff' : 'rgba(255,255,255,0.06)',
                color: currentLod === 'low' ? '#000' : '#cbd5e1',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              LOW
            </button>
            <button
              onClick={() => updateTerrainMesh('mid')}
              style={{
                flex: 1,
                padding: '4px 6px',
                fontSize: '0.58rem',
                background: currentLod === 'mid' ? '#00d4ff' : 'rgba(255,255,255,0.06)',
                color: currentLod === 'mid' ? '#000' : '#cbd5e1',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              MID
            </button>
            <button
              onClick={() => updateTerrainMesh('high')}
              style={{
                flex: 1,
                padding: '4px 6px',
                fontSize: '0.58rem',
                background: currentLod === 'high' ? '#00d4ff' : 'rgba(255,255,255,0.06)',
                color: currentLod === 'high' ? '#000' : '#cbd5e1',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              HIGH
            </button>
          </div>
        </div>
      )}

      {/* ── Loading Screen ─────────────────────────────────────── */}
      {status === 'loading' && (
        <div className="mobile-loading-overlay">
          <div className="mobile-spinner" />
          <span className="mobile-loading-text">Loading 3D LiDAR Terrain…</span>
          <span className="mobile-loading-sub">Optimizing DEM geometry for mobile</span>
        </div>
      )}

      {/* ── Error Banner ───────────────────────────────────────── */}
      {status === 'error' && (
        <div className="mobile-error-banner">
          <div className="mobile-error-title">⚠️ Terrain Load Error</div>
          <div className="mobile-error-msg">{errorMsg}</div>
          <button
            className="mobile-retry-btn"
            onClick={() => window.location.reload()}
          >
            Retry Loading
          </button>
        </div>
      )}

      {/* ── Elevation Legend Overlay ───────────────────────────── */}
      {meta && status === 'ready' && (
        <div className="mobile-legend-pill">
          <div className="mobile-legend-title">
            <span>⛰️</span>
            <span>ELEVATION</span>
          </div>
          <div className="mobile-legend-gradient-bar" />
          <div className="mobile-legend-range">
            <span>{meta.minElevation}m</span>
            <span>{meta.maxElevation}m ASL</span>
          </div>
        </div>
      )}

      {/* ── Bottom Essential Controls Dock ─────────────────────── */}
      <div className="mobile-control-bar" role="toolbar" aria-label="Mobile DEM Controls">
        <button
          className={`mobile-ctrl-btn ${activeCameraView === '3d' ? 'active' : ''}`}
          onClick={handleResetView}
          title="Reset 3D Perspective"
        >
          <span>🔄</span>
          <span>Reset</span>
        </button>

        <button
          className={`mobile-ctrl-btn ${activeCameraView === 'top' ? 'active' : ''}`}
          onClick={handleTopView}
          title="Top-down Nadir View"
        >
          <span>🧭</span>
          <span>Top</span>
        </button>

        <div className="mobile-ctrl-divider" />

        <button
          className="mobile-ctrl-btn"
          onClick={() => handleZoom('in')}
          title="Zoom In"
        >
          <span>➕</span>
        </button>

        <button
          className="mobile-ctrl-btn"
          onClick={() => handleZoom('out')}
          title="Zoom Out"
        >
          <span>➖</span>
        </button>

        <div className="mobile-ctrl-divider" />

        <button
          className={`mobile-ctrl-btn ${isFullscreen ? 'active' : ''}`}
          onClick={handleToggleFullscreen}
          title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
        >
          <span>{isFullscreen ? '⤦' : '⛶'}</span>
        </button>
      </div>
    </div>
  )
}
