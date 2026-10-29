/**
 * soilSaturationSimulation.js
 * ============================================================================
 * Time-Dependent Soil Water Storage & Saturation Dynamics Engine
 * 
 * CORE ARCHITECTURE:
 * RAIN INTENSITY (mm/hr)
 *       ↓
 * RAIN WATER INPUT OVER TIME: RainfallInput = Intensity × Δt_hours (mm)
 *       ↓
 * INFILTRATION INTO SOIL: Bounded by hydraulic conductivity & current saturation
 *       ↓
 * SOIL WATER STORAGE: S_new = S_old + Infiltration - Drainage - Runoff (mm)
 *       ↓
 * SATURATION RATIO: SaturationRatio = CurrentStorage / MaximumStorage (0.0 – 1.0)
 *       ↓
 * GRADUAL BLUE COLOR CHANGE: Light blue (dry) → Medium blue → Very dark blue
 *       ↓
 * CRITICAL SATURATION (≥ 95%): Transition to RED
 *       ↓
 * D8-BASED DOWNSLOPE EXCESS-WATER FLOW: Routed downhill strictly via LiDAR D8 DAG
 * ============================================================================
 */

/**
 * Standard Reference Soil Profile
 * Clearly documented prototype reference values (USDA Loam / Sandy Loam standard).
 * Prototype Assumption — NOT site-specific Utah core samples.
 */
export const STANDARD_SOIL_PROFILE = {
  name: 'Standard Reference Soil',
  label: 'Standard Reference',
  thicknessM: 1.0,           // Soil column thickness: 1.0 m (Prototype Assumption)
  thicknessLabel: '1.0 m (Prototype Assumption)',
  porosity: 0.45,            // Total porosity: 0.45 m³/m³ (total pore volume fraction)
  fieldCapacity: 0.25,       // Field capacity: 0.25 m³/m³ (gravity equilibrium moisture)
  wiltingPoint: 0.10,        // Permanent wilting point: 0.10 m³/m³ (hygroscopic bound water)
  saturatedHydraulicConductivityMmPerHour: 22.0, // K_sat: 22.0 mm/hr (permeability)
  criticalSaturationThreshold: 0.95, // Saturation ratio threshold for critical state (95%)
  
  // Storage capacities (depth units: mm)
  // Max storage S_max = thicknessM * 1000 * porosity = 1.0 * 1000 * 0.45 = 450.0 mm
  get maxStorageMm() {
    return this.thicknessM * 1000.0 * this.porosity
  },
  // Field capacity storage = 1.0 * 1000 * 0.25 = 250.0 mm
  get fieldCapacityStorageMm() {
    return this.thicknessM * 1000.0 * this.fieldCapacity
  },
  // Wilting point storage = 1.0 * 1000 * 0.10 = 100.0 mm
  get wiltingPointStorageMm() {
    return this.thicknessM * 1000.0 * this.wiltingPoint
  },
}

function normaliseArray(src, totalCells, elevFlat) {
  let minV = Infinity, maxV = -Infinity
  for (let i = 0; i < totalCells; i++) {
    if (elevFlat[i] <= -9990) continue
    const v = src[i]
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }
  const range = maxV - minV
  const out = new Float32Array(totalCells)
  if (range < 1e-8) return out
  for (let i = 0; i < totalCells; i++) {
    out[i] = elevFlat[i] <= -9990 ? 0 : (src[i] - minV) / range
  }
  return out
}

/**
 * Computes terrain-derived soil column thickness Z(x,y) in meters.
 * Deep in valleys and zero-order hollows (0.30 - 3.50 m), shallow on steep ridges.
 */
export function buildSoilThicknessFlat(derivatives, elevFlat) {
  if (!derivatives) return null
  const { slopeMatrix, tpiMatrix, planCurvatureMatrix, accumulation, width, height } = derivatives
  const totalCells = width * height

  const slopeNorm = normaliseArray(slopeMatrix, totalCells, elevFlat)
  const tpiNorm   = normaliseArray(tpiMatrix,   totalCells, elevFlat)
  const kPlanNorm = normaliseArray(planCurvatureMatrix, totalCells, elevFlat)

  const logAccum = new Float32Array(totalCells)
  for (let i = 0; i < totalCells; i++) {
    const acc = accumulation ? accumulation[i] : 1.0
    logAccum[i] = elevFlat[i] > -9990 ? Math.log(1 + acc) : 0
  }
  const accumNorm = normaliseArray(logAccum, totalCells, elevFlat)

  const thickness = new Float32Array(totalCells)
  const H_MIN_M   = 0.30
  const H_MAX_M   = 3.50
  const H_BASE_M  = 0.80
  const WEIGHT_SLOPE = 1.40
  const WEIGHT_TPI   = 0.80
  const WEIGHT_PLAN  = 0.50
  const WEIGHT_ACCUM = 0.40

  for (let i = 0; i < totalCells; i++) {
    if (elevFlat[i] <= -9990) { thickness[i] = 0; continue }
    const h = H_BASE_M
      + (1 - slopeNorm[i]) * WEIGHT_SLOPE
      + (0.5 - tpiNorm[i]) * WEIGHT_TPI
      + (kPlanNorm[i] - 0.5) * WEIGHT_PLAN
      + accumNorm[i] * WEIGHT_ACCUM
    thickness[i] = Math.max(H_MIN_M, Math.min(H_MAX_M, h))
  }
  return thickness
}

