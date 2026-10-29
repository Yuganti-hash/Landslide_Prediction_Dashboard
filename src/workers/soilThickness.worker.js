/**
 * soilThickness.worker.js
 * ============================================================================
 * Dedicated Web Worker for Terrain-Derived Soil Thickness Estimation
 * Offloads multi-scale DEM derivatives and geomorphic proxy calculations.
 * ============================================================================
 */

import { buildTerrainDerivatives } from '../services/terrainDerivatives'
import { buildDisplayIndexMaps, downsampleElevation2D } from '../services/soilSaturationSimulation'

const H_MIN_M   = 0.30
const H_MAX_M   = 3.50
const H_BASE_M  = 0.80
const WEIGHT_SLOPE = 1.40
const WEIGHT_TPI   = 0.80
const WEIGHT_PLAN  = 0.50
const WEIGHT_ACCUM = 0.40
const MAX_SLOPE_DEG = 45

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

function buildSoilThicknessFlat(derivatives, elevFlat) {
  const { slopeMatrix, tpiMatrix, planCurvatureMatrix, accumulationMatrix, width, height } = derivatives
  const totalCells = width * height

  const slopeNorm = normaliseArray(slopeMatrix, totalCells, elevFlat)
  const tpiNorm   = normaliseArray(tpiMatrix,   totalCells, elevFlat)
  const kPlanNorm = normaliseArray(planCurvatureMatrix, totalCells, elevFlat)

  const logAccum = new Float32Array(totalCells)
  for (let i = 0; i < totalCells; i++) {
    logAccum[i] = elevFlat[i] > -9990 ? Math.log(1 + accumulationMatrix[i]) : 0
  }
  const accumNorm = normaliseArray(logAccum, totalCells, elevFlat)

  const thickness = new Float32Array(totalCells)
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

function buildThicknessSurfaceColor(thicknessFlat, width, rowMap, colMap, minH, maxH) {
  const dH = rowMap.length
  const dW = colMap.length
  const mat = new Array(dH)
  const range = Math.max(0.01, maxH - minH)

  for (let ri = 0; ri < dH; ri++) {
    const r = rowMap[ri]
    const row = new Array(dW)
    const rOff = r * width
    for (let ci = 0; ci < dW; ci++) {
      const h = thicknessFlat[rOff + colMap[ci]]
      if (h == null || isNaN(h) || !isFinite(h) || h <= 0) {
        row[ci] = null
        continue
      }
      // Continuous global normalization based on ACTUAL calculated soil thickness:
      // minH (thinnest soil, steep cliffs) -> 0.0 (dark brown)
      // maxH (thickest soil, gentle deposition valleys) -> 1.0 (bright warm yellow)
      const normH = Math.max(0.0, Math.min(1.0, (h - minH) / range))
      row[ci] = normH
    }
    mat[ri] = row
  }
  return mat
}

function buildThicknessRawMatrix(thicknessFlat, width, rowMap, colMap) {
  const dH = rowMap.length
  const dW = colMap.length
  const mat = new Array(dH)
  for (let ri = 0; ri < dH; ri++) {
    const r = rowMap[ri]
    const row = new Array(dW)
    const rOff = r * width
    for (let ci = 0; ci < dW; ci++) {
      const h = thicknessFlat[rOff + colMap[ci]]
      row[ci] = (h != null && !isNaN(h) && isFinite(h) && h > 0) ? Number(h.toFixed(2)) : null
    }
    mat[ri] = row
  }
  return mat
}

self.onmessage = function (e) {
  const { type, terrain, downsampleFactor = 3 } = e.data

  if (type === 'CALCULATE_SOIL_THICKNESS') {
    try {
      if (!terrain || !terrain.elevation) {
        throw new Error('Invalid terrain dataset')
      }

      const { width, height, elevation } = terrain
      const totalCells = width * height
      const elevFlat = new Float32Array(totalCells)
      for (let r = 0; r < height; r++) {
        const row = elevation[r]
        const rOff = r * width
        for (let c = 0; c < width; c++) {
          const z = row[c]
          elevFlat[rOff + c] = (z != null && !isNaN(z)) ? z : -9999
        }
      }

      const derivatives = buildTerrainDerivatives(terrain)
      const displayMaps = buildDisplayIndexMaps(width, height, downsampleFactor)
      const thicknessFlat = buildSoilThicknessFlat(derivatives, elevFlat)

      let minH = Infinity, maxH = -Infinity, sum = 0, count = 0
      for (let i = 0; i < thicknessFlat.length; i++) {
        if (elevFlat[i] <= -9990) continue
        const h = thicknessFlat[i]
        if (h < minH) minH = h
        if (h > maxH) maxH = h
        sum += h
        count++
      }
      const thicknessStats = count > 0 ? { min: minH, max: maxH, mean: sum / count, count } : null

      const displayElevation = downsampleElevation2D(elevation, displayMaps.rowMap, displayMaps.colMap)
      const displayColor = buildThicknessSurfaceColor(
        thicknessFlat,
        width,
        displayMaps.rowMap,
        displayMaps.colMap,
        minH,
        maxH
      )
      const displayThickness = buildThicknessRawMatrix(
        thicknessFlat,
        width,
        displayMaps.rowMap,
        displayMaps.colMap
      )

      self.postMessage({
        type: 'SOIL_THICKNESS_SUCCESS',
        payload: {
          displayElevation,
          displayColor,
          displayThickness,
          displayX: Array.from(displayMaps.colMap),
          displayY: Array.from(displayMaps.rowMap),
          thicknessStats,
        },
      })
    } catch (err) {
      self.postMessage({
        type: 'SOIL_THICKNESS_ERROR',
        error: err.message,
      })
    }
  }
}
