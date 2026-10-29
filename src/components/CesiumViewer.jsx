import React, { useEffect, useRef, useState, useCallback } from 'react'
import {
  createLandslideWarningBeacon,
  removeLandslideWarningBeacon,
  updateLandslideWarningBeacon,
  clearAllLandslideWarningBeacons,
  flyToBeacon,
  TEST_LANDSLIDE_EVENTS,
  RISK_CONFIGS,
} from '../services/cesiumBeaconManager'
import BeaconInspectorPanel from './BeaconInspectorPanel'

export default function CesiumViewer({ onBeaconSelect }) {
  const containerRef = useRef(null)
  const viewerRef = useRef(null)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState(null)
  const [beacons, setBeacons] = useState([])
  const [selectedBeacon, setSelectedBeacon] = useState(null)
  const [filterRisk, setFilterRisk] = useState('ALL')
  const [hudPositions, setHudPositions] = useState({})
  const [activeRegion, setActiveRegion] = useState('sikkim')

  // ── 1. Initialize CesiumJS Viewer ──────────────────────────────────────────
  useEffect(() => {
    let viewer = null
    let removePostRender = null
    let handler = null

    const initCesium = async () => {
      try {
        if (!window.Cesium) {
          throw new Error('CesiumJS library not loaded. Check internet or CDN script.')
        }

        const Cesium = window.Cesium

        // Create sleek control-room Cesium Viewer
        viewer = new Cesium.Viewer(containerRef.current, {
          animation: false,
          baseLayerPicker: false,
          fullscreenButton: false,
          geocoder: false,
          homeButton: false,
          infoBox: false,
          sceneModePicker: false,
          selectionIndicator: false,
          timeline: false,
          navigationHelpButton: false,
          navigationInstructionsInitiallyVisible: false,
          shadows: false,
          terrainShadows: Cesium.ShadowMode.DISABLED,
          scene3DOnly: true,
          skyAtmosphere: new Cesium.SkyAtmosphere(),
        })

        viewerRef.current = viewer

        // Enable terrain clamp and high quality graphics
        viewer.scene.globe.depthTestAgainstTerrain = true
        viewer.scene.globe.enableLighting = false
        viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#03080f')

        // Default Imagery: high-res Dark Matter / Esri World Imagery fallback
        try {
          const imageryProvider = new Cesium.UrlTemplateImageryProvider({
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            maximumLevel: 19,
          })
          viewer.imageryLayers.removeAll()
          viewer.imageryLayers.addImageryProvider(imageryProvider)
        } catch (e) {
          console.warn('[CesiumViewer] Fallback to default imagery', e)
        }

        // Initialize beacons from test data
        const initialBeacons = []
        for (const event of TEST_LANDSLIDE_EVENTS) {
          const id = createLandslideWarningBeacon(viewer, event)
          if (id) {
            initialBeacons.push(event)
          }
        }
        setBeacons(initialBeacons)

        // Select the primary high-risk Sikkim beacon by default
        const primary = TEST_LANDSLIDE_EVENTS.find(b => b.id === 'beacon-sikkim-high') || TEST_LANDSLIDE_EVENTS[0]
        setSelectedBeacon(primary)

        // Initial camera position over Sikkim Himalayas
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(88.612, 27.420, 28000),
          orientation: {
            heading: Cesium.Math.toRadians(15),
            pitch: Cesium.Math.toRadians(-38),
            roll: 0.0,
          },
          duration: 1.5,
        })

        // ── 2. Screen-Space HUD Tracking Loop ──────────────────────────────────
        removePostRender = viewer.scene.postRender.addEventListener(() => {
          if (!viewer || viewer.isDestroyed()) return
          const newHudPositions = {}
          const scene = viewer.scene
          const camera = scene.camera

          TEST_LANDSLIDE_EVENTS.forEach((b) => {
            const worldPos = Cesium.Cartesian3.fromDegrees(b.longitude, b.latitude, 0)
            // Verify if in front of camera
            const cameraToPoint = Cesium.Cartesian3.subtract(worldPos, camera.position, new Cesium.Cartesian3())
            const dot = Cesium.Cartesian3.dot(camera.direction, cameraToPoint)

            if (dot > 0) {
              // Use worldToWindowCoordinates (wgs84ToWindowCoordinates deprecated in 1.21)
          const canvasPos = (Cesium.SceneTransforms.worldToWindowCoordinates || Cesium.SceneTransforms.wgs84ToWindowCoordinates)(scene, worldPos)
              if (canvasPos) {
                newHudPositions[b.id] = {
                  x: canvasPos.x,
                  y: canvasPos.y,
                  visible: true,
                }
              }
            } else {
              newHudPositions[b.id] = { visible: false }
            }
          })

          setHudPositions(newHudPositions)
        })

        // ── 3. Screen Space Event Handler (Click Detection) ───────────────────
        handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
        handler.setInputAction((movement) => {
          const picked = viewer.scene.pick(movement.position)
          if (Cesium.defined(picked) && picked.id) {
            const entityId = typeof picked.id === 'string' ? picked.id : picked.id.id
            const matchedBeacon = TEST_LANDSLIDE_EVENTS.find((b) =>
              entityId.startsWith(b.id)
            )
            if (matchedBeacon) {
              setSelectedBeacon(matchedBeacon)
              if (onBeaconSelect) onBeaconSelect(matchedBeacon)
            }
          }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

        setIsReady(true)
      } catch (err) {
        console.error('[CesiumViewer] Init error:', err)
        setError(err.message)
      }
    }

    initCesium()

    return () => {
      if (removePostRender) removePostRender()
      if (handler) handler.destroy()
      if (viewer && !viewer.isDestroyed()) {
        clearAllLandslideWarningBeacons(viewer)
        viewer.destroy()
      }
    }
  }, [onBeaconSelect])

  // ── Camera Region Focus Helper ─────────────────────────────────────────────
  const handleFlyToRegion = (region) => {
    setActiveRegion(region)
    const viewer = viewerRef.current
    if (!viewer || !window.Cesium) return
    const Cesium = window.Cesium

    if (region === 'sikkim') {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(88.60, 27.43, 26000),
        orientation: {
          heading: Cesium.Math.toRadians(12),
          pitch: Cesium.Math.toRadians(-36),
          roll: 0.0,
        },
        duration: 1.8,
      })
    } else if (region === 'utah') {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(-112.18, 40.48, 14000),
        orientation: {
          heading: Cesium.Math.toRadians(0),
          pitch: Cesium.Math.toRadians(-45),
          roll: 0.0,
        },
        duration: 1.8,
      })
    }
  }

  // ── Focus Individual Beacon ────────────────────────────────────────────────
  const handleSelectBeacon = useCallback((beacon) => {
    setSelectedBeacon(beacon)
    if (viewerRef.current) {
      flyToBeacon(viewerRef.current, beacon.id)
    }
  }, [])

  // ── Simulate Real-time ML Prediction Ingestion ─────────────────────────────
  const handleSimulateMLPrediction = () => {
    const viewer = viewerRef.current
    if (!viewer) return

    // Generate random synthetic landslide occurrence in Sikkim mountainous area
    const latOffset = (Math.random() - 0.5) * 0.15
    const lonOffset = (Math.random() - 0.5) * 0.15
    const baseLat = activeRegion === 'utah' ? 40.51 : 27.48
    const baseLon = activeRegion === 'utah' ? -112.18 : 88.60

    const newProb = 0.75 + Math.random() * 0.23 // 0.75 - 0.98
    const newRisk = newProb >= 0.88 ? 'VERY HIGH' : 'HIGH'
    const newId = `ml-beacon-${Date.now()}`

    const newEvent = {
      id: newId,
      name: `Real-Time ML Ingested Event #${Math.floor(Math.random() * 900 + 100)}`,
      latitude: baseLat + latOffset,
      longitude: baseLon + lonOffset,
      risk_probability: parseFloat(newProb.toFixed(2)),
      risk_level: newRisk,
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC',
      rainfall: `${(120 + Math.random() * 90).toFixed(1)} mm / 24h`,
      soil_moisture: `${(0.42 + Math.random() * 0.2).toFixed(3)} m³/m³`,
      slope: `${(35 + Math.random() * 14).toFixed(1)}°`,
      ndvi: `${(0.12 + Math.random() * 0.15).toFixed(2)}`,
      geology: 'Unconsolidated Colluvium (High Pore Pressure)',
      affected_infrastructure: [
        'Critical Road Sector km ' + Math.floor(Math.random() * 50 + 10),
        'Downslope Habitation Cluster',
      ],
      recommended_action: 'ML High-Confidence Alert: Restrict transit, dispatch field inspection drone.',
    }

    createLandslideWarningBeacon(viewer, newEvent)
    TEST_LANDSLIDE_EVENTS.push(newEvent)
    setBeacons([...beacons, newEvent])
    setSelectedBeacon(newEvent)
    flyToBeacon(viewer, newId)
  }

  // Filter beacons for HUD cards
  const displayedBeacons = beacons.filter(b => {
    if (filterRisk === 'ALL') return true
    return b.risk_level === filterRisk
  })

  return (
    <section className="cesium-viewer-wrapper" aria-label="Cesium 3D Landslide Intelligence GIS">
      {/* Top Controls Toolbar */}
      <div className="viz-toolbar">
        <span className="viz-toolbar-label">Study Region:</span>
        <button
          className={`viz-btn ${activeRegion === 'sikkim' ? 'active' : ''}`}
          onClick={() => handleFlyToRegion('sikkim')}
        >
          🏔️ Sikkim Himalayas (Live High-Risk)
        </button>
        <button
          className={`viz-btn ${activeRegion === 'utah' ? 'active' : ''}`}
          onClick={() => handleFlyToRegion('utah')}
        >
          ⛰️ Utah LiDAR Site
        </button>

        <span className="viz-toolbar-spacer" />

        {/* Risk Filter */}
        <span className="viz-toolbar-label">Filter:</span>
        {['ALL', 'VERY HIGH', 'HIGH', 'MODERATE'].map((level) => (
          <button
            key={level}
            className={`viz-btn ${filterRisk === level ? 'active' : ''}`}
            onClick={() => setFilterRisk(level)}
          >
            {level}
          </button>
        ))}

        <span className="viz-toolbar-spacer" />

        {/* ML Prediction Simulation Button */}
        <button
          className="viz-btn ml-inject-btn"
          onClick={handleSimulateMLPrediction}
          title="Simulate incoming ML inference payload from backend"
        >
          ⚡ Simulate ML Prediction Ingestion
        </button>
      </div>

      {/* Main 3D Cesium Map Container */}
      <div className="cesium-map-container">
        <div ref={containerRef} className="cesium-viewport" />

        {/* Error Overlay */}
        {error && (
          <div className="cesium-error-overlay">
            <p className="error-title">⚠ Cesium Initialization Error</p>
            <p className="error-msg">{error}</p>
          </div>
        )}

        {/* Loading Spinner */}
        {!isReady && !error && (
          <div className="cesium-loading-overlay">
            <div className="loading-spinner" />
            <p>Initializing 3D Geospatial Engine &amp; Warning Beacons…</p>
          </div>
        )}

        {/* Screen-Space Geospatial HUD Leader Tags */}
        {isReady && displayedBeacons.map((b) => {
          const pos = hudPositions[b.id]
          if (!pos || !pos.visible) return null
          const config = RISK_CONFIGS[b.risk_level] || RISK_CONFIGS['HIGH']
          const isSelected = selectedBeacon?.id === b.id

          return (
            <div
              key={b.id}
              className={`beacon-hud-card ${isSelected ? 'selected' : ''} risk-${b.risk_level.toLowerCase().replace(' ', '-')}`}
              style={{
                left: `${pos.x + 28}px`,
                top: `${pos.y - 75}px`,
                borderColor: config.badgeBorder,
              }}
              onClick={() => handleSelectBeacon(b)}
            >
              {/* Leader Line Pin to 3D Coordinates */}
              <div
                className="hud-leader-line"
                style={{
                  background: config.colorHex,
                  boxShadow: `0 0 6px ${config.colorHex}`,
                }}
              />

              <div className="hud-card-header" style={{ background: config.badgeBg }}>
                <span className="hud-risk-badge" style={{ color: config.badgeText }}>
                  ● {b.risk_level}
                </span>
                <span className="hud-prob-badge">
                  {Math.round((b.risk_probability || 0.8) * 100)}% Prob
                </span>
              </div>

              <div className="hud-card-body">
                <div className="hud-card-title">{b.name || 'Landslide Zone'}</div>
                <div className="hud-metrics-row">
                  <span>🌧 {b.rainfall?.split(' ')[0] || '148mm'}</span>
                  <span>💧 {b.soil_moisture?.split(' ')[0] || '0.46'}</span>
                  <span>📐 {b.slope || '38°'}</span>
                </div>
              </div>
            </div>
          )
        })}

        {/* Slide-Out Inspector Panel */}
        {selectedBeacon && (
          <BeaconInspectorPanel
            beacon={selectedBeacon}
            onClose={() => setSelectedBeacon(null)}
            onFlyTo={(id) => viewerRef.current && flyToBeacon(viewerRef.current, id)}
          />
        )}

        {/* Bottom Legend Overlay */}
        <div className="cesium-legend">
          <div className="legend-title">Landslide Radar Beacon Matrix</div>
          <div className="legend-items">
            <div className="legend-item">
              <span className="legend-dot very-high" />
              <span>VERY HIGH (6 Waves · &gt;85%)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot high" />
              <span>HIGH (5 Waves · 70-85%)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot moderate" />
              <span>MODERATE (3 Waves · 40-70%)</span>
            </div>
            <div className="legend-item">
              <span className="legend-dot low" />
              <span>LOW (Subtle · &lt;40%)</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