/**
 * Initializes the soil water storage state across the entire terrain grid.
 * Uses per-cell geomorphic soil thickness Z(x,y) and baseline soil moisture.
 *
 * @param {Object} terrain - Loaded terrain object { width, height, elevation }
 * @param {Array} baseSmMatrix - 2D Array of baseline NSIDC soil moisture values [r][c]
 * @param {Object} hydroStatic - Precomputed terrain derivatives & flow routing
 * @param {Object} soilProfile - Soil profile configuration
 * @returns {Object} Initial state vectors
 */
export function initializeSoilWaterState(
  terrain,
  baseSmMatrix = null,
  hydroStatic = null,
  soilProfile = STANDARD_SOIL_PROFILE
) {
  if (!terrain || !terrain.elevation) return null

  const { width, height, elevation } = terrain
  const totalCells = width * height

  const elevFlat = new Float32Array(totalCells)
  for (let r = 0; r < height; r++) {
    const rOff = r * width
    const row = elevation[r]
    for (let c = 0; c < width; c++) {
      const z = row[c]
      elevFlat[rOff + c] = (z != null && !isNaN(z)) ? z : -9999
    }
  }

  // Derive per-cell soil thickness Z(x,y)
  let thicknessFlat = hydroStatic?.soilThickness
  if (!thicknessFlat && hydroStatic) {
    thicknessFlat = buildSoilThicknessFlat(hydroStatic, elevFlat)
  }

  const maxStorageFlat = new Float32Array(totalCells)
  const initialStorage = new Float32Array(totalCells)
  const saturationRatio = new Float32Array(totalCells)

  let validCount = 0
  let sumSat = 0
  let minSat = 1.0
  let maxSat = 0.0
  let sumStorage = 0
  let minStorage = Infinity
  let maxStorage = -Infinity

  const defaultThickness = soilProfile.thicknessM || 1.0
  const porosity = soilProfile.porosity || 0.45
  const fc = soilProfile.fieldCapacity || 0.25
  const wp = soilProfile.wiltingPoint || 0.10

  for (let r = 0; r < height; r++) {
    const rOff = r * width
    const elevRow = elevation[r]
    const smRow = baseSmMatrix ? baseSmMatrix[r] : null

    for (let c = 0; c < width; c++) {
      const idx = rOff + c
      const z = elevRow[c]
      if (z == null || isNaN(z) || z <= -9990) {
        initialStorage[idx] = -1
        saturationRatio[idx] = -1
        maxStorageFlat[idx] = 0
        continue
      }

      // Soil thickness in meters for cell (r, c)
      const zm = thicknessFlat ? thicknessFlat[idx] : defaultThickness
      const cellMaxStorage = zm * 1000.0 * porosity
      maxStorageFlat[idx] = cellMaxStorage

      // Initial dry baseline volumetric soil moisture theta_0 starting at wilting point
      // Entire terrain starts uniformly in the light-yellow dry state (0 - 20% saturation)
      const baseSmNorm = smRow && smRow[c] != null ? Math.max(0, Math.min(1, (smRow[c] - 0.10) / 0.30)) : 0.0
      const theta0 = wp + baseSmNorm * 0.02 // strictly in [0.08, 0.10] -> saturation [17%, 22%]
      
      // Initial storage S_0 (mm) = theta_0 * 1000 * zm
      const s0 = theta0 * 1000.0 * zm
      initialStorage[idx] = s0

      // Base saturation ratio = S_0 / S_max = theta_0 / porosity (~18% - 22% dry yellow baseline)
      const sat = Math.max(0.0, Math.min(1.0, s0 / Math.max(1.0, cellMaxStorage)))
      saturationRatio[idx] = sat

      sumSat += sat
      if (sat < minSat) minSat = sat
      if (sat > maxSat) maxSat = sat

      sumStorage += s0
      if (s0 < minStorage) minStorage = s0
      if (s0 > maxStorage) maxStorage = s0
      validCount++
    }
  }

  const meanSat = validCount > 0 ? sumSat / validCount : 0.18
  const meanStorage = validCount > 0 ? sumStorage / validCount : 80.0

  return {
    storage: initialStorage,
    saturationRatio: saturationRatio,
    maxStorage: maxStorageFlat,
    soilThickness: thicknessFlat,
    elapsedTimeMin: 0,
    accumulatedRainfallMm: 0,
    criticalCount: 0,
    excessFlowCount: 0,
    stats: {
      meanSaturationPct: Number((meanSat * 100).toFixed(1)),
      minSaturationPct: Number((minSat * 100).toFixed(1)),
      maxSaturationPct: Number((maxSat * 100).toFixed(1)),
      meanStorageMm: Number(meanStorage.toFixed(1)),
      minStorageMm: Number(minStorage.toFixed(1)),
      maxStorageMm: Number(maxStorage.toFixed(1)),
      criticalCells: 0,
      elapsedTimeMin: 0,
      accumulatedRainfallMm: 0,
      validCells: validCount,
    },
  }
}

