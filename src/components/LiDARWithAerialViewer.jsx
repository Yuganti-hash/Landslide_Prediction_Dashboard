/**
 * LiDARWithAerialViewer.jsx
 *
 * Combines the LiDAR terrain elevation (terrain_web.json) with live Esri
 * World Imagery tiles draped directly over the terrain surface in 3D.
 *
 * Technical approach:
 *   - Cesium.CustomHeightmapTerrainProvider feeds LiDAR elevation[][] as the
 *     globe's terrain height source (geographic-coordinate-aligned via WGS84).
 *   - Esri World Imagery (UrlTemplateImageryProvider) is the imagery layer —
 *     Cesium automatically drapes it over the tessellated terrain mesh.
 *   - Camera is flown to the Utah LiDAR bounding box at an oblique angle.
 *
 * Future overlay hooks:
 *   Pass an `overlays` prop with arrays of risk polygons, beacons, field
 *   markers, etc.  The existing cesiumBeaconManager functions accept any
 *   Cesium.Viewer instance, so they will work here without modification.
 */

import React, { useEffect, useRef, useState } from 'react'

// ── Utah LiDAR geographic bounding box ───────────────────────────────────────
// These values come from the EPSG:26912 → WGS84 conversion of the source GeoTIFF.
// They match the TERRAIN_BBOX constant already used in VizPlaceholder.jsx.
export const LIDAR_BBOX = {
  west:  -112.29926877,
  south:  40.46334075,
  east:  -112.06152903,
  north:  40.55593193,
}

// ── Bilinear sampler ─────────────────────────────────────────────────────────
// Samples a 2-D elevation grid using bilinear interpolation.
// normU ∈ [0,1]: 0 = west edge, 1 = east edge
// normV ∈ [0,1]: 0 = south edge, 1 = north edge
function bilinearSample(elevation, rows, cols, normU, normV) {
  // elevation[row][col]: row 0 = NORTH, row (rows-1) = SOUTH
  // So we flip V: normV=0 (south) → row (rows-1), normV=1 (north) → row 0
  const col  = normU * (cols - 1)
  const row  = (1.0 - normV) * (rows - 1)

  const c0   = Math.max(0, Math.floor(col))
  const c1   = Math.min(cols - 1, c0 + 1)
  const r0   = Math.max(0, Math.floor(row))
  const r1   = Math.min(rows - 1, r0 + 1)

  const tc   = col - c0
  const tr   = row - r0

  const h00  = elevation[r0][c0]
  const h10  = elevation[r0][c1]
  const h01  = elevation[r1][c0]
  const h11  = elevation[r1][c1]

  return h00 * (1 - tc) * (1 - tr)
       + h10 * tc * (1 - tr)
       + h01 * (1 - tc) * tr
       + h11 * tc * tr
}

