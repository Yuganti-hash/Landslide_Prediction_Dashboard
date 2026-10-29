import React from 'react'

const RAIN_PRESETS = [0, 10, 25, 50, 75, 100, 150, 200]

/**
 * RainfallControlPanel: Prominent rainfall control panel with vertical slider,
 * dynamic value indicator, preset buttons, Pause/Resume, and Reset controls.
 */
export default function RainfallControlPanel({
  rainfallMm = 50,
  onRainfallChange,
  isPaused = false,
  onTogglePause,
  onReset,
  simStatus = 'SIMULATION READY',
}) {
  const isZero = rainfallMm === 0

  return (
    <div className="rainfall-control-panel" aria-label="Rainfall simulation control panel">
      {/* ── Panel Header ── */}
      <div className="rain-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className={`rain-icon ${!isZero && !isPaused ? 'rain-pulse' : ''}`}>🌧️</span>
          <span className="rain-title">RAINFALL</span>
        </div>
        <span className={`rain-status-pill ${isZero ? 'gray' : isPaused ? 'amber' : 'cyan'}`}>
          {isZero ? 'NO RAINFALL' : isPaused ? 'PAUSED' : 'ACTIVE'}
        </span>
      </div>

      {/* ── Dynamic Value readout ── */}
      <div className="rain-readout-wrap">
        <span className="rain-label">Precipitation:</span>
        <span className="rain-current-val">{rainfallMm} mm</span>
      </div>

      {/* ── Vertical Continuous Slider Area ── */}
      <div className="rain-slider-container">
        <div className="rain-ticks-left">
          <span className="rain-tick-label" onClick={() => onRainfallChange(200)}>200</span>
          <span className="rain-tick-label" onClick={() => onRainfallChange(150)}>150</span>
          <span className="rain-tick-label" onClick={() => onRainfallChange(100)}>100</span>
          <span className="rain-tick-label" onClick={() => onRainfallChange(75)}>75</span>
          <span className="rain-tick-label" onClick={() => onRainfallChange(50)}>50</span>
          <span className="rain-tick-label" onClick={() => onRainfallChange(25)}>25</span>
          <span className="rain-tick-label" onClick={() => onRainfallChange(10)}>10</span>
          <span className="rain-tick-label" onClick={() => onRainfallChange(0)}>0</span>
        </div>

        <div className="rain-slider-track-wrap">
          {/* Vertical range input */}
          <input
            id="rainfall-slider"
            type="range"
            min={0}
            max={200}
            step={1}
            value={rainfallMm}
            onChange={(e) => onRainfallChange(Number(e.target.value))}
            className="rain-vertical-range"
            aria-label="Rainfall slider (0 to 200 mm)"
          />
        </div>

        {/* Visual precipitation intensity bar */}
        <div className="rain-bar-fill-wrap">
          <div
            className="rain-bar-fill"
            style={{
              height: `${(rainfallMm / 200) * 100}%`,
              background: isZero
                ? 'rgba(255,255,255,0.1)'
                : 'linear-gradient(to top, #0a2e6f 0%, #1275d4 50%, #00f0ff 100%)',
            }}
          />
        </div>
      </div>

      {/* ── Quick Preset Buttons ── */}
      <div className="rain-presets-wrap">
        <div className="rain-presets-grid">
          {RAIN_PRESETS.map((mm) => (
            <button
              key={mm}
              type="button"
              className={`rain-preset-btn ${rainfallMm === mm ? 'active' : ''}`}
              onClick={() => onRainfallChange(mm)}
              title={`Set rainfall to ${mm} mm`}
            >
              {mm}
            </button>
          ))}
        </div>
      </div>

      {/* ── Control Actions: Pause/Resume + Reset ── */}
      <div className="rain-actions-row">
        <button
          type="button"
          id="rain-pause-btn"
          className={`rain-action-btn ${isPaused ? 'resume' : 'pause'}`}
          onClick={onTogglePause}
          disabled={isZero}
          title={isPaused ? 'Resume rainfall animation' : 'Pause rainfall animation'}
        >
          {isPaused ? '▶ RESUME' : '⏸ PAUSE'}
        </button>

        <button
          type="button"
          id="rain-reset-btn"
          className="rain-action-btn reset"
          onClick={onReset}
          title="Reset rainfall to default (50 mm)"
        >
          ↺ RESET
        </button>
      </div>

      {/* ── Hydrological Simulation Status ── */}
      <div className="rain-status-footer">
        <span className="rain-substatus-dot" />
        <span className="rain-substatus-text">{simStatus}</span>
      </div>
    </div>
  )
}