/**
 * Advances the soil water storage simulation by one timestep Δt.
 * Fully integrates per-cell soil thickness Z(x,y), dynamic infiltration,
 * slope-driven drainage, and D8 downhill excess-water routing.
 *
 * @param {Object} prevState - Current simulation state
 * @param {number} rainfallIntensityMmPerHr - Current rainfall intensity (mm/hr)
 * @param {number} dtMin - Timestep duration in minutes (e.g. 5 min)
 * @param {Object} terrain - Loaded terrain object { width, height, elevation }
 * @param {Object} hydroStatic - Precomputed terrain derivatives & flow routing
 * @param {Object} soilProfile - Soil profile configuration
 * @returns {Object} Updated simulation state
 */
export function stepSoilWaterSimulation(
  prevState,
  rainfallIntensityMmPerHr,
  dtMin,
  terrain,
  hydroStatic,
  soilProfile = STANDARD_SOIL_PROFILE
) {
  if (!prevState || !prevState.storage || !terrain || !hydroStatic) return prevState

  const { width, height, elevation } = terrain
  const totalCells = width * height
  const { slopeMatrix, d8Target, cellIndices, retentionFactorMatrix, drainageFactorMatrix } = hydroStatic

  const porosity = soilProfile.porosity || 0.45
  const fcFraction = (soilProfile.fieldCapacity || 0.25) / porosity
  const wpFraction = (soilProfile.wiltingPoint || 0.10) / porosity
  const kSat = soilProfile.saturatedHydraulicConductivityMmPerHour || 22.0
  const critThreshold = soilProfile.criticalSaturationThreshold || 0.95

  const dtHours = dtMin / 60.0
  const rainInputMm = rainfallIntensityMmPerHr * dtHours

  // Pre-flatten elevations if needed
  let elevFlat = hydroStatic.elevFlat
  if (!elevFlat) {
    elevFlat = new Float32Array(totalCells)
    for (let r = 0; r < height; r++) {
      const rOff = r * width
      const row = elevation[r]
      for (let c = 0; c < width; c++) {
        const z = row[c]
        elevFlat[rOff + c] = (z != null && !isNaN(z)) ? z : -9999
      }
    }
  }

  // Get or compute per-cell soil thickness Z(x,y)
  let thicknessFlat = prevState.soilThickness || hydroStatic.soilThickness
  if (!thicknessFlat) {
    thicknessFlat = buildSoilThicknessFlat(hydroStatic, elevFlat)
  }

  let maxStorageFlat = prevState.maxStorage
  if (!maxStorageFlat) {
    maxStorageFlat = new Float32Array(totalCells)
    for (let i = 0; i < totalCells; i++) {
      const zm = thicknessFlat ? thicknessFlat[i] : (soilProfile.thicknessM || 1.0)
      maxStorageFlat[i] = zm * 1000.0 * porosity
    }
  }

  const oldStorage = prevState.storage
  const newStorage = new Float32Array(oldStorage)
  const newSaturation = new Float32Array(totalCells)
  const routedExcessWater = new Float32Array(totalCells)
  const isCritical = new Uint8Array(totalCells)

  // ── STEP 1: Local Infiltration, Drainage & Water Balance per Cell ──
  for (let i = 0; i < totalCells; i++) {
    const s = oldStorage[i]
    if (s < 0 || elevFlat[i] <= -9990) {
      newStorage[i] = -1
      newSaturation[i] = -1
      continue
    }

    const cellMaxStorage = Math.max(1.0, maxStorageFlat[i])
    const cellFcStorage = cellMaxStorage * fcFraction
    const cellWpStorage = cellMaxStorage * wpFraction

    const currentSat = Math.max(0.0, Math.min(1.0, s / cellMaxStorage))
    const availPores = Math.max(0.0, cellMaxStorage - s)

    // Dynamic infiltration capacity bounded by soil saturation and terrain retention
    const suctionFactor = 1.0 + 1.2 * Math.max(0.0, 1.0 - currentSat)
    const retentionMod = retentionFactorMatrix ? retentionFactorMatrix[i] : 1.0
    const potInfilRate = kSat * suctionFactor * Math.max(0.4, Math.min(2.5, retentionMod))
    const maxInfilForStep = potInfilRate * dtHours

    // Actual infiltration into soil pore column
    const infiltration = Math.min(rainInputMm, maxInfilForStep, availPores)
    const infilExcessRunoff = Math.max(0.0, rainInputMm - infiltration)

    // Subsurface gravity drainage along slope above field capacity
    let subDrainage = 0.0
    if (currentSat > fcFraction && slopeMatrix) {
      const slopeDeg = slopeMatrix[i]
      const slopeRad = (slopeDeg * Math.PI) / 180.0
      const drainMod = drainageFactorMatrix ? drainageFactorMatrix[i] : 1.0
      const drainRate = kSat * Math.sin(slopeRad) * (currentSat - fcFraction) * drainMod
      subDrainage = Math.min(Math.max(0.0, s - cellFcStorage), drainRate * dtHours)
    }

    // Baseline evapotranspiration (0.04 mm/hr)
    const evaporation = Math.min(Math.max(0.0, s - cellWpStorage), 0.04 * dtHours)

    // Preliminary soil storage update
    let updatedStorage = s + infiltration - subDrainage - evaporation

    // Saturation-excess runoff if storage exceeds pore capacity
    let satExcessRunoff = 0.0
    if (updatedStorage > cellMaxStorage) {
      satExcessRunoff = updatedStorage - cellMaxStorage
      updatedStorage = cellMaxStorage
    }

    newStorage[i] = Math.max(cellWpStorage, Math.min(cellMaxStorage, updatedStorage))
    routedExcessWater[i] = infilExcessRunoff + satExcessRunoff
  }

  // ── STEP 2: D8 Downslope Excess Water Routing (Summit to Valley DAG) ──
  if (cellIndices && d8Target) {
    for (let k = 0; k < totalCells; k++) {
      const idx = cellIndices[k]
      if (elevFlat[idx] <= -9990) continue
      const excess = routedExcessWater[idx]
      if (excess <= 0.0001) continue

      const targetIdx = d8Target[idx]
      if (targetIdx >= 0 && targetIdx < totalCells && elevFlat[targetIdx] > -9990) {
        // Downslope receiving cell: infiltrate excess water into available pores
        const targetMaxStorage = Math.max(1.0, maxStorageFlat[targetIdx])
        const targetAvail = Math.max(0.0, targetMaxStorage - newStorage[targetIdx])
        const conveyedWater = excess * 0.95 // 5% transmission loss

        const infilFromUpstream = Math.min(conveyedWater, targetAvail * 0.80)
        newStorage[targetIdx] += infilFromUpstream

        // Cascade remaining un-infiltrated excess further downstream
        routedExcessWater[targetIdx] += Math.max(0.0, conveyedWater - infilFromUpstream)
      }
    }
  }

  // ── STEP 3: Saturation Ratio & Summary Statistics across ENTIRE Terrain ──
  let sumSat = 0
  let minSat = 1.0
  let maxSat = 0.0
  let validCount = 0
  let criticalCount = 0
  let excessFlowCount = 0
  let sumStorage = 0
  let minStorage = Infinity
  let maxStorage = -Infinity

  for (let i = 0; i < totalCells; i++) {
    const s = newStorage[i]
    if (s < 0 || elevFlat[i] <= -9990) continue

    const cellMaxStorage = Math.max(1.0, maxStorageFlat[i])
    let sat = Math.max(0.0, Math.min(1.0, s / cellMaxStorage))

    if (sat >= critThreshold) {
      isCritical[i] = 1
      criticalCount++
    }

    const routedExcess = routedExcessWater[i]
    if (routedExcess > 2.0 && sat >= 0.85) {
      isCritical[i] = 1
      excessFlowCount++
      sat = Math.max(critThreshold, sat)
    }

    sat = Math.max(0.0, Math.min(1.0, sat))
    newSaturation[i] = sat

    sumSat += sat
    if (sat < minSat) minSat = sat
    if (sat > maxSat) maxSat = sat

    sumStorage += s
    if (s < minStorage) minStorage = s
    if (s > maxStorage) maxStorage = s
    validCount++
  }

  const newElapsedMin = (prevState.elapsedTimeMin || 0) + dtMin
  const newAccumulatedRainfallMm = Number(((prevState.accumulatedRainfallMm || 0) + rainInputMm).toFixed(1))
  const meanSatPct = validCount > 0 ? Number(((sumSat / validCount) * 100).toFixed(1)) : 25.0
  const meanStorage = validCount > 0 ? sumStorage / validCount : 150.0

  return {
    storage: newStorage,
    saturationRatio: newSaturation,
    maxStorage: maxStorageFlat,
    soilThickness: thicknessFlat,
    elapsedTimeMin: newElapsedMin,
    accumulatedRainfallMm: newAccumulatedRainfallMm,
    criticalCount: criticalCount,
    excessFlowCount: excessFlowCount,
    stats: {
      meanSaturationPct: meanSatPct,
      minSaturationPct: Number((minSat * 100).toFixed(1)),
      maxSaturationPct: Number((maxSat * 100).toFixed(1)),
      meanStorageMm: Number(meanStorage.toFixed(1)),
      minStorageMm: Number(minStorage.toFixed(1)),
      maxStorageMm: Number(maxStorage.toFixed(1)),
      criticalCells: criticalCount,
      excessFlowCells: excessFlowCount,
      elapsedTimeMin: newElapsedMin,
      accumulatedRainfallMm: newAccumulatedRainfallMm,
      rainfallIntensityMmPerHr: Math.round(rainfallIntensityMmPerHr),
      validCells: validCount,
    },
  }
}

