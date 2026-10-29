// ── Terrain Visualization Mode Architecture ──────────────────────────────────
// Separates the underlying LiDAR 3D terrain geometry (Z matrix) from the
// active visualization layer (Elevation, Soil Moisture, Slope).

export const VIZ_MODES = {
  ELEVATION: 'elevation',                     // Normal LiDAR / Elevation (Default)
  SOIL_MOISTURE: 'soil_moisture',             // NSIDC Soil Moisture layer
  SLOPE: 'slope',                             // Slope gradient (Planned)
  FACTOR_OF_SAFETY: 'fos',                    // Physics-based Infinite-Slope FoS (Model 3)
}

export const VIZ_MODE_CONFIGS = {
  [VIZ_MODES.ELEVATION]: {
    id: VIZ_MODES.ELEVATION,
    label: 'LiDAR / Elevation',
    shortLabel: 'Elevation',
    icon: '⛰️',
    legendTitle: 'ELEVATION (m)',
    legendSubtitle: 'ASL · Dynamic DEM Range',
    unit: 'm ASL',
    status: 'active',
    description: 'Bare-earth LiDAR digital elevation model colored continuously by height',
  },
  [VIZ_MODES.SOIL_MOISTURE]: {
    id: VIZ_MODES.SOIL_MOISTURE,
    label: 'Rain + Soil Moisture',
    shortLabel: 'Soil Moisture',
    icon: '🌧️',
    legendTitle: 'SOIL MOISTURE',
    legendSubtitle: 'm³/m³ · Hydrological Simulation',
    unit: 'm³/m³',
    status: 'active',
    description: 'Simulated rainfall infiltration and runoff-accumulated soil moisture',
  },
  [VIZ_MODES.SLOPE]: {
    id: VIZ_MODES.SLOPE,
    label: 'Slope Gradient',
    shortLabel: 'Slope',
    icon: '📐',
    legendTitle: 'SLOPE (°)',
    legendSubtitle: 'Topographic Inclination',
    unit: 'degrees',
    status: 'planned',
    description: 'Topographic slope angle derived from local elevation partial derivatives',
  },
}

// ── Pure Elevation Color Scale ───────────────────────────────────────────────
// Smooth continuous gradient:
// Lowest elevation (0.00) -> deep blue
// ~1500m (~0.13)         -> cyan
// ~1800m (~0.30)         -> green
// ~2100m (~0.46)         -> yellow
// ~2400m (~0.63)         -> golden yellow
// ~2700m (~0.79)         -> brown
// Highest (~3080m) (1.0) -> light beige / white
export const ELEVATION_COLORSCALE = [
  [0.0,   '#061a40'], // 0.00: Lowest elevation – deep navy/blue
  [0.05,  '#09316c'], // 0.05: deep blue transition
  [0.13,  '#00a8cc'], // 0.13: ~1500m – cyan
  [0.18,  '#05ba97'], // 0.18: cyan-green
  [0.24,  '#16a35a'], // 0.24: rich green
  [0.30,  '#2ca25f'], // 0.30: ~1800m – green
  [0.38,  '#80c326'], // 0.38: yellow-green
  [0.46,  '#ffeb3b'], // 0.46: ~2100m – yellow
  [0.54,  '#fec615'], // 0.54: warm yellow
  [0.63,  '#f39200'], // 0.63: ~2400m – golden yellow
  [0.71,  '#b85d10'], // 0.71: amber-brown
  [0.79,  '#783806'], // 0.79: ~2700m – brown
  [0.86,  '#99633e'], // 0.86: highland brown
  [0.93,  '#e2d7c9'], // 0.93: light beige
  [1.0,   '#ffffff'], // 1.00: 3080m – white (peak snow/summit)
]

// ── Model 2 Soil Saturation Continuous Physical Scale ───────────────────────
// Exact specified progression:
// LOW SATURATION  → LIGHT YELLOW (#FFF9C4, #FFF176, #FDE047)
// LOW–MEDIUM      → DARK YELLOW (#EAB308, #CA8A04)
// MEDIUM–HIGH     → DARK BLUE (#1E3A8A, #1E40AF)
// HIGH SATURATION → LIGHT BLUE (#0284C7, #38BDF8, #BAE6FD)
export const MODEL2_SATURATION_COLORSCALE = [
  // ── Low Saturation: Dry ridges / baseline moisture ──
  [0.00, '#FFF9C4'], // 0.00: Lowest saturation (0%) — Light Yellow
  [0.15, '#FFF176'], // 0.15: ~15% saturation — Light Yellow
  [0.25, '#FDE047'], // 0.25: ~25% saturation — Warm Light Yellow

  // ── Low–Medium Saturation: Infiltration & initial wetting ──
  [0.38, '#EAB308'], // 0.38: ~38% saturation — Dark Yellow
  [0.48, '#CA8A04'], // 0.48: ~48% saturation — Deep Dark Yellow / Amber

  // ── Medium–High Saturation: Active flow & high moisture accumulation ──
  [0.60, '#1E3A8A'], // 0.60: ~60% saturation — Dark Blue
  [0.72, '#1E40AF'], // 0.72: ~72% saturation — Deep Cobalt Blue
  [0.85, '#0284C7'], // 0.85: ~85% saturation — Cerulean Blue

  // ── High Saturation: Saturated hollows & water stream channels ──
  [0.94, '#38BDF8'], // 0.94: ~94% saturation — Light Blue
  [1.00, '#BAE6FD'], // 1.00: 100% saturation — Bright Light Sky Blue
]

