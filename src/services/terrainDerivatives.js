/**
 * terrainDerivatives.js
 * ============================================================================
 * High-Performance LiDAR DEM Terrain Geomorphometry & Hydrology Engine
 * Derived directly from USGS bare-earth LiDAR DEM (public/terrain_web.json).
 *
 * Computes:
 * 1. Spatial derivatives (p = dz/dx, q = dz/dy)
 * 2. Slope (degrees and radians)
 * 3. Aspect (azimuth 0° North, 90° East, 180° South, 270° West)
 * 4. Second partial derivatives (r = d²z/dx², t = d²z/dy², s = d²z/dxdy)
 * 5. Profile Curvature (curvature along maximum slope direction)
 * 6. Plan Curvature (curvature across slope direction / contour curvature)
 * 7. Multi-scale Topographic Position Index (TPI) for ridge/depression identification
 * 8. D8 steepest descent downslope routing & flow accumulation
 * ============================================================================
 */

/**
 * Returns compass direction label for a given aspect angle (0–360°).
 * 0° = N, 90° = E, 180° = S, 270° = W.
 */
export function getCompassDirection(aspectDeg) {
  if (aspectDeg == null || isNaN(aspectDeg)) return 'Flat'
  const compassLabels = [
    'N', 'NNE', 'NE', 'ENE',
    'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW',
    'W', 'WNW', 'NW', 'NNW'
  ]
  const idx = Math.round((aspectDeg % 360) / 22.5) % 16
  return compassLabels[idx]
}

/**
 * Verified DEM Georeferencing
 * Ground-truth source: USGS bare-earth LiDAR DEM GeoTIFFs (scratch/tif_inspect/dataset1.tif & dataset2.tif)
 * Native Projected CRS: EPSG:26912 (NAD83 / UTM Zone 12N)
 * Projected Bounds: Left = 389994.0 m, Right = 410006.0 m (Span X = 20012.0 m)
 *                   Bottom = 4479994.0 m, Top = 4490006.0 m (Span Y = 10012.0 m)
 * Grid dimensions: 872 cols × 589 rows
 * Verified ground spacing: dx = 20012.0 / 872 = 22.949541 m, dy = 10012.0 / 589 = 16.998302 m
 */
export const VERIFIED_TERRAIN_METADATA = {
  crs: 'EPSG:26912',
  dx: 22.949541,
  dy: 16.998302,
  width: 872,
  height: 589,
  extentUTM: {
    left: 389994.0,
    bottom: 4479994.0,
    right: 410006.0,
    top: 4490006.0,
  },
}

/**
 * Precomputes all static terrain derivatives and hydrology matrices once upon DEM load.
 *
 * @param {Object} terrain - Object containing { width, height, elevation, [dx], [dy], [crs], [resolution] }
 * @returns {Object} Precomputed typed arrays, summary statistics, and 2D matrix getter
 */