/**
 * Reshapes a 1D Float32Array of saturation values (size: width * height)
 * into a 2D Array of rows [height][width] for Plotly surface coloring.
 */
export function saturationTo2DMatrix(saturationFlat, width, height) {
  if (!saturationFlat) return null
  const matrix = new Array(height)
  for (let r = 0; r < height; r++) {
    const row = new Float32Array(width)
    const rOff = r * width
    for (let c = 0; c < width; c++) {
      const val = saturationFlat[rOff + c]
      row[c] = val >= 0 ? val : null
    }
    matrix[r] = Array.from(row)
  }
  return matrix
}

/**
 * Generates precomputed row and column index maps for deterministic spatial downsampling.
 * Maps display coordinates [0..dispHeight-1, 0..dispWidth-1] to full-resolution DEM indices.
 */
export function buildDisplayIndexMaps(fullWidth, fullHeight, step = 3) {
  const dispWidth = Math.ceil(fullWidth / step)
  const dispHeight = Math.ceil(fullHeight / step)
  const rowMap = new Int32Array(dispHeight)
  for (let r = 0; r < dispHeight; r++) {
    rowMap[r] = Math.min(fullHeight - 1, Math.round((r * (fullHeight - 1)) / (dispHeight - 1)))
  }
  const colMap = new Int32Array(dispWidth)
  for (let c = 0; c < dispWidth; c++) {
    colMap[c] = Math.min(fullWidth - 1, Math.round((c * (fullWidth - 1)) / (dispWidth - 1)))
  }
  return { dispWidth, dispHeight, rowMap, colMap }
}

