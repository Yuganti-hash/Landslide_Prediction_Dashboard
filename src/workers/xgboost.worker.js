/**
 * xgboost.worker.js
 * ============================================================================
 * Dedicated Web Worker for XGBoost Landslide Susceptibility Preprocessing
 * Handles feature interpolation, prediction, and raster matrix downsampling.
 * ============================================================================
 */

import { buildDisplayIndexMaps } from '../services/soilSaturationSimulation'

self.onmessage = async function (e) {
  const { type, payload } = e.data

  if (type === 'PROCESS_SUSCEPTIBILITY') {
    try {
      const { susceptibilityData, downsampleFactor = 3 } = payload

      if (!susceptibilityData) {
        throw new Error('No susceptibility dataset provided')
      }

      const { width, height, probability } = susceptibilityData
      const displayMaps = buildDisplayIndexMaps(width, height, downsampleFactor)

      const dH = displayMaps.rowMap.length
      const dW = displayMaps.colMap.length
      const displayMatrix = new Array(dH)

      let sum = 0
      let count = 0
      let highRiskCount = 0

      for (let ri = 0; ri < dH; ri++) {
        const r = displayMaps.rowMap[ri]
        const row = new Float32Array(dW)
        const rOff = r * width
        for (let ci = 0; ci < dW; ci++) {
          const c = displayMaps.colMap[ci]
          const p = probability[rOff + c] ?? 0
          row[ci] = p
          sum += p
          count++
          if (p >= 0.70) highRiskCount++
        }
        displayMatrix[ri] = Array.from(row)
      }

      self.postMessage({
        type: 'SUSCEPTIBILITY_SUCCESS',
        payload: {
          displayMatrix,
          stats: {
            meanProbability: count > 0 ? sum / count : 0,
            highRiskPercentage: count > 0 ? (highRiskCount / count) * 100 : 0,
          },
        },
      })
    } catch (err) {
      self.postMessage({
        type: 'SUSCEPTIBILITY_ERROR',
        error: err.message,
      })
    }
  }
}