export function buildTerrainDerivatives(terrain) {
  if (!terrain || !terrain.elevation) return null

  const { width, height, elevation } = terrain
  const totalCells = width * height

  // 1. Determine grid spacing from DEM metadata (uses verified georeferencing; never silently falls back to 1.0 m)
  const dx = Number(terrain.dx ?? terrain.resolution ?? VERIFIED_TERRAIN_METADATA.dx)
  const dy = Number(terrain.dy ?? terrain.resolution ?? VERIFIED_TERRAIN_METADATA.dy)
  const crs = terrain.crs ?? VERIFIED_TERRAIN_METADATA.crs
  const dx2 = dx * dx
  const dy2 = dy * dy
  const d4xdy = 4.0 * dx * dy

  // 2. Allocate high-performance typed arrays
  const slopeMatrix = new Float32Array(totalCells)
  const aspectMatrix = new Float32Array(totalCells)
  const profileCurvatureMatrix = new Float32Array(totalCells)
  const planCurvatureMatrix = new Float32Array(totalCells)
  const tpiMatrix = new Float32Array(totalCells)
  const drainageFactorMatrix = new Float32Array(totalCells)
  const retentionFactorMatrix = new Float32Array(totalCells)

  // Pre-flatten elevations for fast lookups
  const elevFlat = new Float32Array(totalCells)
  for (let r = 0; r < height; r++) {
    const rOff = r * width
    const row = elevation[r]
    for (let c = 0; c < width; c++) {
      const z = row[c]
      elevFlat[rOff + c] = (z != null && !isNaN(z)) ? z : -9999
    }
  }

  // Multi-scale TPI sampling radii (in grid cells)
  const scaleRadii = [2, 5, 10]

  // Statistics accumulators
  let sumSlope = 0
  let minSlope = 90
  let maxSlope = 0
  let sumSinAspect = 0
  let sumCosAspect = 0
  let validAspectCount = 0
  let sumProfCurv = 0
  let sumPlanCurv = 0
  let validCellCount = 0

  // 3. Finite differences: First and Second Derivatives, Curvatures, Aspect, Slope
  for (let r = 0; r < height; r++) {
    const rOff = r * width
    const rUp = Math.max(0, r - 1)
    const rDown = Math.min(height - 1, r + 1)

    for (let c = 0; c < width; c++) {
      const idx = rOff + c
      const z = elevFlat[idx]
      if (z <= -9990) continue

      const cLeft = Math.max(0, c - 1)
      const cRight = Math.min(width - 1, c + 1)

      const zL = elevFlat[rOff + cLeft] > -9990 ? elevFlat[rOff + cLeft] : z
      const zR = elevFlat[rOff + cRight] > -9990 ? elevFlat[rOff + cRight] : z
      const zU = elevFlat[rUp * width + c] > -9990 ? elevFlat[rUp * width + c] : z
      const zD = elevFlat[rDown * width + c] > -9990 ? elevFlat[rDown * width + c] : z

      // First partial derivatives (central differences)
      // p = dz/dx, q = dz/dy
      const p = (zR - zL) / (2.0 * dx)
      const q = (zD - zU) / (2.0 * dy)
      const gradSq = p * p + q * q
      const grad = Math.sqrt(gradSq)

      // Slope: arctan(gradient) in degrees [0°, 90°]
      const slopeDeg = Math.atan(grad) * (180.0 / Math.PI)
      slopeMatrix[idx] = slopeDeg
      sumSlope += slopeDeg
      if (slopeDeg < minSlope) minSlope = slopeDeg
      if (slopeDeg > maxSlope) maxSlope = slopeDeg

      // Aspect: atan2(-dz_dx, dz_dy) in degrees [0°, 360°]
      // 0° = North, 90° = East, 180° = South, 270° = West
      if (grad > 1e-5) {
        const aspectRad = Math.atan2(-p, q)
        let aspectDeg = (aspectRad * (180.0 / Math.PI) + 360.0) % 360.0
        aspectMatrix[idx] = aspectDeg
        sumSinAspect += Math.sin(aspectRad)
        sumCosAspect += Math.cos(aspectRad)
        validAspectCount++
      } else {
        // Flat terrain: aspect is undefined / null represented as 0
        aspectMatrix[idx] = 0
      }

      // Second partial derivatives
      // r = d²z/dx², t = d²z/dy², s = d²z/dxdy
      let kProfile = 0
      let kPlan = 0

      if (gradSq > 1e-10) {
        const zNW = elevFlat[rUp * width + cLeft] > -9990 ? elevFlat[rUp * width + cLeft] : z
        const zNE = elevFlat[rUp * width + cRight] > -9990 ? elevFlat[rUp * width + cRight] : z
        const zSW = elevFlat[rDown * width + cLeft] > -9990 ? elevFlat[rDown * width + cLeft] : z
        const zSE = elevFlat[rDown * width + cRight] > -9990 ? elevFlat[rDown * width + cRight] : z

        const rDeriv = (zR - 2.0 * z + zL) / dx2
        const tDeriv = (zD - 2.0 * z + zU) / dy2
        const sDeriv = (zSE - zSW - zNE + zNW) / d4xdy

        // Profile Curvature: K_profile = - (r*p² + 2*s*p*q + t*q²) / ((p² + q²) * (1 + p² + q²)^(3/2))
        const onePlusGradSq = 1.0 + gradSq
        const denomProf = gradSq * Math.pow(onePlusGradSq, 1.5)
        kProfile = - (rDeriv * p * p + 2.0 * sDeriv * p * q + tDeriv * q * q) / denomProf

        // Plan Curvature: K_plan = (t*p² - 2*s*p*q + r*q²) / ((p² + q²)^(3/2))
        const denomPlan = Math.pow(gradSq, 1.5)
        kPlan = (tDeriv * p * p - 2.0 * sDeriv * p * q + rDeriv * q * q) / denomPlan

        // Robust clamping for numerical outliers
        kProfile = Math.max(-10.0, Math.min(10.0, kProfile))
        kPlan = Math.max(-10.0, Math.min(10.0, kPlan))
      }

      profileCurvatureMatrix[idx] = kProfile
      planCurvatureMatrix[idx] = kPlan
      sumProfCurv += kProfile
      sumPlanCurv += kPlan

      // 4. Multi-Scale Topographic Position Index (TPI)
      let sumTpi = 0
      let validScales = 0
      for (let s = 0; s < scaleRadii.length; s++) {
        const k = scaleRadii[s]
        let sumNeigh = 0
        let cntNeigh = 0

        if (r - k >= 0 && elevFlat[(r - k) * width + c] > -9990) { sumNeigh += elevFlat[(r - k) * width + c]; cntNeigh++ }
        if (r + k < height && elevFlat[(r + k) * width + c] > -9990) { sumNeigh += elevFlat[(r + k) * width + c]; cntNeigh++ }
        if (c - k >= 0 && elevFlat[rOff + (c - k)] > -9990) { sumNeigh += elevFlat[rOff + (c - k)]; cntNeigh++ }
        if (c + k < width && elevFlat[rOff + (c + k)] > -9990) { sumNeigh += elevFlat[rOff + (c + k)]; cntNeigh++ }

        if (cntNeigh >= 2) {
          sumTpi += (z - sumNeigh / cntNeigh)
          validScales++
        }
      }
      const avgTpi = validScales > 0 ? sumTpi / validScales : 0
      tpiMatrix[idx] = avgTpi

      validCellCount++
    }
  }

  // 5. D8 Downslope Flow Direction and Flow Accumulation
  const d8Target = new Int32Array(totalCells).fill(-1)
  const cellIndices = new Int32Array(totalCells)
  for (let i = 0; i < totalCells; i++) cellIndices[i] = i

  const diagDist = Math.hypot(dx, dy)
  const dOffsets = [
    [-1,  0, dy],       // North
    [ 1,  0, dy],       // South
    [ 0, -1, dx],       // West
    [ 0,  1, dx],       // East
    [-1, -1, diagDist], // NW
    [-1,  1, diagDist], // NE
    [ 1, -1, diagDist], // SW
    [ 1,  1, diagDist], // SE
  ]

  for (let r = 0; r < height; r++) {
    const rOff = r * width
    for (let c = 0; c < width; c++) {
      const idx = rOff + c
      const z = elevFlat[idx]
      if (z <= -9990) continue

      let maxSlope = 0
      let bestTarget = -1

      for (let i = 0; i < 8; i++) {
        const nr = r + dOffsets[i][0]
        const nc = c + dOffsets[i][1]
        if (nr >= 0 && nr < height && nc >= 0 && nc < width) {
          const nIdx = nr * width + nc
          const nz = elevFlat[nIdx]
          if (nz > -9990 && nz < z) {
            const slopeToNeigh = (z - nz) / dOffsets[i][2]
            if (slopeToNeigh > maxSlope) {
              maxSlope = slopeToNeigh
              bestTarget = nIdx
            }
          }
        }
      }
      d8Target[idx] = bestTarget
    }
  }

  // Sort cell indices in descending order of elevation to guarantee DAG routing
  cellIndices.sort((a, b) => elevFlat[b] - elevFlat[a])

  // Accumulate upstream contributing cells
  const accumulation = new Float32Array(totalCells).fill(1.0)
  for (let i = 0; i < totalCells; i++) {
    const idx = cellIndices[i]
    if (elevFlat[idx] <= -9990) continue
    const target = d8Target[idx]
    if (target >= 0) {
      accumulation[target] += accumulation[idx]
    }
  }

  // 6. Integrate Curvature, Slope, and Flow Accumulation into Drainage & Retention factors
  for (let i = 0; i < totalCells; i++) {
    if (elevFlat[i] <= -9990) continue

    const sDeg = slopeMatrix[i]
    const slopeFactor = Math.min(1.0, Math.max(0.0, sDeg / 35.0))
    const flatBonus = 1.0 - slopeFactor

    const avgTpi = tpiMatrix[i]
    const ridgeBonus = Math.max(0.0, Math.min(1.0, avgTpi / 15.0))
    const depressionBonus = Math.max(-0.6, Math.min(1.8, -avgTpi / 12.0))

    // Bounded plan curvature factor: concave convergent (>0) focuses water; convex divergent (<0) sheds
    const kPlan = planCurvatureMatrix[i]
    const curvFactor = Math.max(-1.0, Math.min(1.0, kPlan / 0.05))

    // Logarithmic D8 accumulation factor
    const accum = accumulation[i]
    const accumFactor = Math.min(2.5, Math.log(1.0 + accum) / 5.5)

    // Drainage / Runoff factor: accelerated by steep slope & ridge convexity, reduced in convergent hollows
    const drainage = Math.min(1.0, Math.max(0.1, 0.20 + 0.55 * slopeFactor + 0.15 * ridgeBonus - 0.12 * curvFactor))
    drainageFactorMatrix[i] = drainage

    // Retention factor: boosted by flat terrain, valley depression, convergent curvature, and D8 accumulation
    const retentionBase = flatBonus * 0.70 + 0.30
    const retention = Math.max(
      0.15,
      Math.min(
        2.8,
        retentionBase * (1.0 + 0.65 * depressionBonus) * (1.0 + 0.25 * curvFactor) * (1.0 + 0.25 * accumFactor)
      )
    )
    retentionFactorMatrix[i] = retention
  }

  // 7. Calculate overall geomorphometry statistics
  const meanSlope = validCellCount > 0 ? sumSlope / validCellCount : 0
  const meanProfileCurvature = validCellCount > 0 ? sumProfCurv / validCellCount : 0
  const meanPlanCurvature = validCellCount > 0 ? sumPlanCurv / validCellCount : 0

  let meanAspect = 0
  if (validAspectCount > 0) {
    const meanAspectRad = Math.atan2(sumSinAspect / validAspectCount, sumCosAspect / validAspectCount)
    meanAspect = (meanAspectRad * (180.0 / Math.PI) + 360.0) % 360.0
  }

  /**
   * Helper function to extract a 2D Array of rows for Plotly surface coloring
   */
  function to2DMatrix(typedArray) {
    const mat = new Array(height)
    for (let r = 0; r < height; r++) {
      const row = new Float32Array(width)
      const rOff = r * width
      for (let c = 0; c < width; c++) {
        row[c] = typedArray[rOff + c]
      }
      mat[r] = Array.from(row)
    }
    return mat
  }

  return {
    width,
    height,
    dx,
    dy,
    crs,
    slopeMatrix,
    aspectMatrix,
    profileCurvatureMatrix,
    planCurvatureMatrix,
    tpiMatrix,
    accumulationMatrix: accumulation,
    drainageFactorMatrix,
    retentionFactorMatrix,
    d8Target,
    cellIndices,
    stats: {
      meanSlope: Number(meanSlope.toFixed(2)),
      minSlope: Number(minSlope.toFixed(2)),
      maxSlope: Number(maxSlope.toFixed(2)),
      meanAspect: Number(meanAspect.toFixed(1)),
      meanAspectCompass: getCompassDirection(meanAspect),
      meanProfileCurvature: Number(meanProfileCurvature.toFixed(5)),
      meanPlanCurvature: Number(meanPlanCurvature.toFixed(5)),
    },
    to2DMatrix,
  }
}