export const MODEL2_BLUE_COLORSCALE = MODEL2_SATURATION_COLORSCALE
export const RAIN_SOIL_MOISTURE_COLORSCALE = MODEL2_SATURATION_COLORSCALE

// ── Model 4 Factor of Safety (FoS) Continuous Smooth Colorscale ──────────────
// Maps numeric FoS values [0.80, 6.00] with cmin=0.80, cmax=6.00:
//   FoS >= 5.50   → Upper Terrain Tips / Peaks (Moderately Dark Green #15803D - fresh & visible, never black)
//   FoS 4.80–5.40 → High Stability / Mid Slopes (Medium Green #22C55E)
//   FoS 4.00–4.80 → Lower Mid Slopes (Soft Green #4ADE80)
//   FoS 3.20–4.00 → Base / Low Terrain (Light Fresh Green #86EFAC)
//   FoS 2.50–3.20 → Infiltration Watch / Moderate Wetting (Light Yellow #FFEB3B / #FDE047)
//   FoS 1.80–2.50 → Watch / Marginal Stability (Dark Yellow #EAB308)
//   FoS 1.35–1.80 → High Risk Wet Slopes (Orange #F97316)
//   FoS 1.00–1.35 → Near-Critical Boundary (Dark Orange #EA580C)
//   FoS <= 1.00   → Critical Landslide Failure Limit (Vivid Red #EF4444 / Dark Red #B91C1C)
export const MODEL3_FOS_COLORSCALE = [
  [0.000000, '#B91C1C'], // <= 0.80: Dark Red (Potential Failure)
  [0.038462, '#EF4444'], // 1.00: Vivid Red (Critical Limit Equilibrium Threshold)
  [0.086538, '#EA580C'], // 1.25: Dark Orange (Near-Critical Boundary Transition)
  [0.153846, '#F97316'], // 1.60: Orange (High Risk)
  [0.230769, '#EAB308'], // 2.00: Dark Yellow (Watch / Marginal)
  [0.307692, '#FFEB3B'], // 2.40: Light Yellow (Infiltration Alert)
  [0.384615, '#A3E635'], // 2.80: Yellow-Lime Transition
  [0.461538, '#86EFAC'], // 3.20: Light Green (Initial Base Terrain)
  [0.615385, '#4ADE80'], // 4.00: Soft Green
  [0.769231, '#22C55E'], // 4.80: Medium Green (Initial Mid Slopes)
  [0.884615, '#16A34A'], // 5.40: Rich Green
  [1.000000, '#15803D'], // >= 6.00: Moderately Dark Green (Initial High Tips/Peaks — never black)
]

export const FOS_COLOR_STOPS = [
  { fos: 0.80, r: 185, g: 28,  b: 28,  hex: '#B91C1C', label: 'Potential Failure' },
  { fos: 1.00, r: 239, g: 68,  b: 68,  hex: '#EF4444', label: 'Critical Limit' },
  { fos: 1.25, r: 234, g: 88,  b: 12,  hex: '#EA580C', label: 'Dark Orange' },
  { fos: 1.60, r: 249, g: 115, b: 22,  hex: '#F97316', label: 'Orange' },
  { fos: 2.00, r: 234, g: 179, b: 8,   hex: '#EAB308', label: 'Dark Yellow' },
  { fos: 2.40, r: 255, g: 235, b: 59,  hex: '#FFEB3B', label: 'Light Yellow' },
  { fos: 2.80, r: 163, g: 230, b: 53,  hex: '#A3E635', label: 'Yellow-Lime' },
  { fos: 3.20, r: 134, g: 239, b: 172, hex: '#86EFAC', label: 'Light Green' },
  { fos: 4.00, r: 74,  g: 222, b: 128, hex: '#4ADE80', label: 'Soft Green' },
  { fos: 4.80, r: 34,  g: 197, b: 94,  hex: '#22C55E', label: 'Medium Green' },
  { fos: 5.40, r: 22,  g: 163, b: 74,  hex: '#16A34A', label: 'Rich Green' },
  { fos: 6.00, r: 21,  g: 128, b: 61,  hex: '#15803D', label: 'Moderately Dark Green' },
]

