/**
 * cesiumBeaconManager.js
 * 
 * High-performance, GPU-accelerated animated Landslide Warning Beacon System for CesiumJS.
 * Features:
 * - Concentric expanding radar ripple waves (4–6 rings, phase-staggered, continuous loop)
 * - Dynamic risk level styling (VERY HIGH, HIGH, MODERATE, LOW)
 * - Ground-clamped 3D terrain attachment
 * - Pulsing core glow & epicenter warning icon
 * - Leader lines & screen-space HUD positioning
 * - Multi-beacon lifecycle management (create, update, remove, flyTo)
 * - Modular ML API ingestion hook
 */

// ── Color and Risk Configuration ─────────────────────────────────────────────
export const RISK_CONFIGS = {
  'VERY HIGH': {
    colorHex: '#FF0038',
    cesiumColor: [1.0, 0.0, 0.22, 0.95],
    waveColor: [1.0, 0.05, 0.25, 0.85],
    glowColor: [1.0, 0.2, 0.35, 1.0],
    ringCount: 6,
    radius: 2400, // meters
    duration: 1.6, // seconds per loop (faster urgency)
    pulseSpeed: 4.5,
    badgeBg: 'rgba(255, 0, 56, 0.22)',
    badgeBorder: '#FF0038',
    badgeText: '#FF3B62',
    label: 'VERY HIGH RISK',
    status: 'CRITICAL ALERT',
  },
  'HIGH': {
    colorHex: '#FF4D00',
    cesiumColor: [1.0, 0.3, 0.0, 0.9],
    waveColor: [1.0, 0.35, 0.05, 0.75],
    glowColor: [1.0, 0.5, 0.1, 0.95],
    ringCount: 5,
    radius: 1700,
    duration: 2.3,
    pulseSpeed: 3.2,
    badgeBg: 'rgba(255, 77, 0, 0.2)',
    badgeBorder: '#FF4D00',
    badgeText: '#FF702E',
    label: 'HIGH RISK',
    status: 'WARNING',
  },
  'MODERATE': {
    colorHex: '#FFAA00',
    cesiumColor: [1.0, 0.67, 0.0, 0.8],
    waveColor: [1.0, 0.7, 0.1, 0.65],
    glowColor: [1.0, 0.8, 0.2, 0.9],
    ringCount: 3,
    radius: 950,
    duration: 3.2,
    pulseSpeed: 2.0,
    badgeBg: 'rgba(255, 170, 0, 0.18)',
    badgeBorder: '#FFAA00',
    badgeText: '#FFC04D',
    label: 'MODERATE RISK',
    status: 'ADVISORY',
  },
  'LOW': {
    colorHex: '#00E5FF',
    cesiumColor: [0.0, 0.9, 1.0, 0.7],
    waveColor: [0.0, 0.9, 1.0, 0.45],
    glowColor: [0.2, 0.95, 1.0, 0.8],
    ringCount: 1,
    radius: 450,
    duration: 4.5,
    pulseSpeed: 1.2,
    badgeBg: 'rgba(0, 229, 255, 0.12)',
    badgeBorder: '#00E5FF',
    badgeText: '#4DEBFF',
    label: 'LOW RISK',
    status: 'NORMAL MONITORING',
  },
}

