/**
 * saturation.worker.js
 * ============================================================================
 * Dedicated Web Worker for Time-Dependent Soil Water Saturation Dynamics
 * Runs physics equations (infiltration, drainage, D8 excess flow) off-thread.
 * ============================================================================
 */

import {
  STANDARD_SOIL_PROFILE,
  initializeSoilWaterState,
  stepSoilWaterSimulation,
  downsampleBlendedSurfaceColor2D,
} from '../services/soilSaturationSimulation'

let currentState = null
let cachedTerrain = null
let cachedHydroStatic = null
let cachedSoilProfile = STANDARD_SOIL_PROFILE
let cachedDisplayMaps = null

self.onmessage = function (e) {
  const { type, payload } = e.data

  switch (type) {
    case 'INIT': {
      try {
        const { terrain, baseSmMatrix, hydroStatic, soilProfile, displayMaps } = payload
        cachedTerrain = terrain
        cachedHydroStatic = hydroStatic
        cachedSoilProfile = soilProfile || STANDARD_SOIL_PROFILE
        cachedDisplayMaps = displayMaps

        currentState = initializeSoilWaterState(terrain, baseSmMatrix, cachedHydroStatic, cachedSoilProfile)

        const dispSat = downsampleBlendedSurfaceColor2D(
          currentState.saturationRatio,
          cachedTerrain.elevation,
          cachedTerrain.minElevation,
          cachedTerrain.maxElevation,
          cachedTerrain.width,
          cachedTerrain.height,
          cachedDisplayMaps.rowMap,
          cachedDisplayMaps.colMap,
          0
        )

        self.postMessage({
          type: 'INIT_SUCCESS',
          payload: {
            stats: currentState.stats,
            displaySaturation: dispSat,
            saturationRatio: currentState.saturationRatio,
          },
        })
      } catch (err) {
        self.postMessage({ type: 'ERROR', error: err.message })
      }
      break
    }

    case 'STEP': {
      try {
        if (!currentState || !cachedTerrain || !cachedHydroStatic) {
          throw new Error('Simulation not initialized in worker')
        }

        const { rainfallIntensity, timestepMin = 5 } = payload

        currentState = stepSoilWaterSimulation(
          currentState,
          rainfallIntensity,
          timestepMin,
          cachedTerrain,
          cachedHydroStatic,
          cachedSoilProfile
        )

        const dispSat = downsampleBlendedSurfaceColor2D(
          currentState.saturationRatio,
          cachedTerrain.elevation,
          cachedTerrain.minElevation,
          cachedTerrain.maxElevation,
          cachedTerrain.width,
          cachedTerrain.height,
          cachedDisplayMaps.rowMap,
          cachedDisplayMaps.colMap,
          currentState.accumulatedRainfallMm ?? currentState.stats?.accumulatedRainfallMm ?? 0
        )

        self.postMessage({
          type: 'STEP_SUCCESS',
          payload: {
            stats: currentState.stats,
            displaySaturation: dispSat,
            saturationRatio: currentState.saturationRatio,
          },
        })
      } catch (err) {
        self.postMessage({ type: 'ERROR', error: err.message })
      }
      break
    }

    case 'RESET': {
      try {
        if (cachedTerrain && cachedSoilProfile) {
          const { baseSmMatrix } = payload || {}
          currentState = initializeSoilWaterState(
            cachedTerrain,
            baseSmMatrix || null,
            cachedHydroStatic,
            cachedSoilProfile
          )

          const dispSat = downsampleBlendedSurfaceColor2D(
            currentState.saturationRatio,
            cachedTerrain.elevation,
            cachedTerrain.minElevation,
            cachedTerrain.maxElevation,
            cachedTerrain.width,
            cachedTerrain.height,
            cachedDisplayMaps.rowMap,
            cachedDisplayMaps.colMap,
            0
          )

          self.postMessage({
            type: 'RESET_SUCCESS',
            payload: {
              stats: currentState.stats,
              displaySaturation: dispSat,
              saturationRatio: currentState.saturationRatio,
            },
          })
        }
      } catch (err) {
        self.postMessage({ type: 'ERROR', error: err.message })
      }
      break
    }

    case 'CLEAR': {
      currentState = null
      cachedTerrain = null
      cachedHydroStatic = null
      cachedDisplayMaps = null
      self.postMessage({ type: 'CLEARED' })
      break
    }

    default:
      break
  }
}