// ── Terrain provider builder ─────────────────────────────────────────────────
// Creates a CustomHeightmapTerrainProvider that feeds the LiDAR elevation matrix
// into Cesium's terrain engine.  Called once after the JSON is fetched.
function buildLiDARTerrainProvider(Cesium, elevation, lidarRows, lidarCols, minElevation) {
  // Provider tile resolution: 128×128 is sufficient for a ~24 km × 9 km region
  // and keeps callback overhead low.  Cesium will up-sample to finer LODs.
  const PROV_W = 128
  const PROV_H = 128

  const { west, south, east, north } = LIDAR_BBOX
  const lonSpan = east  - west
  const latSpan = north - south

  // Elevation value for tiles outside the LiDAR footprint.
  // We use the terrain minimum so the outer globe is a near-flat plateau at the
  // same height as Utah's lowest point, eliminating steep cliff walls at edges.
  const BASE_ELEV = minElevation

  // Build a GeographicTilingScheme once so we can call tileXYToRectangle inside
  // the callback without constructing a new instance on every call.
  const tilingScheme = new Cesium.GeographicTilingScheme()

  return new Cesium.CustomHeightmapTerrainProvider({
    width:  PROV_W,
    height: PROV_H,
    tilingScheme,
    callback(x, y, level) {
      // ── Get geographic bounds of the requested Cesium tile ──────────────────
      const rect       = tilingScheme.tileXYToRectangle(x, y, level)
      const tileLon0   = Cesium.Math.toDegrees(rect.west)
      const tileLon1   = Cesium.Math.toDegrees(rect.east)
      const tileLat0   = Cesium.Math.toDegrees(rect.south)
      const tileLat1   = Cesium.Math.toDegrees(rect.north)
      const tileLonSpan = tileLon1 - tileLon0
      const tileLatSpan = tileLat1 - tileLat0

      // Early-exit: tile completely outside LiDAR bounding box?
      if (tileLon1 < west || tileLon0 > east ||
          tileLat1 < south || tileLat0 > north) {
        return new Float32Array(PROV_W * PROV_H).fill(BASE_ELEV)
      }

      // ── Fill the heightmap buffer ──────────────────────────────────────────
      // CesiumJS heightmap convention:
      //   heights[row * PROV_W + col]  —  row 0 = SOUTH, col 0 = WEST
      const heights = new Float32Array(PROV_W * PROV_H)

      for (let row = 0; row < PROV_H; row++) {
        // Cesium row 0 = south → fraction increases northward
        const lat = tileLat0 + (row / (PROV_H - 1)) * tileLatSpan

        for (let col = 0; col < PROV_W; col++) {
          const lon = tileLon0 + (col / (PROV_W - 1)) * tileLonSpan

          if (lon >= west && lon <= east && lat >= south && lat <= north) {
            // Map (lon, lat) → normalised (u, v) within LiDAR bbox
            const u = (lon - west)  / lonSpan  // 0=west,  1=east
            const v = (lat - south) / latSpan  // 0=south, 1=north
            heights[row * PROV_W + col] = bilinearSample(elevation, lidarRows, lidarCols, u, v)
          } else {
            heights[row * PROV_W + col] = BASE_ELEV
          }
        }
      }

      return heights
    },
  })
}

// ── Info overlay ─────────────────────────────────────────────────────────────
function InfoOverlay({ terrain }) {
  return (
    <div className="lai-info-overlay" aria-label="LiDAR + Aerial dataset info">
      <div className="lai-info-title">🛰 LiDAR + Aerial Imagery</div>

      <div className="lai-info-row">
        <span className="lai-info-key">Elevation Source</span>
        <span className="lai-info-val">LiDAR DEM (Utah)</span>
      </div>
      <div className="lai-info-row">
        <span className="lai-info-key">Grid Size</span>
        <span className="lai-info-val">{terrain?.width} × {terrain?.height} pts</span>
      </div>
      <div className="lai-info-row">
        <span className="lai-info-key">Elev Range</span>
        <span className="lai-info-val">
          {terrain?.minElevation?.toFixed(0)}–{terrain?.maxElevation?.toFixed(0)} m
        </span>
      </div>
      <div className="lai-info-row">
        <span className="lai-info-key">Imagery</span>
        <span className="lai-info-val">Esri World Imagery</span>
      </div>
      <div className="lai-info-row">
        <span className="lai-info-key">CRS</span>
        <span className="lai-info-val">WGS 84 / EPSG:4326</span>
      </div>

      <div className="lai-info-hint">Drag · Scroll · Right-drag to tilt</div>
    </div>
  )
}

// ── Overlay placeholder for future ML layers ─────────────────────────────────
// The viewerRef is exposed so parent components can attach beacons, heatmaps,
// risk polygons, field markers, etc. via the cesiumBeaconManager API.
export function getLiDARViewerRef(viewerRef) {
  return viewerRef?.current ?? null
}