// ── Built-in Test Landslide Events ───────────────────────────────────────────
export const TEST_LANDSLIDE_EVENTS = [
  {
    id: 'beacon-sikkim-high',
    name: 'Dikchu Escarpment (Sikkim)',
    latitude: 27.533,
    longitude: 88.612,
    risk_probability: 0.87,
    risk_level: 'HIGH',
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC',
    rainfall: '148.5 mm / 24h',
    soil_moisture: '0.462 m³/m³',
    slope: '38.5°',
    ndvi: '0.22',
    elevation: '1,420 m',
    geology: 'Gneiss & Mica Schist (Weathered)',
    affected_infrastructure: [
      'NH-10 National Highway km 38 (Critical Lifeline)',
      'Lower Dikchu Settlement (Pop. 1,420)',
      'Teesta Hydro Channel Discharge Corridor',
    ],
    recommended_action: 'Issue Level 2 Evacuation Warning. Deploy Border Roads Force for debris clearance standby.',
  },
  {
    id: 'beacon-sikkim-very-high',
    name: 'Singtam Ridge Fault Line',
    latitude: 27.3256,
    longitude: 88.583,
    risk_probability: 0.94,
    risk_level: 'VERY HIGH',
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC',
    rainfall: '194.2 mm / 24h',
    soil_moisture: '0.581 m³/m³',
    slope: '44.8°',
    ndvi: '0.15',
    elevation: '1,890 m',
    geology: 'Fissured Phyllite & Saturated Colluvium',
    affected_infrastructure: [
      'Singtam Bridge Access Spur (Immediate Risk)',
      'Bazaar Ward 3 (Pop. 2,850)',
      'High-Voltage Transmission Pylon T-4',
    ],
    recommended_action: 'IMMEDIATE RED ALERT: Initiate emergency evacuations along 1.5 km slope buffer. Close highway segment.',
  },
  {
    id: 'beacon-sikkim-moderate',
    name: 'Mangan Hill Terraces',
    latitude: 27.42,
    longitude: 88.51,
    risk_probability: 0.58,
    risk_level: 'MODERATE',
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC',
    rainfall: '72.0 mm / 24h',
    soil_moisture: '0.334 m³/m³',
    slope: '27.1°',
    ndvi: '0.45',
    elevation: '1,160 m',
    geology: 'Sandstone & Siltstone Intercalation',
    affected_infrastructure: [
      'North Sikkim Agricultural Feeder Road',
      'Terraced Farmlands Sector 4',
    ],
    recommended_action: 'Maintain hourly sensor polling. Restrict heavy commercial truck transport.',
  },
  {
    id: 'beacon-sikkim-low',
    name: 'Gangtok South Valley',
    latitude: 27.61,
    longitude: 88.68,
    risk_probability: 0.24,
    risk_level: 'LOW',
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC',
    rainfall: '22.5 mm / 24h',
    soil_moisture: '0.210 m³/m³',
    slope: '15.4°',
    ndvi: '0.68',
    elevation: '940 m',
    geology: 'Stable Quartzite Bedrock',
    affected_infrastructure: [
      'Local Access Road 2',
    ],
    recommended_action: 'Routine monitoring. Normal traffic and public movement permitted.',
  },
  {
    id: 'beacon-utah-lidar',
    name: 'Oquirrh Slope (LiDAR Dataset)',
    latitude: 40.51,
    longitude: -112.18,
    risk_probability: 0.82,
    risk_level: 'HIGH',
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC',
    rainfall: '88.0 mm / 24h',
    soil_moisture: '0.378 m³/m³',
    slope: '36.2°',
    ndvi: '0.28',
    elevation: '2,150 m',
    geology: 'Colluvial Gravel & Fractured Limestone',
    affected_infrastructure: [
      'Bingham Canyon Access Corridor',
      'Mountain Drainage Gully 7',
    ],
    recommended_action: 'Monitor seismic vibration and groundwater pressure.',
  },
]

