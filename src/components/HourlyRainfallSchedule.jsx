import React, { useMemo } from 'react'

/**
 * HourlyRainfallSchedule
 * 24-hour rainfall schedule editor with 2-column compact grid,
 * active hour highlight, current hour readout, and summary stats.
 *
 * Props:
 *   hourlyRainfall       number[24]  Array of 24 hourly rainfall values (mm/hr)
 *   onScheduleChange     (hourIndex, value) => void
 *   elapsedTimeMin       number      Simulation elapsed time in minutes
 *   accumulatedRainfallMm number
 *   isRunning            boolean
 *   scheduleComplete     boolean     True when simulation reaches 1440 min (24 hours)
 */
export default function HourlyRainfallSchedule({
  hourlyRainfall = new Array(24).fill(0),
  onScheduleChange,
  elapsedTimeMin = 0,
  accumulatedRainfallMm = 0,
  isRunning = false,
  scheduleComplete = false,
}) {
  const currentHourIdx = scheduleComplete
    ? 23
    : Math.min(23, Math.floor(elapsedTimeMin / 60))

  const totalScheduledRainfall = useMemo(() => {
    return hourlyRainfall.reduce((sum, value) => sum + (Number(value) || 0), 0)
  }, [hourlyRainfall])

  const peakRainfall = useMemo(() => {
    return Math.max(...hourlyRainfall.map((v) => Number(v) || 0), 0)
  }, [hourlyRainfall])

  const currentIntensity = hourlyRainfall[currentHourIdx] ?? 0

  const handleChange = (hourIndex, rawValue) => {
    if (rawValue === '') {
      onScheduleChange?.(hourIndex, 0)
      return
    }
    const parsed = parseInt(rawValue, 10)
    const val = isNaN(parsed) ? 0 : Math.max(0, Math.min(200, parsed))
    onScheduleChange?.(hourIndex, val)
  }

  return (
    <div className="hrs-panel" id="hourly-rainfall-schedule-panel">
      {/* Header */}
      <div className="hrs-section-title">
        <span>⏱️</span> 24-HOUR RAINFALL
      </div>

      {/* Completion Banner */}
      {scheduleComplete && (
        <div className="hrs-complete-banner" id="hrs-complete-banner">
          24-HOUR SIMULATION COMPLETE
        </div>
      )}

      {/* Current Hour & Rainfall Live Status */}
      <div className="hrs-status-box" id="hrs-current-status-box">
        <div className="hrs-status-item">
          <span className="hrs-status-label">CURRENT HOUR</span>
          <span className="hrs-status-value">
            Hour: {currentHourIdx + 1} / 24
          </span>
        </div>
        <div className="hrs-status-item hrs-status-item-right">
          <span className="hrs-status-label">CURRENT RAINFALL</span>
          <span className="hrs-status-value">
            {currentIntensity} <span className="hrs-unit-sub">mm/hr</span>
          </span>
        </div>
      </div>

      {/* 2-Column Internally Scrollable Grid */}
      <div className="hrs-grid-scroll" id="hrs-grid-scroll-container">
        <div className="hrs-grid">
          {/* Column 1: Hour 1 to 12 */}
          <div className="hrs-col">
            {hourlyRainfall.slice(0, 12).map((val, i) => {
              const isActive = i === currentHourIdx && !scheduleComplete
              return (
                <div
                  key={i}
                  id={`hrs-row-${i}`}
                  className={`hrs-row ${isActive ? 'hrs-row-active' : ''}`}
                >
                  <span className="hrs-row-label">Hour {i + 1}</span>
                  <input
                    id={`hrs-input-${i}`}
                    type="number"
                    min="0"
                    max="200"
                    step="1"
                    value={val ?? 0}
                    onChange={(e) => handleChange(i, e.target.value)}
                    className="hrs-input"
                    aria-label={`Hour ${i + 1} rainfall in mm per hour`}
                  />
                  <span className="hrs-row-unit">mm/hr</span>
                  {isActive && <span className="hrs-active-tag">← ACTIVE</span>}
                </div>
              )
            })}
          </div>

          {/* Column 2: Hour 13 to 24 */}
          <div className="hrs-col">
            {hourlyRainfall.slice(12, 24).map((val, i) => {
              const idx = i + 12
              const isActive = idx === currentHourIdx && !scheduleComplete
              return (
                <div
                  key={idx}
                  id={`hrs-row-${idx}`}
                  className={`hrs-row ${isActive ? 'hrs-row-active' : ''}`}
                >
                  <span className="hrs-row-label">Hour {idx + 1}</span>
                  <input
                    id={`hrs-input-${idx}`}
                    type="number"
                    min="0"
                    max="200"
                    step="1"
                    value={val ?? 0}
                    onChange={(e) => handleChange(idx, e.target.value)}
                    className="hrs-input"
                    aria-label={`Hour ${idx + 1} rainfall in mm per hour`}
                  />
                  <span className="hrs-row-unit">mm/hr</span>
                  {isActive && <span className="hrs-active-tag">← ACTIVE</span>}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Rainfall Summary Below Schedule */}
      <div className="hrs-summary-box" id="hrs-summary-box">
        <div className="hrs-sum-line">
          <span className="hrs-sum-lbl">Total Scheduled Rainfall:</span>
          <span className="hrs-sum-val">{totalScheduledRainfall} mm</span>
        </div>
        <div className="hrs-sum-line">
          <span className="hrs-sum-lbl">Peak Rainfall:</span>
          <span className="hrs-sum-val">{peakRainfall} mm/hr</span>
        </div>
        <div className="hrs-sum-line">
          <span className="hrs-sum-lbl">Current Rainfall:</span>
          <span className="hrs-sum-val">{currentIntensity} mm/hr</span>
        </div>
        <div className="hrs-sum-line">
          <span className="hrs-sum-lbl">Current Hour:</span>
          <span className="hrs-sum-val">{currentHourIdx + 1} / 24</span>
        </div>
      </div>
    </div>
  )
}