// ── Main component ───────────────────────────────────────────────────────────
export default function LiDARWithAerialViewer({
  overlays = {},
  // Future: riskHeatmap, warningBeacons, landslidePolygons, fieldMarkers, etc.
}) {
  const containerRef = useRef(null)
  const viewerRef    = useRef(null)

  const [status,    setStatus]    = useState('loading')  // 'loading' | 'ready' | 'error'
  const [loadingMsg, setLoadingMsg] = useState('Fetching LiDAR elevation data…')
  const [errMsg,    setErrMsg]    = useState('')
  const [terrain,   setTerrain]   = useState(null)

  useEffect(() => {
    let viewer   = null
    let cancelled = false

    async function init() {
      try {
        // ── 1. Fetch LiDAR terrain data ──────────────────────────────────────
        setLoadingMsg('Fetching LiDAR elevation data…')
        const res = await fetch('/terrain_web.json')
        if (!res.ok) throw new Error(`terrain_web.json: HTTP ${res.status} — ${res.statusText}`)
        const data = await res.json()

        if (!data.elevation || !Array.isArray(data.elevation)) {
          throw new Error('terrain_web.json is missing the "elevation" matrix field.')
        }

        if (cancelled) return

        const { elevation, width: lidarCols, height: lidarRows, minElevation } = data
        setTerrain(data)

        // ── 2. Guard: CesiumJS must be loaded ────────────────────────────────
        if (!window.Cesium) {
          throw new Error('CesiumJS library not loaded. Check the CDN <script> in index.html.')
        }

        // ── 3. Guard: CustomHeightmapTerrainProvider (Cesium ≥ 1.109) ────────
        if (typeof window.Cesium.CustomHeightmapTerrainProvider !== 'function') {
          throw new Error(
            'CustomHeightmapTerrainProvider is not available in this Cesium version. ' +
            'Requires CesiumJS 1.109 or later.'
          )
        }

        const Cesium = window.Cesium

        setLoadingMsg('Building LiDAR terrain provider…')
        const terrainProvider = buildLiDARTerrainProvider(
          Cesium, elevation, lidarRows, lidarCols, minElevation
        )

        if (cancelled) return
        setLoadingMsg('Initialising 3D viewer…')

        // ── 4. Create Cesium Viewer with LiDAR terrain ────────────────────────
        viewer = new Cesium.Viewer(containerRef.current, {
          terrainProvider,
          animation:                            false,
          baseLayerPicker:                      false,
          fullscreenButton:                     false,
          geocoder:                             false,
          homeButton:                           false,
          infoBox:                              false,
          sceneModePicker:                      false,
          selectionIndicator:                   false,
          timeline:                             false,
          navigationHelpButton:                 false,
          scene3DOnly:                          true,
          shadows:                              false,
          terrainShadows:                       Cesium.ShadowMode.DISABLED,
          // ── Suppress ALL globe chrome so only Utah terrain is visible ──────────
          // Cesium docs: skyBox:false also removes the sun and moon
          skyBox:                               false,
          skyAtmosphere:                        false,
        })

        viewerRef.current = viewer

        // Depth test ensures terrain occludes objects behind it
        viewer.scene.globe.depthTestAgainstTerrain = true

        // Subtle sun-angle lighting gives the LiDAR hills realistic shadows
        viewer.scene.globe.enableLighting = true

        // ── Make everything OUTSIDE the Utah bbox completely invisible ─────────
        // Globe areas without imagery will render this dark colour (matches dashboard)
        viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#03080f')

        // Solid dark background (no stars, no blue sky)
        viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#03080f')

        // ── 5. Imagery: Esri World Imagery clipped TO THE UTAH BBOX ONLY ────────
        // The `rectangle` parameter tells Cesium to:
        //   (a) only request tiles that overlap this bbox, AND
        //   (b) only RENDER imagery within this bbox.
        // Outside the rectangle the globe shows its baseColor (#03080f) = dark. ✓
        const { west, south, east, north } = LIDAR_BBOX
        const utahRect = Cesium.Rectangle.fromDegrees(west, south, east, north)
        try {
          const imageryProvider = new Cesium.UrlTemplateImageryProvider({
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            maximumLevel: 19,
            rectangle:    utahRect,   // ← KEY: imagery visible only inside Utah bbox
            credit: 'Esri, DigitalGlobe, GeoEye, i-cubed, USDA FSA, USGS, AEX, Getmapping',
          })
          viewer.imageryLayers.removeAll()
          viewer.imageryLayers.addImageryProvider(imageryProvider)
        } catch (imgErr) {
          console.warn('[LiDARWithAerialViewer] Imagery provider error:', imgErr)
        }

        if (cancelled) return

        // ── 6. Fly camera to the Utah LiDAR bounding box ─────────────────────
        const centerLon = (west + east) / 2   // ≈ -112.18°
        const centerLat = (south + north) / 2 // ≈ 40.51°

        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            centerLon,
            centerLat - 0.03,  // minimal southward offset
            22000              // 22 km altitude — entire patch fills the frame
          ),
          orientation: {
            heading: Cesium.Math.toRadians(5),   // nearly north-facing
            pitch:   Cesium.Math.toRadians(-55), // steeper bird's-eye angle (less wall)
            roll:    0.0,
          },
          duration: 2.0,
        })

        if (!cancelled) {
          setStatus('ready')
        }
      } catch (err) {
        console.error('[LiDARWithAerialViewer] Init error:', err)
        if (!cancelled) {
          setErrMsg(err.message)
          setStatus('error')
        }
      }
    }

    init()

    // ── Cleanup on unmount or viewMode switch ────────────────────────────────
    return () => {
      cancelled = true
      if (viewer && !viewer.isDestroyed()) {
        viewer.destroy()
      }
      viewerRef.current = null
    }
  }, []) // Mount once; destroyed on unmount

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <section
      className="lidar-aerial-wrapper"
      aria-label="LiDAR terrain with Esri aerial imagery — 3D interactive view"
    >
      {/* ── Toolbar ── */}
      <div className="viz-toolbar" role="toolbar" aria-label="LiDAR + Aerial controls">
        <span className="viz-toolbar-label">Utah · Oquirrh Mountains</span>

        <span className="viz-toolbar-spacer" />

        {/* Geographic extent readout */}
        <span className="viz-coord">
          {LIDAR_BBOX.west.toFixed(4)}° → {LIDAR_BBOX.east.toFixed(4)}°W&nbsp;&nbsp;
          {LIDAR_BBOX.south.toFixed(4)}° → {LIDAR_BBOX.north.toFixed(4)}°N
          &nbsp;|&nbsp;
          {terrain
            ? `${terrain.minElevation.toFixed(0)}–${terrain.maxElevation.toFixed(0)} m elev`
            : 'Loading elevation data…'}
        </span>
      </div>

      {/* ── Cesium viewport + overlays ── */}
      <div className="lidar-aerial-map-container">

        {/* Native Cesium DOM target */}
        <div ref={containerRef} className="cesium-viewport" />

        {/* Loading overlay */}
        {status === 'loading' && (
          <div className="cesium-loading-overlay">
            <div className="loading-spinner" />
            <p>{loadingMsg}</p>
          </div>
        )}

        {/* Error overlay */}
        {status === 'error' && (
          <div className="cesium-error-overlay">
            <p className="error-title">⚠ LiDAR + Aerial — Initialisation Error</p>
            <p className="error-msg">{errMsg}</p>
            <p className="error-msg" style={{ fontSize: '0.58rem', marginTop: 6 }}>
              Requires CesiumJS 1.109+ and <code>public/terrain_web.json</code>.
            </p>
          </div>
        )}

        {/* Dataset info card (bottom-left) */}
        {status === 'ready' && <InfoOverlay terrain={terrain} />}

        {/* Future overlay hook: ML risk layers, beacons, polygons */}
        {/* The viewerRef is available for parent components via ref forwarding */}
      </div>
    </section>
  )
}