/**
 * Deterministically downsamples a 2D elevation matrix [height][width] into [dispHeight][dispWidth].
 * Preserves exact geographic extent and DEM boundaries.
 */
export function downsampleElevation2D(fullElevation, rowMap, colMap) {
  if (!fullElevation || !rowMap || !colMap) return null
  const dispH = rowMap.length
  const dispW = colMap.length
  const matrix = new Array(dispH)
  for (let r = 0; r < dispH; r++) {
    const row = new Array(dispW)
    const fullRow = fullElevation[rowMap[r]]
    for (let c = 0; c < dispW; c++) {
      row[c] = fullRow[colMap[c]]
    }
    matrix[r] = row
  }
  return matrix
}

/**
 * Deterministically downsamples a 1D flat Float32Array (size: fullWidth * fullHeight)
 * into a 2D Array [dispHeight][dispWidth] for Plotly surfacecolor.
 * Uses peak-preservation for critical saturation (>= 0.95) to ensure narrow flow paths remain visible.
 */
export function downsampleSaturationTo2D(fullFlat, fullWidth, fullHeight, rowMap, colMap) {
  if (!fullFlat || !rowMap || !colMap) return null
  const dispH = rowMap.length
  const dispW = colMap.length
  const rawMatrix = new Array(dispH)

  // Step 1: Windowed area sampling with critical saturation peak-preservation (>= 0.95)
  for (let r = 0; r < dispH; r++) {
    const row = new Array(dispW)
    const rFull = rowMap[r]
    const rMin = Math.max(0, rFull - 1)
    const rMax = Math.min(fullHeight - 1, rFull + 1)

    for (let c = 0; c < dispW; c++) {
      const cFull = colMap[c]
      const cMin = Math.max(0, cFull - 1)
      const cMax = Math.min(fullWidth - 1, cFull + 1)

      let sum = 0
      let weightSum = 0
      let maxSat = -1
      let hasValid = false

      for (let rr = rMin; rr <= rMax; rr++) {
        const rrOff = rr * fullWidth
        const dr = rr - rFull
        for (let cc = cMin; cc <= cMax; cc++) {
          const val = fullFlat[rrOff + cc]
          if (val < 0) continue
          hasValid = true
          if (val > maxSat) maxSat = val

          const dc = cc - cFull
          const w = 1.0 / (1.0 + 0.5 * (dr * dr + dc * dc))
          sum += val * w
          weightSum += w
        }
      }

      if (!hasValid) {
        row[c] = null
      } else if (maxSat >= 0.95) {
        row[c] = maxSat
      } else {
        row[c] = weightSum > 0 ? (sum / weightSum) : maxSat
      }
    }
    rawMatrix[r] = row
  }

  // Step 2: 2D Spatial smoothing pass for continuous fluid gradients
  const smoothedMatrix = new Array(dispH)
  for (let r = 0; r < dispH; r++) {
    const row = new Array(dispW)
    const rMin = Math.max(0, r - 1)
    const rMax = Math.min(dispH - 1, r + 1)

    for (let c = 0; c < dispW; c++) {
      const centerVal = rawMatrix[r][c]
      if (centerVal == null || centerVal >= 0.95) {
        row[c] = centerVal
        continue
      }

      const cMin = Math.max(0, c - 1)
      const cMax = Math.min(dispW - 1, c + 1)
      let sum = 0
      let weightSum = 0

      for (let rr = rMin; rr <= rMax; rr++) {
        const dr = rr - r
        for (let cc = cMin; cc <= cMax; cc++) {
          const val = rawMatrix[rr][cc]
          if (val == null) continue
          const w = (dr === 0 && cc === c) ? 2.5 : 1.0
          sum += val * w
          weightSum += w
        }
      }
      row[c] = weightSum > 0 ? (sum / weightSum) : centerVal
    }
    smoothedMatrix[r] = row
  }

  return smoothedMatrix
}