/**
 * Continuous RGB interpolation function for any arbitrary FoS value.
 * @param {number} fos - Computed factor of safety
 * @returns {string} CSS rgb(...) or hex color string
 */
export function getFoSContinuousColor(fos) {
  if (fos == null || isNaN(fos) || fos < 0) return '#4a6880'
  if (fos >= 6.00) return '#053315'
  if (fos <= 0.80) return '#B91C1C'

  for (let i = 0; i < FOS_COLOR_STOPS.length - 1; i++) {
    const s1 = FOS_COLOR_STOPS[i]
    const s2 = FOS_COLOR_STOPS[i + 1]
    if (fos >= s1.fos && fos <= s2.fos) {
      const frac = (fos - s1.fos) / (s2.fos - s1.fos)
      const r = Math.round(s1.r + frac * (s2.r - s1.r))
      const g = Math.round(s1.g + frac * (s2.g - s1.g))
      const b = Math.round(s1.b + frac * (s2.b - s1.b))
      return `rgb(${r}, ${g}, ${b})`
    }
  }
  return '#053315'
}

// Dynamic ticks for blue-based soil moisture legend
export function getSimulatedSoilMoistureTicks(minSM = 0.10, maxSM = 0.62) {
  const minV = Math.max(0.08, minSM)
  const maxV = Math.min(0.75, Math.max(minV + 0.1, maxSM))
  const span = maxV - minV

  return [
    { pct: 1.00, val: maxV, emoji: '🩵', label: 'VERY WET', colorDesc: 'light cyan' },
    { pct: 0.75, val: minV + 0.75 * span, emoji: '🌊', label: 'WET', colorDesc: 'cyan' },
    { pct: 0.50, val: minV + 0.50 * span, emoji: '🔷', label: 'MODERATE', colorDesc: 'blue-cyan' },
    { pct: 0.25, val: minV + 0.25 * span, emoji: '🔹', label: 'LOW', colorDesc: 'blue' },
    { pct: 0.00, val: minV, emoji: '⬛', label: 'DRY', colorDesc: 'dark blue' },
  ]
}

// ── Baseline soil-moisture colorscale (yellow → green → blue) ───────────────
export const SM_COLORSCALE = [
  [0.0,  '#FFFF00'], // dry – bright yellow
  [0.1,  '#CCFF00'],
  [0.2,  '#88FF00'],
  [0.3,  '#44FF00'],
  [0.4,  '#00FF22'],
  [0.5,  '#00FF88'],
  [0.6,  '#00FFCC'],
  [0.7,  '#00EEFF'],
  [0.8,  '#0099FF'],
  [0.9,  '#0033FF'],
  [1.0,  '#0000FF'], // saturated – bright blue
]

// ── Dynamic Elevation Ticks Calculator ───────────────────────────────────────
// Calculates the 7 key gradient stops based on actual min and max elevation.
export function getElevationTicks(minElevation, maxElevation) {
  const minE = minElevation ?? 1264
  const maxE = maxElevation ?? 3080
  const span = Math.max(1, maxE - minE)

  return [
    {
      pct: 1.00,
      val: maxE,
      label: `${Math.round(maxE)} m`,
      colorName: 'White',
      emoji: '⚪',
      role: 'Summit / Peak',
    },
    {
      pct: 0.79,
      val: minE + 0.79 * span,
      label: `${Math.round(minE + 0.79 * span)} m`,
      colorName: 'Brown',
      emoji: '🟤',
      role: 'Highland Ridge',
    },
    {
      pct: 0.63,
      val: minE + 0.63 * span,
      label: `${Math.round(minE + 0.63 * span)} m`,
      colorName: 'Golden Yellow',
      emoji: '🟡',
      role: 'Upper Slope',
    },
    {
      pct: 0.46,
      val: minE + 0.46 * span,
      label: `${Math.round(minE + 0.46 * span)} m`,
      colorName: 'Yellow',
      emoji: '🟨',
      role: 'Mid Elevation',
    },
    {
      pct: 0.30,
      val: minE + 0.30 * span,
      label: `${Math.round(minE + 0.30 * span)} m`,
      colorName: 'Green',
      emoji: '🟢',
      role: 'Lower Slope',
    },
    {
      pct: 0.13,
      val: minE + 0.13 * span,
      label: `${Math.round(minE + 0.13 * span)} m`,
      colorName: 'Cyan',
      emoji: '🩵',
      role: 'Foot Hills',
    },
    {
      pct: 0.00,
      val: minE,
      label: `${Math.round(minE)} m`,
      colorName: 'Deep Blue',
      emoji: '🔵',
      role: 'Valley Floor / Base',
    },
  ]
}

