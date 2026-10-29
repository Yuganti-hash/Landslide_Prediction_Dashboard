/**
 * d8Flow.worker.js
 * ============================================================================
 * Dedicated Web Worker for D8 Flow Routing & Drainage Accumulation
 * Offloads heavy 513,608-cell steepest descent calculations from main thread.
 * ============================================================================
 */

import { buildTerrainDerivatives } from '../services/terrainDerivatives'
import { precomputeTerrainHydrology } from '../services/hydrologySimulation'
import { buildDisplayIndexMaps, downsampleDiagnosticTo2D } from '../services/soilSaturationSimulation'

self.onmessage = function (e) {
  const { type, terrain, downsampleFactor = 3 } = e.data

  if (type === 'CALCULATE_D8') {
    try {
      if (!terrain || !terrain.elevation) {
        throw new Error('Invalid terrain dataset provided to worker.')
      }

      const { width, height } = terrain
      // 1. Calculate D8 derivatives & flow accumulation via terrainDerivatives
      const derivatives = buildTerrainDerivatives(terrain)
      // 2. Calculate streamlines & convergence via hydrologySimulation
      const hydroStatic = precomputeTerrainHydrology(terrain)

      // 3. Downsample accumulation matrix to display grid for Plotly surface coloring
      const displayMaps = buildDisplayIndexMaps(width, height, downsampleFactor)
      const displayAccum2D = downsampleDiagnosticTo2D(
        derivatives.accumulationMatrix,
        width,
        height,
        displayMaps.rowMap,
        displayMaps.colMap
      )

      // Logarithmic display accumulation: log10(1 + accum) for high-contrast channel visualization
      const logAccum2D = displayAccum2D.map(row =>
        row.map(val => (val > 0 ? Math.log10(1.0 + val) : 0))
      )

      // Find max log accumulation
      let maxLog = 0
      for (let r = 0; r < logAccum2D.length; r++) {
        for (let c = 0; c < logAccum2D[r].length; c++) {
          if (logAccum2D[r][c] > maxLog) maxLog = logAccum2D[r][c]
        }
      }

      // Summary metrics
      let majorStreams = 0
      let totalAccum = 0
      for (let i = 0; i < derivatives.accumulationMatrix.length; i++) {
        const acc = derivatives.accumulationMatrix[i]
        totalAccum += acc
        if (acc > 50) majorStreams++
      }

      self.postMessage({
        type: 'D8_SUCCESS',
        payload: {
          displayAccum2D: logAccum2D,
          maxLogAccum: maxLog || 1.0,
          stats: {
            ...derivatives.stats,
            streamlineCount: hydroStatic?.streamlines?.length || 0,
            majorStreams,
            meanAccumulation: Math.round(totalAccum / derivatives.accumulationMatrix.length),
          },
          displayMaps,
        },
      })
    } catch (err) {
      self.postMessage({
        type: 'D8_ERROR',
        error: err.message,
      })
    }
  }
}