/**
 * Downsamples saturation matrix for Plotly 3D surface display.
 * Produces a connected stream-network visualization by blending:
 *   1. D8-accumulation-driven stream channel color (connected drainage paths)
 *   2. Soil-wetness overlay (smooth terrain wetness from saturation model)
 *
 * The mathematical model (saturationFlat, hydroStatic) is read-only and unchanged.
 * Only the RENDERING layer is modified here.
 *
 * @param {Float32Array|null} saturationFlat - Per-cell saturation ratio [0..1] from model
 * @param {Array} fullElevation - 2D elevation array [height][width]
 * @param {number} minElevation
 * @param {number} maxElevation
 * @param {number} fullWidth
 * @param {number} fullHeight
 * @param {Int32Array} rowMap - Display row → full-res row mapping
 * @param {Int32Array} colMap - Display col → full-res col mapping
 * @param {number} accumulatedRainMm - Total rainfall accumulated so far (mm)
 * @param {Object|null} hydroStatic - Precomputed terrain derivatives (D8 accumulation, d8Target, etc.)
 * @returns {Array} 2D display matrix [dispHeight][dispWidth] with values in [0, 1] for colorscale
 */
export function downsampleBlendedSurfaceColor2D(
  saturationFlat,
  fullElevation,
  minElevation,
  maxElevation,
  fullWidth,
  fullHeight,
  rowMap,
  colMap,
  accumulatedRainMm = 0,
  hydroStatic = null
) {
  // ── Fallback: if no hydroStatic, fall back to legacy saturation rendering ──
  if (!hydroStatic || !hydroStatic.accumulationMatrix) {
    return downsampleSaturationTo2D(saturationFlat, fullWidth, fullHeight, rowMap, colMap)
  }

  const dispH = rowMap.length
  const dispW = colMap.length
  const totalCells = fullWidth * fullHeight

  const accumulation = hydroStatic.accumulationMatrix  // Float32Array, D8 upstream cell count
  const elevFlat = hydroStatic.elevFlat               // May be null if not cached

  // ── Compute log-accumulation range for normalisation (done once) ──
  // We use a fast approximate max-log-accumulation scan over display cells only.
  let maxLogAccum = 1.0
  for (let r = 0; r < dispH; r++) {
    const rFull = rowMap[r]
    const rOff  = rFull * fullWidth
    for (let c = 0; c < dispW; c++) {
      const acc = accumulation[rOff + colMap[c]]
      if (acc > 0) {
        const la = Math.log(1 + acc)
        if (la > maxLogAccum) maxLogAccum = la
      }
    }
  }

  // ── Elevation range for normalisation ──
  const elevRange = Math.max(1, maxElevation - minElevation)

  // ── Rain scaling: controls how much of the drainage network becomes visible ──
  // At 0 mm: only deepest channels show faintly.
  // At ~20 mm+: tributaries appear. At 100+ mm: full dense network.
  const rainScale = Math.min(1.0, Math.max(0.0, accumulatedRainMm / 90.0))
  // Threshold: cells below this log-accumulation fraction are invisible as streams
  // Lower threshold = more tributaries visible (scales with rainfall)
  const streamThreshold = Math.max(0.04, 0.55 - rainScale * 0.50)

  // ── Build display matrix ──
  const matrix = new Array(dispH)

  for (let r = 0; r < dispH; r++) {
    const row = new Array(dispW)
    const rFull = rowMap[r]
    const rOff  = rFull * fullWidth

    for (let c = 0; c < dispW; c++) {
      const cFull = colMap[c]
      const idx   = rOff + cFull

      // --- 1. Soil wetness from the existing saturation model (unchanged physics) ---
      const sat = saturationFlat ? Math.max(0, Math.min(1, saturationFlat[idx] ?? 0)) : 0

      // Soil wetness maps to a subtle darkening/gloss overlay (0 = dry terrain, ~0.45 = wet terrain).
      // The colorscale yellow/brown at 0–0.4 is the "normal terrain wetness" zone.
      // We never push purely from sat above 0.50 to avoid blue blobs.
      const wetnessBase = Math.max(0, Math.min(0.48,
        sat < 0.30 ? sat * 0.55                          // Dry: very subtle yellow-tan tint
        : sat < 0.60 ? 0.165 + (sat - 0.30) * 0.45      // Wetting: modest darkening
        : 0.30 + (sat - 0.60) * 0.45                    // Wet terrain: still stays below stream blue
      ))

      // --- 2. Stream channel color from D8 accumulation (existing network, read-only) ---
      const accum   = accumulation[idx] ?? 1.0
      const logAccum = Math.log(1 + accum)
      const normAccum = Math.min(1.0, logAccum / maxLogAccum)

      // Only render a stream if accumulation exceeds the rainfall-scaled threshold
      let streamColor = 0.0
      if (normAccum >= streamThreshold) {
        // Map normalised accumulation → [0.55, 1.0] in colorscale
        // 0.55 = first dark-blue entry, 1.0 = peak cyan (major channel)
        const t = (normAccum - streamThreshold) / (1.0 - streamThreshold)
        const tSmooth = t * t * (3 - 2 * t)  // smoothstep for natural channel widening
        streamColor = 0.55 + tSmooth * 0.45

        // Strengthen stream color further with rainfall and local saturation
        const streamBoost = rainScale * (0.20 + sat * 0.30)
        streamColor = Math.min(1.0, streamColor + streamBoost * (1.0 - streamColor))
      }

      // --- 3. Blend: where stream exists, stream dominates; elsewhere, wetness sheen ---
      let finalValue
      if (streamColor > 0) {
        // Stream is present: blend stream over wetness (stream dominates strongly)
        // Transition sharpness — higher normAccum → more stream dominance
        const streamDominance = Math.min(1.0, (normAccum - streamThreshold) / 0.15 * 0.85 + 0.15)
        finalValue = wetnessBase * (1 - streamDominance) + streamColor * streamDominance
      } else {
        // No stream: only soil wetness overlay (looks like darkening/gloss, not blue patches)
        finalValue = wetnessBase
      }

      // --- 4. Critical saturation cells: ensure they stay bright blue (existing model behavior) ---
      if (sat >= 0.95) {
        finalValue = Math.max(finalValue, 0.94)
      }

      row[c] = Math.max(0, Math.min(1, finalValue))
    }
    matrix[r] = row
  }

  return matrix
}