// ── Piecewise continuous color interpolator for Elevation ───────────────────
export function getElevationColor(elevation, minElevation, maxElevation) {
  const minE = minElevation ?? 1264
  const maxE = maxElevation ?? 3080
  const span = Math.max(1, maxE - minE)
  const norm = Math.max(0, Math.min(1, (elevation - minE) / span))

  // Color stops with RGB values for continuous linear interpolation
  const stops = [
    { at: 0.00, r:   6, g:  26, b:  64 }, // deep blue
    { at: 0.05, r:   9, g:  49, b: 108 },
    { at: 0.13, r:   0, g: 168, b: 204 }, // cyan
    { at: 0.18, r:   5, g: 186, b: 151 },
    { at: 0.24, r:  22, g: 163, b:  90 },
    { at: 0.30, r:  44, g: 162, b:  95 }, // green
    { at: 0.38, r: 128, g: 195, b:  38 },
    { at: 0.46, r: 255, g: 235, b:  59 }, // yellow
    { at: 0.54, r: 254, g: 198, b:  21 },
    { at: 0.63, r: 243, g: 146, b:   0 }, // golden yellow
    { at: 0.71, r: 184, g:  93, b:  16 },
    { at: 0.79, r: 120, g:  56, b:   6 }, // brown
    { at: 0.86, r: 153, g:  99, b:  62 },
    { at: 0.93, r: 226, g: 215, b: 201 }, // light beige
    { at: 1.00, r: 255, g: 255, b: 255 }, // white
  ]

  let lo = stops[0], hi = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (norm >= stops[i].at && norm <= stops[i + 1].at) {
      lo = stops[i]
      hi = stops[i + 1]
      break
    }
  }

  const sSpan = hi.at - lo.at
  const t = sSpan > 0 ? (norm - lo.at) / sSpan : 0
  const r = Math.round(lo.r + t * (hi.r - lo.r))
  const g = Math.round(lo.g + t * (hi.g - lo.g))
  const b = Math.round(lo.b + t * (hi.b - lo.b))
  const hex = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')

  return { hex, r, g, b, norm }
}

// ── Soil Moisture Color Utility (Preserved) ─────────────────────────────────
export function getSoilMoistureColor(moisture) {
  const v = Math.max(0, Math.min(1, moisture))

  const stops = [
    { at: 0.0, r: 255, g: 255, b:   0 },
    { at: 0.1, r: 204, g: 255, b:   0 },
    { at: 0.2, r: 136, g: 255, b:   0 },
    { at: 0.3, r:  68, g: 255, b:   0 },
    { at: 0.4, r:   0, g: 255, b:  34 },
    { at: 0.5, r:   0, g: 255, b: 136 },
    { at: 0.6, r:   0, g: 255, b: 204 },
    { at: 0.7, r:   0, g: 238, b: 255 },
    { at: 0.8, r:   0, g: 153, b: 255 },
    { at: 0.9, r:   0, g:  51, b: 255 },
    { at: 1.0, r:   0, g:   0, b: 255 },
  ]

  let lo = stops[0], hi = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (v >= stops[i].at && v <= stops[i + 1].at) {
      lo = stops[i]
      hi = stops[i + 1]
      break
    }
  }

  const span = hi.at - lo.at
  const t = span > 0 ? (v - lo.at) / span : 0
  const r = Math.round(lo.r + t * (hi.r - lo.r))
  const g = Math.round(lo.g + t * (hi.g - lo.g))
  const b = Math.round(lo.b + t * (hi.b - lo.b))
  const hex = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')

  const label =
    v < 0.05 ? 'Dry – Bright Yellow' :
    v < 0.15 ? 'Very Dry – Yellow-Green' :
    v < 0.25 ? 'Low – Greenish-Yellow' :
    v < 0.35 ? 'Low-Moderate – Green' :
    v < 0.45 ? 'Moderate – Bright Green' :
    v < 0.55 ? 'Moderate – Green-Cyan' :
    v < 0.65 ? 'Moist – Cyan-Green' :
    v < 0.75 ? 'Moist – Cyan' :
    v < 0.85 ? 'Wet – Blue-Cyan' :
    v < 0.95 ? 'Very Wet – Blue' : 'Saturated – Bright Blue'

  return { hex, label, r, g, b }
}
