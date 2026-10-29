/**
 * Hydrology & Soil Moisture Simulation Engine
 * Derived directly from USGS 1.0m LiDAR DEM surface.
 * Computes:
 * 1. Terrain slope gradient & aspect
 * 2. Steepest descent downhill flow vectors (flowDx, flowDy) and compass direction
 * 3. Flow accumulation / convergence hollows (TWI proxy)
 * 4. Downhill drainage streamlines (cascading from high elevation to low valleys)
 * 5. Physical infiltration, runoff, and soil moisture matrix
 */

/**
 * Precompute static DEM hydrological properties (slope, flow directions, streamlines, accumulation):
 * @param {Object} terrain - Object containing { width, height, elevation }
 * @returns {Object} Static hydrological grid and streamline paths
 */
export function precomputeTerrainHydrology(terrain) {
  if (!terrain || !terrain.elevation) return null

  const { width, height, elevation } = terrain
  const totalCells = width * height

  const slope = new Float32Array(totalCells)
  const flowDx = new Float32Array(totalCells)
  const flowDy = new Float32Array(totalCells)
  const flowDirStr = new Array(totalCells)
  const accumulation = new Float32Array(totalCells)

  const compassDirs = ['→ E', '↘ SE', '↓ S', '↙ SW', '← W', '↖ NW', '↑ N', '↗ NE']

  let maxSlope = 0.001

  // 1. Calculate local slope gradient and steepest descent unit vectors
  for (let r = 1; r < height - 1; r++) {
    const row = elevation[r]
    const rowUp = elevation[r - 1]
    const rowDown = elevation[r + 1]

    for (let c = 1; c < width - 1; c++) {
      const idx = r * width + c
      const z = row[c]
      if (z == null) continue

      // Central difference gradients
      const dz_dx = ((row[c + 1] ?? z) - (row[c - 1] ?? z)) / 2.0
      const dz_dy = ((rowDown[c] ?? z) - (rowUp[c] ?? z)) / 2.0

      const gradMag = Math.sqrt(dz_dx * dz_dx + dz_dy * dz_dy)
      slope[idx] = gradMag
      if (gradMag > maxSlope) maxSlope = gradMag

      if (gradMag > 1e-4) {
        // Downhill steepest descent direction (-gradient)
        const fx = -dz_dx / gradMag
        const fy = -dz_dy / gradMag
        flowDx[idx] = fx
        flowDy[idx] = fy

        // Compass heading for hover readout
        let angle = Math.atan2(fy, fx) * (180 / Math.PI) // -180 to 180
        if (angle < 0) angle += 360
        const dirIdx = Math.round(angle / 45) % 8
        flowDirStr[idx] = compassDirs[dirIdx]
      } else {
        flowDx[idx] = 0
        flowDy[idx] = 1.0 // default downward
        flowDirStr[idx] = '↓ Flat'
      }
    }
  }

  // Normalize slope to [0, 1]
  for (let i = 0; i < slope.length; i++) {
    slope[i] = Math.min(1.0, slope[i] / (maxSlope * 0.70))
  }

  // 2. Approximate flow accumulation / topographic convergence (TWI proxy)
  // Evaluates multi-scale curvature: concave hollows & ravines have high convergence
  for (let r = 2; r < height - 2; r++) {
    for (let c = 2; c < width - 2; c++) {
      const idx = r * width + c
      const z = elevation[r][c]
      if (z == null) continue

      // Multi-scale topographic curvature (Laplacian)
      const avg1 = (elevation[r - 1][c] + elevation[r + 1][c] + elevation[r][c - 1] + elevation[r][c + 1]) / 4.0
      const avg2 = (elevation[r - 2][c] + elevation[r + 2][c] + elevation[r][c - 2] + elevation[r][c + 2]) / 4.0
      const curvature = (avg1 - z) * 0.65 + (avg2 - z) * 0.35

      const localSlope = slope[idx]

      // Concave hollows (curvature > 0) accumulate water; convex ridges shed water
      let accum = Math.max(0.1, 1.0 + curvature * 4.0) / (0.35 + localSlope * 1.5)
      accum = Math.min(7.5, Math.max(0.05, accum))

      accumulation[idx] = accum
    }
  }

  // 3. Generate Downhill Drainage Streamlines
  // Traces real water paths from mountain slopes down into convergence valleys
  const streamlines = []
  const stepR = 12
  const stepC = 12

  for (let r = 8; r < height - 8; r += stepR) {
    for (let c = 8; c < width - 8; c += stepC) {
      const startIdx = r * width + c
      const startZ = elevation[r][c]
      if (startZ == null || slope[startIdx] < 0.04) continue

      // Trace path downhill following flowDx, flowDy
      let currX = c
      let currY = r
      const path = [{ x: currX, y: currY, accum: accumulation[startIdx] }]
      let maxPathAccum = accumulation[startIdx]

      const maxSteps = 28
      for (let s = 0; s < maxSteps; s++) {
        const gc = Math.round(currX)
        const gr = Math.round(currY)
        if (gc < 1 || gc >= width - 1 || gr < 1 || gr >= height - 1) break

        const gIdx = gr * width + gc
        const dx = flowDx[gIdx]
        const dy = flowDy[gIdx]
        if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) break

        currX += dx * 2.2
        currY += dy * 2.2
        const acc = accumulation[gIdx]
        if (acc > maxPathAccum) maxPathAccum = acc
        path.push({ x: currX, y: currY, accum: acc })
      }

      // Keep paths that develop significant downhill flow
      if (path.length >= 8 && maxPathAccum > 0.6) {
        streamlines.push({
          points: path,
          weight: maxPathAccum,
          isMajorChannel: maxPathAccum >= 1.8,
        })
      }
    }
  }

  return {
    width,
    height,
    slope,
    flowDx,
    flowDy,
    flowDirStr,
    accumulation,
    streamlines,
  }
}