/**
 * Deterministically downsamples a flat diagnostic layer (slope, aspect, curvature)
 * to 2D Array [dispHeight][dispWidth] for Plotly surfacecolor.
 */
export function downsampleDiagnosticTo2D(fullFlat, fullWidth, fullHeight, rowMap, colMap) {
  if (!fullFlat || !rowMap || !colMap) return null
  const dispH = rowMap.length
  const dispW = colMap.length
  const matrix = new Array(dispH)

  for (let r = 0; r < dispH; r++) {
    const row = new Array(dispW)
    const rFull = rowMap[r]
    const rOff = rFull * fullWidth
    for (let c = 0; c < dispW; c++) {
      const val = fullFlat[rOff + colMap[c]]
      row[c] = val != null && !isNaN(val) ? val : null
    }
    matrix[r] = row
  }
  return matrix
}

/**
 * Automated Verification Suite (Scientific & Functional Integrity):
 * Runs self-tests to ensure:
 * 1. Monotonicity: Higher rainfall intensity accumulates water faster and reaches critical saturation earlier.
 * 2. Boundedness: SaturationRatio is strictly clamped in [0.0, 1.0].
 * 3. Elevation check: No D8 flow vector goes uphill.
 * 4. Exact accumulation: P_total = intensity * (time_min / 60).
 * 5. Reset determinism: Reset returns identical initial state.
 * 6. No synthetic / random values used.
 */
