/**
 * fos.worker.js
 * ============================================================================
 * Dedicated Web Worker for Infinite-Slope Geotechnical Factor of Safety Engine
 * Offloads physics pore-pressure & limit-equilibrium calculations off-thread.
 * ============================================================================
 */

import {
  NORTH_INDIAN_ALLUVIAL_LOAM_PROFILE,
  calculateFoSMatrix,
  downsampleFoSTo2D,
} from '../services/factorOfSafetyEngine'

self.onmessage = function (e) {
  const { type, payload } = e.data

  if (type === 'CALCULATE_FOS') {
    try {
      const {
        slopeMatrix,
        saturationRatio,
        soilParams = NORTH_INDIAN_ALLUVIAL_LOAM_PROFILE,
        elevFlat,
        width,
        height,
        displayMaps,
      } = payload

      if (!slopeMatrix || !displayMaps) {
        throw new Error('Invalid inputs provided to FoS worker')
      }

      // 1. Calculate FoS matrix across all cells
      const fosResult = calculateFoSMatrix(slopeMatrix, saturationRatio, soilParams, elevFlat)

      // 2. Downsample to display grid for fast Plotly rendering
      const displayFoSMatrix = downsampleFoSTo2D(
        fosResult.fosMatrix,
        width,
        height,
        displayMaps.rowMap,
        displayMaps.colMap
      )

      self.postMessage({
        type: 'FOS_SUCCESS',
        payload: {
          fosResult,
          displayFoSMatrix,
        },
      })
    } catch (err) {
      self.postMessage({
        type: 'FOS_ERROR',
        error: err.message,
      })
    }
  }
}