// ── SVG Warning Marker Icon Generator ────────────────────────────────────────
function createWarningPinCanvas(riskLevel) {
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 96
  const ctx = canvas.getContext('2d')
  const config = RISK_CONFIGS[riskLevel] || RISK_CONFIGS['HIGH']

  // Draw glowing epicenter pin
  ctx.clearRect(0, 0, 96, 96)

  // Outer radial glow
  const grad = ctx.createRadialGradient(48, 48, 8, 48, 48, 44)
  grad.addColorStop(0, config.colorHex)
  grad.addColorStop(0.5, 'rgba(255, 30, 30, 0.4)')
  grad.addColorStop(1, 'rgba(255, 30, 30, 0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(48, 48, 44, 0, Math.PI * 2)
  ctx.fill()

  // Inner solid badge
  ctx.fillStyle = '#0a1018'
  ctx.beginPath()
  ctx.arc(48, 48, 22, 0, Math.PI * 2)
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = config.colorHex
  ctx.stroke()

  // Warning triangle icon
  ctx.fillStyle = config.colorHex
  ctx.beginPath()
  ctx.moveTo(48, 33)
  ctx.lineTo(60, 56)
  ctx.lineTo(36, 56)
  ctx.closePath()
  ctx.fill()

  // Exclamation mark
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(47, 41, 2, 7)
  ctx.beginPath()
  ctx.arc(48, 51, 1.2, 0, Math.PI * 2)
  ctx.fill()

  return canvas.toDataURL()
}

// ── Procedural Dynamic Canvas Texture for Concentric Radar Waves ──────────────
export class DynamicRippleTexture {
  constructor(riskLevel = 'HIGH') {
    this.riskLevel = riskLevel
    this.config = RISK_CONFIGS[riskLevel] || RISK_CONFIGS['HIGH']
    this.size = 256
    this.canvas = document.createElement('canvas')
    this.canvas.width = this.size
    this.canvas.height = this.size
    this.ctx = this.canvas.getContext('2d')
    this.startTime = performance.now()
  }

  update(timeNow = performance.now()) {
    const { ctx, size, config } = this
    const center = size / 2
    const maxRadius = center - 8
    const elapsed = (timeNow - this.startTime) / 1000
    const progressBase = (elapsed / config.duration) % 1.0

    ctx.clearRect(0, 0, size, size)

    const rings = config.ringCount
    const [r, g, b] = config.cesiumColor.map(v => Math.round(v * 255))

    // Draw concentric staggered wave rings
    for (let i = 0; i < rings; i++) {
      const phase = i / rings
      const ringProgress = (progressBase + phase) % 1.0
      const currentRadius = 6 + ringProgress * maxRadius

      // Opacity fades smoothly to 0 at max radius
      const alpha = Math.pow(1.0 - ringProgress, 1.3) * 0.85

      if (alpha > 0.01) {
        // Wave stroke
        ctx.beginPath()
        ctx.arc(center, center, currentRadius, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`
        ctx.lineWidth = Math.max(1.5, 4.0 * (1.0 - ringProgress * 0.6))
        ctx.stroke()

        // Subtle gradient wave fill behind each ring
        const innerFillRadius = Math.max(0, currentRadius - 16)
        const fillGrad = ctx.createRadialGradient(center, center, innerFillRadius, center, center, currentRadius)
        fillGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`)
        fillGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${alpha * 0.22})`)
        ctx.fillStyle = fillGrad
        ctx.beginPath()
        ctx.arc(center, center, currentRadius, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // Center pulsating glowing core
    const pulseFactor = 0.5 + 0.5 * Math.sin(elapsed * config.pulseSpeed)
    const coreRadius = 8 + pulseFactor * 10
    const coreGrad = ctx.createRadialGradient(center, center, 2, center, center, coreRadius * 2.2)
    coreGrad.addColorStop(0, `rgba(255, 255, 255, 0.95)`)
    coreGrad.addColorStop(0.3, `rgba(${r}, ${g}, ${b}, 0.85)`)
    coreGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)

    ctx.fillStyle = coreGrad
    ctx.beginPath()
    ctx.arc(center, center, coreRadius * 2.2, 0, Math.PI * 2)
    ctx.fill()

    return this.canvas
  }
}

// ── Global Beacon Registry ───────────────────────────────────────────────────
const activeBeacons = new Map()

/**
 * Creates an animated Landslide Warning Beacon on 3D terrain.
 * 
 * @param {Cesium.Viewer} viewer - The active Cesium Viewer instance
 * @param {Object} options - Landslide event data
 * @returns {string} Unique beacon ID
 */
export function createLandslideWarningBeacon(viewer, options) {
  if (!viewer || !window.Cesium) {
    console.warn('[CesiumBeaconManager] Viewer or Cesium not ready.')
    return null
  }

  const {
    id = `beacon-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    latitude,
    longitude,
    risk_probability = 0.85,
    risk_level,
  } = options

  // Determine risk level if not explicitly provided
  const computedRiskLevel = risk_level || (
    risk_probability >= 0.85 ? 'VERY HIGH' :
    risk_probability >= 0.70 ? 'HIGH' :
    risk_probability >= 0.40 ? 'MODERATE' : 'LOW'
  )

  const config = RISK_CONFIGS[computedRiskLevel] || RISK_CONFIGS['HIGH']
  const Cesium = window.Cesium

  // Remove existing beacon with the same ID if any
  if (activeBeacons.has(id)) {
    removeLandslideWarningBeacon(viewer, id)
  }

  const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, 0)
  const rippleTexture = new DynamicRippleTexture(computedRiskLevel)
  const pinIconUrl = createWarningPinCanvas(computedRiskLevel)

  // 1. Ground-clamped concentric ripple ellipse entity
  const groundRippleEntity = viewer.entities.add({
    id: `${id}-ripple`,
    position: position,
    ellipse: {
      semiMajorAxis: config.radius,
      semiMinorAxis: config.radius,
      height: 0,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      classificationType: Cesium.ClassificationType.TERRAIN,
      material: new Cesium.ImageMaterialProperty({
        image: new Cesium.CallbackProperty(() => {
          return rippleTexture.update()
        }, false),
        transparent: true,
      }),
    },
  })

  // 2. Epicenter Warning Billboard Pin
  const billboardEntity = viewer.entities.add({
    id: `${id}-pin`,
    name: options.name || `Landslide Risk: ${computedRiskLevel}`,
    position: Cesium.Cartesian3.fromDegrees(longitude, latitude, 20),
    billboard: {
      image: pinIconUrl,
      scale: 0.65,
      heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY, // Always render cleanly in front
    },
  })

  // 3. Vertical luminous laser beacon pillar
  const pillarHeight = computedRiskLevel === 'VERY HIGH' ? 450 : computedRiskLevel === 'HIGH' ? 320 : 200
  const pillarEntity = viewer.entities.add({
    id: `${id}-pillar`,
    polyline: {
      positions: [
        Cesium.Cartesian3.fromDegrees(longitude, latitude, 0),
        Cesium.Cartesian3.fromDegrees(longitude, latitude, pillarHeight),
      ],
      width: computedRiskLevel === 'VERY HIGH' ? 3 : 2,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.35,
        color: new Cesium.Color(config.cesiumColor[0], config.cesiumColor[1], config.cesiumColor[2], 0.7),
      }),
      clampToGround: false,
    },
  })

  const beaconData = {
    id,
    latitude,
    longitude,
    risk_probability,
    risk_level: computedRiskLevel,
    config,
    groundRippleEntity,
    billboardEntity,
    pillarEntity,
    rippleTexture,
    rawOptions: {
      ...options,
      risk_level: computedRiskLevel,
      risk_probability,
    },
    createdAt: Date.now(),
  }

  activeBeacons.set(id, beaconData)
  return id
}