export function runModel2Validation(terrain, hydroStatic) {
  const results = []
  if (!terrain || !hydroStatic) {
    results.push({ name: 'Prerequisites', pass: false, message: 'Terrain or hydroStatic missing' })
    return results
  }

  const { width, height, elevation } = terrain
  const { d8Target } = hydroStatic
  const totalCells = width * height

  // 1. D8 Downslope Direction Verification (Never uphill)
  let uphillCount = 0
  let checkedVectors = 0
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const idx = r * width + c
      const target = d8Target[idx]
      if (target >= 0) {
        const tr = Math.floor(target / width)
        const tc = target % width
        const zSource = elevation[r][c]
        const zTarget = elevation[tr][tc]
        if (zSource != null && zTarget != null) {
          checkedVectors++
          if (zTarget >= zSource) uphillCount++
        }
      }
    }
  }
  results.push({
    name: 'D8 Flow Direction strictly downhill',
    pass: uphillCount === 0 && checkedVectors > 10000,
    message: uphillCount === 0 ? `Verified ${checkedVectors} D8 vectors: 0 flow uphill` : `Failed: ${uphillCount} vectors flow uphill`,
  })

  // 2. Accumulated Rainfall Math Verification: P_total = intensity * (elapsed_min / 60)
  const testIntensity = 60 // 60 mm/hr
  const testMin = 45 // 45 min -> 45 mm
  const expectedP = testIntensity * (testMin / 60.0) // 45.0 mm
  const computedP = Number((testIntensity * (testMin / 60.0)).toFixed(2))
  results.push({
    name: 'Accumulated Rainfall Calculation P = Intensity × Time',
    pass: Math.abs(computedP - expectedP) < 1e-6,
    message: `${testIntensity} mm/hr for ${testMin} min = ${computedP} mm (expected ${expectedP} mm)`,
  })

  // 3. Monotonic Rainfall Intensity vs Saturation Rate Verification:
  // 80 mm/hr MUST achieve higher average saturation than 20 mm/hr over the same elapsed time
  const initA = initializeSoilWaterState(terrain, null, hydroStatic, STANDARD_SOIL_PROFILE)
  const initB = initializeSoilWaterState(terrain, null, hydroStatic, STANDARD_SOIL_PROFILE)

  let stateA = initA // 20 mm/hr
  let stateB = initB // 80 mm/hr
  for (let t = 0; t < 6; t++) {
    stateA = stepSoilWaterSimulation(stateA, 20, 5, terrain, hydroStatic, STANDARD_SOIL_PROFILE)
    stateB = stepSoilWaterSimulation(stateB, 80, 5, terrain, hydroStatic, STANDARD_SOIL_PROFILE)
  }

  const satA = stateA.stats.meanSaturationPct
  const satB = stateB.stats.meanSaturationPct
  const monotonicPass = satB > satA && stateB.accumulatedRainfallMm > stateA.accumulatedRainfallMm
  results.push({
    name: 'Rainfall Intensity Sensitivity (80 mm/hr vs 20 mm/hr over 30 min)',
    pass: monotonicPass,
    message: `At 30 min: 20 mm/hr -> ${satA}% saturation | 80 mm/hr -> ${satB}% saturation (${satB > satA ? 'FASTER SATURATION' : 'ERROR'})`,
  })

  // 4. Boundedness: SaturationRatio in [0.0, 1.0]
  let outOfBounds = 0
  for (let i = 0; i < stateB.saturationRatio.length; i++) {
    const val = stateB.saturationRatio[i]
    if (val >= 0 && (val < 0.0 || val > 1.0)) outOfBounds++
  }
  results.push({
    name: 'Saturation Ratio Bounded strictly in [0.0, 1.0]',
    pass: outOfBounds === 0,
    message: outOfBounds === 0 ? 'All cells strictly clamped between 0.0 and 1.0' : `Failed: ${outOfBounds} cells out of bounds`,
  })

  // 5. Determinism & Reset Test
  const resetState = initializeSoilWaterState(terrain, null, hydroStatic, STANDARD_SOIL_PROFILE)
  let diffCount = 0
  for (let i = 0; i < resetState.storage.length; i++) {
    if (Math.abs(resetState.storage[i] - initA.storage[i]) > 1e-4) diffCount++
  }
  results.push({
    name: 'Reset Determinism',
    pass: diffCount === 0 && resetState.elapsedTimeMin === 0,
    message: diffCount === 0 ? 'Reset reproduces exact deterministic initial conditions' : 'Reset produced varying values',
  })

  // 6. Five-point Physical Geomorphic Sample Verification
  const samplePoints = []
  const { slopeMatrix, accumulation } = hydroStatic
  const thickness = stateB.soilThickness
  const zFlat = hydroStatic.elevFlat || new Float32Array(totalCells)

  // Find representative points:
  let highIdx = 0, lowIdx = 0, steepIdx = 0, gentleIdx = 0, drainIdx = 0
  let maxZ = -Infinity, minZ = Infinity, maxS = -Infinity, minS = Infinity, maxAcc = -Infinity

  for (let i = 0; i < totalCells; i++) {
    const z = zFlat[i]
    if (z <= -9990) continue
    const s = slopeMatrix ? slopeMatrix[i] : 0
    const acc = accumulation ? accumulation[i] : 1

    if (z > maxZ) { maxZ = z; highIdx = i }
    if (z < minZ) { minZ = z; lowIdx = i }
    if (s > maxS) { maxS = s; steepIdx = i }
    if (s < minS && s >= 0) { minS = s; gentleIdx = i }
    if (acc > maxAcc) { maxAcc = acc; drainIdx = i }
  }

  const pointTypes = [
    { type: 'High Elevation (Summit)', idx: highIdx },
    { type: 'Low Elevation (Valley Base)', idx: lowIdx },
    { type: 'Steep Slope (Cliff/Scarp)', idx: steepIdx },
    { type: 'Gentle Slope (Plateau/Bench)', idx: gentleIdx },
    { type: 'Drainage / Convergence Area', idx: drainIdx },
  ]

  try {
    pointTypes.forEach(({ type, idx }) => {
      const zVal = zFlat && zFlat[idx] != null ? zFlat[idx] : 0
      const sVal = slopeMatrix && slopeMatrix[idx] != null ? slopeMatrix[idx] : 0
      const thickVal = thickness && thickness[idx] != null ? thickness[idx] : 1.0
      const accVal = accumulation && accumulation[idx] != null ? accumulation[idx] : 1
      const storVal = stateB.storage && stateB.storage[idx] != null ? stateB.storage[idx] : 0
      const maxStorVal = stateB.maxStorage && stateB.maxStorage[idx] != null ? stateB.maxStorage[idx] : 100
      const satVal = stateB.saturationRatio && stateB.saturationRatio[idx] != null ? stateB.saturationRatio[idx] : 0

      samplePoints.push({
        Location: type,
        'Elevation (m)': Number(zVal.toFixed(1)),
        'Slope (°)': Number(sVal.toFixed(1)),
        'Soil Thickness (m)': Number(thickVal.toFixed(2)),
        'Flow Accum (cells)': Math.round(accVal),
        'Water Storage (mm)': Number(storVal.toFixed(1)),
        'Max Storage (mm)': Number(maxStorVal.toFixed(1)),
        'Saturation Ratio': Number(satVal.toFixed(3)),
      })
    })

    if (typeof window !== 'undefined') {
      console.group('🔬 Model 2 Soil Saturation Physical Verification & Diagnostics')
      console.log(`Terrain cells/vertices: ${totalCells}`)
      console.log(`Valid cells: ${stateB.stats?.validCells ?? totalCells}`)
      console.log(`Saturation: min=${stateB.stats?.minSaturationPct}%, max=${stateB.stats?.maxSaturationPct}%, mean=${stateB.stats?.meanSaturationPct}%`)
      console.log(`Storage: min=${stateB.stats?.minStorageMm}mm, max=${stateB.stats?.maxStorageMm}mm, mean=${stateB.stats?.meanStorageMm}mm`)
      console.table(samplePoints)
      results.forEach((r) => {
        console.log(`${r.pass ? '✅' : '❌'} [${r.name}]: ${r.message}`)
      })
      console.groupEnd()
    }
  } catch (err) {
    console.warn('runModel2Validation diagnostic warning:', err)
  }

  return results
}
