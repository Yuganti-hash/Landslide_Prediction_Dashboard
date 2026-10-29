/**
 * mobileConfig.js
 * Centralized configuration for the mobile-only 3D DEM Viewer.
 * Keeps paths, camera presets, and rendering parameters isolated from desktop code.
 */

export const MOBILE_DEM_PATH = '/models/mobile/dem_mobile.json'
export const FALLBACK_DEM_PATH = '/terrain_web.json'

// Elevation color gradient matching the desktop LiDAR elevation visual scale
export const MOBILE_ELEVATION_STOPS = [
  { t: 0.00, hex: '#061a40', label: 'Valley Low' },
  { t: 0.05, hex: '#09316c' },
  { t: 0.13, hex: '#00a8cc', label: '~1500m' },
  { t: 0.18, hex: '#05ba97' },
  { t: 0.24, hex: '#16a35a' },
  { t: 0.30, hex: '#2ca25f', label: '~1800m' },
  { t: 0.38, hex: '#80c326' },
  { t: 0.46, hex: '#ffeb3b', label: '~2100m' },
  { t: 0.54, hex: '#fec615' },
  { t: 0.63, hex: '#f39200', label: '~2400m' },
  { t: 0.71, hex: '#b85d10' },
  { t: 0.79, hex: '#783806', label: '~2700m' },
  { t: 0.86, hex: '#99633e' },
  { t: 0.93, hex: '#e2d7c9' },
  { t: 1.00, hex: '#ffffff', label: 'Summit Peak' },
]

// Convert hex to rgb components [0..1]
function hexToRgb(hex) {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.substring(0, 2), 16) / 255
  const g = parseInt(clean.substring(2, 4), 16) / 255
  const b = parseInt(clean.substring(4, 6), 16) / 255
  return [r, g, b]
}

const PARSED_COLOR_STOPS = MOBILE_ELEVATION_STOPS.map((s) => ({
  t: s.t,
  rgb: hexToRgb(s.hex),
}))

/**
 * Returns RGB tuple [r, g, b] (0..1) for a normalized elevation ratio (0..1)
 */
export function getElevationColor(ratio) {
  const clamped = Math.max(0, Math.min(1, ratio))

  if (clamped <= PARSED_COLOR_STOPS[0].t) return PARSED_COLOR_STOPS[0].rgb
  const last = PARSED_COLOR_STOPS[PARSED_COLOR_STOPS.length - 1]
  if (clamped >= last.t) return last.rgb

  for (let i = 0; i < PARSED_COLOR_STOPS.length - 1; i++) {
    const s0 = PARSED_COLOR_STOPS[i]
    const s1 = PARSED_COLOR_STOPS[i + 1]
    if (clamped >= s0.t && clamped <= s1.t) {
      const f = (clamped - s0.t) / (s1.t - s0.t)
      return [
        s0.rgb[0] + f * (s1.rgb[0] - s0.rgb[0]),
        s0.rgb[1] + f * (s1.rgb[1] - s0.rgb[1]),
        s0.rgb[2] + f * (s1.rgb[2] - s0.rgb[2]),
      ]
    }
  }

  return PARSED_COLOR_STOPS[0].rgb
}

// Camera Presets
export const MOBILE_CAMERAS = {
  perspective: {
    position: { x: 0, y: 55, z: 75 },
    target: { x: 0, y: 0, z: 0 },
  },
  top: {
    position: { x: 0, y: 95, z: 0.1 },
    target: { x: 0, y: 0, z: 0 },
  },
}

// Mobile Performance Safeguards
export const PERF_CONFIG = {
  targetFPS: 60,
  lowFpsThreshold: 28,     // Automatically lower LOD if FPS remains below 28
  highFpsThreshold: 52,    // Upgrade LOD if FPS remains above 52
  checkIntervalMs: 1500,   // Check FPS trend every 1.5 seconds
  sampleWindow: 60,        // Frame samples to average
}