/**
 * Removes a Landslide Warning Beacon from Cesium Viewer.
 */
export function removeLandslideWarningBeacon(viewer, id) {
  const beacon = activeBeacons.get(id)
  if (!beacon) return false

  if (viewer && viewer.entities) {
    if (beacon.groundRippleEntity) viewer.entities.remove(beacon.groundRippleEntity)
    if (beacon.billboardEntity) viewer.entities.remove(beacon.billboardEntity)
    if (beacon.pillarEntity) viewer.entities.remove(beacon.pillarEntity)
  }

  activeBeacons.delete(id)
  return true
}

/**
 * Updates an existing Landslide Warning Beacon's risk level or data.
 */
export function updateLandslideWarningBeacon(viewer, id, updatedData) {
  const existing = activeBeacons.get(id)
  if (!existing) {
    // If not found, create new
    return createLandslideWarningBeacon(viewer, { id, ...updatedData })
  }

  const merged = {
    ...existing.rawOptions,
    ...updatedData,
    id,
  }

  removeLandslideWarningBeacon(viewer, id)
  return createLandslideWarningBeacon(viewer, merged)
}

/**
 * Clears all active warning beacons from the Cesium scene.
 */
export function clearAllLandslideWarningBeacons(viewer) {
  const ids = Array.from(activeBeacons.keys())
  ids.forEach(id => removeLandslideWarningBeacon(viewer, id))
  activeBeacons.clear()
}

/**
 * Returns all currently registered active warning beacons.
 */
export function getAllWarningBeacons() {
  return Array.from(activeBeacons.values())
}

/**
 * Smoothly flies the Cesium camera to focus on a specific beacon.
 */
export function flyToBeacon(viewer, id, options = {}) {
  const beacon = activeBeacons.get(id)
  if (!viewer || !beacon || !window.Cesium) return

  const Cesium = window.Cesium
  const offsetRadius = beacon.config.radius * 2.8

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      beacon.longitude,
      beacon.latitude - 0.012, // Slight tilt offset to see slope perspective
      offsetRadius
    ),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-40),
      roll: 0.0,
    },
    duration: options.duration ?? 1.8,
  })
}

/**
 * Modular ML API Prediction Ingestion Hook.
 * Accepts new inference output from external backend / ML model.
 * 
 * Example payload:
 * {
 *   "latitude": 27.533,
 *   "longitude": 88.612,
 *   "risk_probability": 0.87,
 *   "risk_level": "HIGH",
 *   "rainfall": "148 mm",
 *   "soil_moisture": "0.46"
 * }
 */
export function injectMLPrediction(viewer, prediction) {
  console.log('[CesiumBeaconManager] Ingested ML Landslide Prediction:', prediction)
  return createLandslideWarningBeacon(viewer, prediction)
}