/**
 * Simulate rainfall, runoff, infiltration, and soil moisture:
 * @param {Object} terrain - Loaded terrain object
 * @param {Object} hydroStatic - Precomputed hydrology from precomputeTerrainHydrology()
 * @param {number} rainfallMm - Rainfall in mm (0 to 200 mm)
 * @returns {Object} { moistureMatrix, customDataMatrix, stats }
 */
export function simulateRainfallMoisture(terrain, hydroStatic, rainfallMm = 0) {
  if (!terrain || !terrain.elevation || !hydroStatic) {
    return { moistureMatrix: null, customDataMatrix: null, stats: null }
  }

  const { width, height, elevation } = terrain
  const { slope, accumulation, flowDirStr } = hydroStatic

  const moistureMatrix = []
  const customDataMatrix = []

  let sumMoisture = 0
  let minMoisture = 999
  let maxMoisture = -999
  let validCells = 0
  let sumRunoff = 0
  let maxAccum = 0

  // ── Physical Hydrological Calibration ──
  // Baseline dry soil moisture: ~0.10 m³/m³ (dark charcoal navy base)
  const BASE_MOISTURE = 0.10
  // Infiltration capacity factor
  const INFILTRATION_COEFF = 0.0021

  for (let r = 0; r < height; r++) {
    const moistureRow = new Float32Array(width)
    const customRow = []
    const elevRow = elevation[r]

    for (let c = 0; c < width; c++) {
      const idx = r * width + c
      const z = elevRow[c]

      if (z == null) {
        moistureRow[c] = null
        customRow.push(null)
        continue
      }

      const localSlope = slope[idx]
      const localAccum = accumulation[idx]
      const localDir = flowDirStr[idx] ?? '↓'
      if (localAccum > maxAccum) maxAccum = localAccum

      if (rainfallMm <= 0) {
        // Zero rainfall: dry baseline terrain (dark charcoal navy)
        const baseline = BASE_MOISTURE + (1.0 - localSlope) * 0.02
        moistureRow[c] = baseline
        sumMoisture += baseline
        if (baseline < minMoisture) minMoisture = baseline
        if (baseline > maxMoisture) maxMoisture = baseline
        validCells++

        // customdata for hover: [soilMoisture, elevation, flowAccum, flowDirStr, rainfallMm]
        customRow.push([baseline, z, localAccum.toFixed(1), localDir, 0])
        continue
      }

      // ── Physical Infiltration Equation ──
      // Rapid drainage/steep slopes -> fast runoff -> lower residence time -> less infiltration
      // Low-flow accumulation hollows/valleys -> longer residence time -> higher infiltration -> higher moisture
      const residenceFactor = Math.pow(localAccum, 0.75) / (0.8 + localSlope * 1.5)

      // Runoff ratio
      const runoffFactor = Math.min(1.0, 0.18 + localSlope * 0.65)
      sumRunoff += runoffFactor

      const infiltration = rainfallMm * INFILTRATION_COEFF * residenceFactor

      // Bounded realistically within physical soil limits [0.10, 0.65] m³/m³ (NEVER WHITE!)
      const sm = Math.min(0.65, Math.max(0.10, BASE_MOISTURE + infiltration))

      moistureRow[c] = sm
      sumMoisture += sm
      if (sm < minMoisture) minMoisture = sm
      if (sm > maxMoisture) maxMoisture = sm
      validCells++

      customRow.push([sm, z, localAccum.toFixed(1), localDir, rainfallMm])
    }

    moistureMatrix.push(Array.from(moistureRow))
    customDataMatrix.push(customRow)
  }

  const meanMoisture = validCells > 0 ? sumMoisture / validCells : 0.10
  const relativeRunoffPct = validCells > 0 ? Math.round((sumRunoff / validCells) * (rainfallMm / 200) * 100) : 0

  return {
    moistureMatrix,
    customDataMatrix,
    stats: {
      rainfallMm: Math.round(rainfallMm),
      meanMoisture: Number(meanMoisture.toFixed(3)),
      minMoisture: Number(minMoisture.toFixed(3)),
      maxMoisture: Number(maxMoisture.toFixed(3)),
      relativeRunoffPct: Math.min(95, Math.max(0, relativeRunoffPct)),
      maxFlowAccumulation: Number(maxAccum.toFixed(1)),
      status: rainfallMm === 0 ? 'NO RAINFALL' : 'SIMULATION ACTIVE',
    },
  }
}
