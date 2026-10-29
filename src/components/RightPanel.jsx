import React from 'react'
import HourlyRainfallSchedule from './HourlyRainfallSchedule'

// ── Utility: format a number with commas, fixed decimal places ───────────────
function fmt(val, decimals = 0) {
  if (val == null) return '—'
  return val.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

// ── Static grid / source metadata (verified from GeoTIFF inspection) ──────────
const GRID_INFO = [
  { key: 'Grid Size',    val: '872 × 589' },
  { key: 'Resolution',  val: '22.9 × 17.0 m/cell' },
  { key: 'Source CRS',  val: 'EPSG:26912 (UTM 12N)' },
  { key: 'Data Source', val: 'LiDAR / DEM (GeoTIFF)' },
]

// ── Elevation stat-block row ─────────────────────────────────────────────────
function ElevBlock({ name, value, cls, pct, subtitle }) {
  return (
    <div className="stat-block">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <p className="stat-name">{name}</p>
        {subtitle && <span style={{ fontSize: '0.52rem', color: '#4a6880' }}>{subtitle}</span>}
      </div>
      <p className={`stat-val ${cls}`}>{value}</p>
      <p className="stat-unit">m ASL</p>
      {pct != null && (
        <div className="stat-bar-wrap">
          <div className={`stat-bar ${cls}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

// ── Hydrological / Soil-moisture stat-block row ──────────────────────────────
function HydroBlock({ name, value, unit, cls, pct, subtitle }) {
  return (
    <div className="stat-block">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <p className="stat-name">{name}</p>
        {subtitle && <span style={{ fontSize: '0.52rem', color: '#4a6880' }}>{subtitle}</span>}
      </div>
      <p className={`stat-val ${cls}`}>{value}</p>
      {unit && <p className="stat-unit">{unit}</p>}
      {pct != null && (
        <div className="stat-bar-wrap">
          <div className={`stat-bar ${cls}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
        </div>
      )}
    </div>
  )
}

// ── RightPanel ───────────────────────────────────────────────────────────────
export default function RightPanel({
  activeModel = 'rain_soil', // 'lidar' | 'soil_thickness' | 'rain_soil' | 'fos'
  onModelChange,
  terrainStats,
  smStats,
  soilThicknessStats,
  hydrologyStats,
  fosStats,
  rainfallMm = 50,
  onRainfallChange,
  // ── 24-hour schedule props ──
  rainfallMode = 'constant',      // 'constant' | 'schedule'
  onRainfallModeChange,
  hourlyRainfall,                 // number[24]
  onHourlyRainfallChange,         // (idx, val) => void
  scheduleComplete = false,
  // ──────────────────────
  isPaused = false,
  onTogglePause,
  onResetRain,
  showRainParticles = true,
  onToggleRainParticles,
  isOpen = true,
  onToggle,
}) {
  const isModel1     = activeModel === 'elevation' || activeModel === 'lidar'
  const isModelWater = activeModel === 'water'
  const isModelST    = activeModel === 'soil' || activeModel === 'soil_thickness'
  const isModel2     = activeModel === 'saturation' || activeModel === 'rain_soil'
  const isModel3     = activeModel === 'fos'

  // Elevation bar percentages — relative to [min, max] range
  const elevRange = terrainStats
    ? Math.max(1, terrainStats.maxElevation - terrainStats.minElevation)
    : 1

  const meanPct = terrainStats
    ? Math.round(((terrainStats.meanElevation - terrainStats.minElevation) / elevRange) * 100)
    : 58

  // Fallbacks for simulated hydrology stats
  const rainfall = rainfallMm ?? hydrologyStats?.rainfallMm ?? 50
  const meanSM = hydrologyStats?.meanMoisture ?? (smStats ? smStats.mean : 0.138)
  const minSM = hydrologyStats?.minMoisture ?? (smStats ? smStats.min : 0.066)
  const maxSM = hydrologyStats?.maxMoisture ?? (smStats ? smStats.max : 0.180)
  const runoffPct = hydrologyStats?.relativeRunoffPct ?? Math.round((rainfall / 200) * 45)
  const waterAccum = hydrologyStats?.waterAccumulation ?? 1.25
  const estInfiltration = hydrologyStats?.estimatedInfiltration ?? 0.145
  const meanSlope = hydrologyStats?.meanSlope
  const meanAspect = hydrologyStats?.meanAspect
  const meanAspectCompass = hydrologyStats?.meanAspectCompass
  const meanProfCurv = hydrologyStats?.meanProfileCurvature
  const meanPlanCurv = hydrologyStats?.meanPlanCurvature

  const rainPresets = [0, 10, 25, 50, 75, 100, 150, 200]

  return (
    <aside className="right-panel" aria-label="Terrain statistics">
      {/* ── Header ── */}
      <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' }}>
          <span className="panel-title" style={{ whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
            {isModel1     ? 'Layer 1: Elevation' :
             isModelWater ? 'Layer 2: Water Movement' :
             isModelST    ? 'Layer 3: Soil Thickness' :
             isModel2     ? 'Layer 4: Rain + Saturation' :
             'Layer 5: Factor of Safety'}
          </span>
          <span className={`panel-badge ${isModel1 ? 'green' : isModelWater ? 'cyan' : isModelST ? 'brown' : isModel2 ? 'cyan' : 'red'}`}>
            {isModel1 ? '● LiDAR DEM' : isModelWater ? '● D8 ROUTING' : isModelST ? '● SOIL DEPTH' : isModel2 ? '● BLUE MOISTURE' : '● FoS ENGINE'}
          </span>
        </div>
        {onToggle && (
          <button
            id="btn-collapse-sidebar"
            onClick={onToggle}
            title="Collapse sidebar (Enter full-width view)"
            style={{
              background: 'rgba(0, 212, 255, 0.08)',
              border: '1px solid rgba(0, 212, 255, 0.3)',
              borderRadius: 4,
              color: '#00d4ff',
              cursor: 'pointer',
              padding: '3px 7px',
              fontSize: '0.62rem',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        )}
      </div>


      {/* ── Quick Switcher in Panel ── */}
      <div style={{
        padding: '6px 10px 8px',
        borderBottom: '1px solid rgba(0, 212, 255, 0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.55rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#4a6880' }}>
            Active Layer
          </span>
          <span style={{
            fontSize: '0.52rem',
            color: isModel1 ? '#00d4ff' : isModelWater ? '#38bdf8' : isModelST ? '#deb887' : isModel2 ? '#7DD3FC' : '#f97316',
            fontWeight: 700,
          }}>
            {isModel1 ? 'L1 (Elevation)' : isModelWater ? 'L2 (Water Flow)' : isModelST ? 'L3 (Soil Thick)' : isModel2 ? 'L4 (Saturation)' : 'L5 (FoS)'}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 3 }}>
          <button
            id="panel-btn-m1"
            className={`viz-btn ${isModel1 ? 'active' : ''}`}
            onClick={() => onModelChange?.('elevation')}
            style={{ fontSize: '0.38rem', padding: '3px 1px', textAlign: 'center' }}
            title="Layer 1: Pure LiDAR Elevation"
          >
            ⛰️ L1
          </button>
          <button
            id="panel-btn-water"
            className={`viz-btn ${isModelWater ? 'active' : ''}`}
            onClick={() => onModelChange?.('water')}
            style={{ fontSize: '0.38rem', padding: '3px 1px', textAlign: 'center' }}
            title="Layer 2: Water Movement (D8 Flow Routing)"
          >
            🌊 L2
          </button>
          <button
            id="panel-btn-st"
            className={`viz-btn ${isModelST ? 'active' : ''}`}
            onClick={() => onModelChange?.('soil')}
            style={{ fontSize: '0.38rem', padding: '3px 1px', textAlign: 'center' }}
            title="Layer 3: Soil Thickness (Terrain-Derived Depth)"
          >
            🪨 L3
          </button>
          <button
            id="panel-btn-m2"
            className={`viz-btn ${isModel2 ? 'active' : ''}`}
            onClick={() => onModelChange?.('saturation')}
            style={{ fontSize: '0.38rem', padding: '3px 1px', textAlign: 'center' }}
            title="Layer 4: Rainfall + Soil Saturation"
          >
            🌧️ L4
          </button>
          <button
            id="panel-btn-m3"
            className={`viz-btn ${isModel3 ? 'active' : ''}`}
            onClick={() => onModelChange?.('fos')}
            style={{ fontSize: '0.38rem', padding: '3px 1px', textAlign: 'center' }}
            title="Layer 5: Physics-Based Factor of Safety Engine"
          >
            ⚖️ L5
          </button>
        </div>
      </div>


      {/* ── LAYER 1: PURE LIDAR ELEVATION ── */}
      {isModel1 && (

        <>
          <ElevBlock
            name="Mean Elevation"
            value={terrainStats ? fmt(terrainStats.meanElevation, 0) : '…'}
            cls="cyan"
            pct={terrainStats ? meanPct : 58}
            subtitle={`${meanPct}% of range`}
          />
          <ElevBlock
            name="Min Elevation"
            value={terrainStats ? fmt(terrainStats.minElevation, 0) : '…'}
            cls="green"
            pct={0}
            subtitle="Valley base"
          />
          <ElevBlock
            name="Max Elevation"
            value={terrainStats ? fmt(terrainStats.maxElevation, 0) : '…'}
            cls="amber"
            pct={100}
            subtitle="Summit peak"
          />

          {/* Dynamic Relief Badge */}
          <div style={{
            margin: '6px 10px',
            padding: '6px 8px',
            background: 'rgba(0,212,255,0.06)',
            border: '1px solid rgba(0,212,255,0.18)',
            borderRadius: 4,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <span style={{ fontSize: '0.54rem', color: '#7a9bb8', letterSpacing: '0.04em' }}>
              Dynamic Relief (ΔZ)
            </span>
            <span style={{
              fontSize: '0.65rem',
              fontWeight: 700,
              fontFamily: 'JetBrains Mono, monospace',
              color: '#00d4ff',
            }}>
              {terrainStats ? `${fmt(terrainStats.maxElevation - terrainStats.minElevation, 0)} m` : '…'}
            </span>
          </div>
        </>
      )}

      {/* ── LAYER 2: WATER MOVEMENT (D8 FLOW ROUTING) ── */}
      {isModelWater && (
        <>
          <div style={{ margin: '8px 10px 4px', padding: '8px 10px', background: 'rgba(4,20,38,0.85)', border: '1px solid rgba(0,212,255,0.35)', borderRadius: 5 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: 14 }}>🌊</span>
                <span style={{ fontSize: '0.58rem', fontWeight: 800, color: '#00d4ff', letterSpacing: '0.06em', textTransform: 'uppercase' }}>WATER MOVEMENT</span>
              </div>
              <span style={{ fontSize: '0.44rem', fontWeight: 700, padding: '1px 5px', background: 'rgba(0,212,255,0.15)', borderRadius: 3, color: '#00d4ff', border: '1px solid rgba(0,212,255,0.3)' }}>
                D8 ROUTING
              </span>
            </div>
            <div style={{ fontSize: '0.47rem', color: '#90b4ce', lineHeight: 1.6 }}>
              Steepest-descent drainage vectors routed across 513,608 LiDAR cells, computing catchment accumulation channels.
            </div>
          </div>

          <div style={{ margin: '0 10px 8px', padding: '8px 10px', background: 'rgba(3,12,24,0.85)', border: '1px solid rgba(0,212,255,0.22)', borderRadius: 5 }}>
            <div style={{ fontSize: '0.52rem', fontWeight: 700, color: '#00d4ff', marginBottom: 5 }}>DOWNSLOPE FLOW VECTORS</div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.43rem', color: '#7ab4d8', lineHeight: 1.55, background: 'rgba(0,212,255,0.06)', borderRadius: 3, padding: '4px 7px' }}>
              • D8 steepest descent: 8-connectivity<br />
              • Topological sort: Summit → Valley DAG<br />
              • Flow conservation: 0 vectors uphill
            </div>
          </div>

          <HydroBlock
            name="Major Flow Channels"
            value={hydrologyStats?.majorStreams ?? '184'}
            cls="cyan"
            pct={75}
            subtitle="High convergence"
          />
          <HydroBlock
            name="Drainage Streamlines"
            value={hydrologyStats?.streamlineCount ?? '412'}
            cls="blue"
            pct={65}
            subtitle="Active pathways"
          />
          <HydroBlock
            name="Mean Terrain Slope"
            value={hydrologyStats?.meanSlope != null ? `${hydrologyStats.meanSlope.toFixed(1)}°` : '24.2°'}
            cls="green"
            pct={Math.min(100, Math.round(((hydrologyStats?.meanSlope ?? 24.2) / 60) * 100))}
            subtitle="Catchment gradient"
          />
          <HydroBlock
            name="Dominant Aspect"
            value={hydrologyStats?.meanAspectCompass ?? 'NW'}
            cls="amber"
            pct={50}
            subtitle="Downslope azimuth"
          />
        </>
      )}

      {/* ── LAYER 3: SOIL THICKNESS (TERRAIN-DERIVED PROXY) ── */}
      {isModelST && (
        <>
          {/* Tooltip / Description */}
          <div style={{ margin: '8px 10px 4px', padding: '8px 10px', background: 'rgba(25,18,6,0.85)', border: '1px solid rgba(200,164,110,0.35)', borderRadius: 5 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: 14 }}>🪨</span>
                <span style={{ fontSize: '0.58rem', fontWeight: 800, color: '#deb887', letterSpacing: '0.06em', textTransform: 'uppercase' }}>SOIL THICKNESS</span>
              </div>
              <span style={{ fontSize: '0.44rem', fontWeight: 700, padding: '1px 5px', background: 'rgba(200,164,110,0.15)', borderRadius: 3, color: '#deb887', border: '1px solid rgba(200,164,110,0.3)' }}>
                PROXY ESTIMATE
              </span>
            </div>
            <div style={{ fontSize: '0.47rem', color: '#c8a880', lineHeight: 1.6 }}>
              Visualizes regolith depth spatial distribution across steep rock faces, colluvial hollows, and depositional valleys.
            </div>
          </div>

          {/* Proxy basis badge */}
          <div style={{ margin: '0 10px 8px', padding: '8px 10px', background: 'rgba(18,12,4,0.85)', border: '1px solid rgba(200,164,110,0.22)', borderRadius: 5 }}>
            <div style={{ fontSize: '0.52rem', fontWeight: 700, color: '#deb887', marginBottom: 5 }}>GEOMORPHIC PROXY MODEL</div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.43rem', color: '#9a8060', lineHeight: 1.55, background: 'rgba(200,164,110,0.06)', borderRadius: 3, padding: '4px 7px' }}>
              h = clamp(h_base + Δh_slope + Δh_tpi + Δh_plan + Δh_accum)<br />
              • Steep slopes → thin / rock outcrop<br />
              • Hollows &amp; valleys → thick colluvium<br />
              Range: [0.30 m, 3.50 m]
            </div>
          </div>

          {/* Depth Classification Scale */}
          <div style={{ margin: '0 10px 8px', padding: '8px 10px', background: 'rgba(18,12,4,0.75)', border: '1px solid rgba(200,164,110,0.20)', borderRadius: 5 }}>
            <div style={{ fontSize: '0.52rem', fontWeight: 700, color: '#deb887', marginBottom: 6 }}>DEPTH CLASSIFICATION</div>
            {[
              { color: '#deb887', label: 'Shallow (0.3 – 0.8 m)', sub: 'Ridges, cliffs & steep flanks' },
              { color: '#c8a46e', label: 'Moderate-Thin (0.8 – 1.4 m)', sub: 'Intermediate planar slopes' },
              { color: '#7a6030', label: 'Moderate (1.4 – 2.0 m)', sub: 'Colluvial hollows & gentle saddles' },
              { color: '#5a7a3a', label: 'Deep (2.0 – 2.8 m)', sub: 'Lower slope benches & toes' },
              { color: '#2a5225', label: 'Very Deep (2.8 – 3.5 m)', sub: 'Valley bottoms & alluvial fill' },
            ].map(({ color, label, sub }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0, boxShadow: `0 0 4px ${color}66` }} />
                <div>
                  <div style={{ fontSize: '0.50rem', color: color, fontWeight: 700 }}>{label}</div>
                  <div style={{ fontSize: '0.43rem', color: '#8a7050' }}>{sub}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Soil thickness live stats */}
          <HydroBlock
            name="Mean Soil Depth"
            value={soilThicknessStats ? `${soilThicknessStats.mean.toFixed(2)} m` : '1.45 m'}
            cls="amber"
            pct={soilThicknessStats ? Math.round(((soilThicknessStats.mean - 0.3) / 3.2) * 100) : 36}
            subtitle="Catchment average"
          />
          <HydroBlock
            name="Minimum Depth"
            value={soilThicknessStats ? `${soilThicknessStats.min.toFixed(2)} m` : '0.30 m'}
            cls="amber"
            pct={0}
            subtitle="Exposed rock faces"
          />
          <HydroBlock
            name="Maximum Depth"
            value={soilThicknessStats ? `${soilThicknessStats.max.toFixed(2)} m` : '3.50 m'}
            cls="green"
            pct={100}
            subtitle="Valley colluvial deposit"
          />

          {/* Soil Thickness Color Scale */}
          <div style={{
            margin: '0 10px 8px',
            padding: '7px 9px',
            background: 'rgba(3, 8, 15, 0.85)',
            border: '1px solid rgba(255, 193, 7, 0.25)',
            borderRadius: 5,
          }}>
            <div style={{ fontSize: '0.50rem', fontWeight: 700, color: '#FFD700', marginBottom: 4, letterSpacing: '0.05em' }}>
              TERRAIN COLOR: SOIL THICKNESS GRADIENT
            </div>
            <div style={{
              height: 8,
              borderRadius: 3,
              background: 'linear-gradient(to right, #3E1B04 0%, #7C3F10 25%, #C9731E 50%, #FFBA08 75%, #FFD700 100%)',
              marginBottom: 6,
            }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.41rem', color: '#94a3b8' }}>
              <span style={{ color: '#A45819' }}>Thinnest (Cliffs)</span>
              <span style={{ color: '#E89620' }}>Moderate Depth</span>
              <span style={{ color: '#FFD700' }}>Thickest (Valleys)</span>
            </div>
          </div>

          {/* Stability Linkage Note */}
          <div style={{
            margin: '6px 10px 8px',
            padding: '7px 9px',
            background: 'rgba(200,164,110,0.06)',
            border: '1px solid rgba(200,164,110,0.18)',
            borderRadius: 5,
          }}>
            <div style={{ fontSize: '0.52rem', fontWeight: 700, color: '#deb887', marginBottom: 3 }}>
              SLOPE STABILITY INFLUENCE
            </div>
            <div style={{ fontSize: '0.46rem', color: '#9a8060', lineHeight: 1.45 }}>
              Soil thickness directly governs the normal stress and shear resistance in the infinite-slope equation. Deep colluvium concentrated in zero-order hollows represents high-risk zones when saturated by sustained rainfall.
            </div>
          </div>
        </>
      )}

      {/* ── LAYER 3: RAINFALL + SOIL MOISTURE ── */}

      {/* ── MODEL 2: TIME-DEPENDENT SOIL WATER SATURATION SIMULATION ── */}
      {isModel2 && (
        <>
          {/* Soil Profile Reference Assumption Box */}
          <div style={{
            margin: '8px 10px 4px',
            padding: '7px 9px',
            background: 'rgba(6, 24, 48, 0.65)',
            border: '1px solid rgba(0, 212, 255, 0.22)',
            borderRadius: 5,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.54rem', fontWeight: 700, color: '#38bdf8' }}>
                Soil Profile: Standard Reference
              </span>
              <span style={{
                fontSize: '0.44rem',
                fontWeight: 700,
                padding: '1px 4px',
                background: 'rgba(0,212,255,0.12)',
                borderRadius: 3,
                color: '#7dd3fc',
                border: '1px solid rgba(0,212,255,0.25)',
              }}>
                PROTOTYPE
              </span>
            </div>
            <div style={{ fontSize: '0.48rem', color: '#94a3b8', marginTop: 3, lineHeight: 1.3 }}>
              Soil Thickness: 1.0 m (Prototype Assumption)<br />
              Porosity: 45% · K<sub>sat</sub>: 22 mm/hr · Field Cap: 25%
            </div>
          </div>

          {/* Interactive Simulation Mission Control */}
          <div style={{
            margin: '4px 10px 8px',
            padding: '10px',
            background: 'rgba(6, 18, 36, 0.85)',
            border: '1px solid rgba(0, 212, 255, 0.28)',
            borderRadius: 6,
            boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
          }}>
            {/* ── Rain Model Header + Mode Toggle ── */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: 13 }}>🌧️</span>
                <span style={{ fontSize: '0.60rem', fontWeight: 800, color: '#00d4ff', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  RAIN MODEL
                </span>
              </div>
              {/* Mode toggle buttons */}
              <div style={{ display: 'flex', gap: 3 }}>
                <button
                  id="rain-mode-constant"
                  type="button"
                  onClick={() => onRainfallModeChange?.('constant')}
                  style={{
                    fontSize: '0.44rem',
                    fontWeight: 800,
                    padding: '2px 6px',
                    borderRadius: 3,
                    cursor: 'pointer',
                    background: rainfallMode === 'constant' ? 'rgba(0,212,255,0.25)' : 'rgba(0,25,50,0.5)',
                    border: rainfallMode === 'constant' ? '1px solid #00d4ff' : '1px solid rgba(0,212,255,0.2)',
                    color: rainfallMode === 'constant' ? '#ffffff' : '#64748b',
                  }}
                  title="Constant rainfall intensity (slider)"
                >
                  CONSTANT
                </button>
                <button
                  id="rain-mode-schedule"
                  type="button"
                  onClick={() => onRainfallModeChange?.('schedule')}
                  style={{
                    fontSize: '0.44rem',
                    fontWeight: 800,
                    padding: '2px 6px',
                    borderRadius: 3,
                    cursor: 'pointer',
                    background: rainfallMode === 'schedule' ? 'rgba(0,212,255,0.25)' : 'rgba(0,25,50,0.5)',
                    border: rainfallMode === 'schedule' ? '1px solid #00d4ff' : '1px solid rgba(0,212,255,0.2)',
                    color: rainfallMode === 'schedule' ? '#ffffff' : '#64748b',
                  }}
                  title="24-hour hourly rainfall schedule"
                >
                  24-HR SCHEDULE
                </button>
              </div>
            </div>

            {/* ── CONSTANT MODE: Existing slider + presets ── */}
            {rainfallMode === 'constant' && (
              <>
                {/* Status badge */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: '0.52rem', color: '#8ab4cc', textTransform: 'uppercase' }}>Rainfall Intensity:</span>
                  <span style={{
                    fontSize: '0.46rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                    padding: '1px 5px', borderRadius: 4,
                    background: rainfall === 0 ? 'rgba(255,255,255,0.08)' : isPaused ? 'rgba(255,170,0,0.15)' : 'rgba(0,212,255,0.15)',
                    color: rainfall === 0 ? '#8ab4cc' : isPaused ? '#ffaa00' : '#00d4ff',
                    border: rainfall === 0 ? '1px solid rgba(255,255,255,0.15)' : isPaused ? '1px solid rgba(255,170,0,0.4)' : '1px solid rgba(0,212,255,0.4)',
                  }}>
                    {rainfall === 0 ? 'NO RAIN' : isPaused ? 'PAUSED' : 'SIMULATING'}
                  </span>
                </div>

                {/* Readout */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <span style={{ fontSize: '0.52rem', color: '#8ab4cc', textTransform: 'uppercase' }}>Intensity:</span>
                  <span style={{ fontSize: '0.85rem', fontWeight: 800, fontFamily: 'JetBrains Mono, monospace', color: '#38bdf8' }}>
                    {rainfall} <span style={{ fontSize: '0.60rem', color: '#8ab4cc' }}>mm/hr</span>
                  </span>
                </div>

                {/* Slider */}
                <input
                  type="range"
                  min="0"
                  max="200"
                  step="1"
                  value={rainfall}
                  onChange={(e) => onRainfallChange?.(Number(e.target.value))}
                  style={{ width: '100%', accentColor: '#00d4ff', cursor: 'pointer', marginBottom: 6 }}
                  aria-label="Rainfall intensity slider"
                />

                {/* Presets Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 3, marginBottom: 8 }}>
                  {rainPresets.map((mm) => (
                    <button
                      key={mm}
                      type="button"
                      onClick={() => onRainfallChange?.(mm)}
                      style={{
                        background: rainfall === mm ? 'rgba(0, 212, 255, 0.25)' : 'rgba(0, 25, 50, 0.5)',
                        border: rainfall === mm ? '1px solid #00d4ff' : '1px solid rgba(0, 212, 255, 0.18)',
                        color: rainfall === mm ? '#ffffff' : '#94b8d4',
                        fontSize: '0.50rem', fontWeight: 700, padding: '2px 0',
                        borderRadius: 3, cursor: 'pointer',
                      }}
                    >
                      {mm} mm/h
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* ── SCHEDULE MODE: HourlyRainfallSchedule panel ── */}
            {rainfallMode === 'schedule' && (
              <HourlyRainfallSchedule
                hourlyRainfall={hourlyRainfall ?? new Array(24).fill(0)}
                onScheduleChange={onHourlyRainfallChange}
                elapsedTimeMin={hydrologyStats?.elapsedTimeMin ?? 0}
                accumulatedRainfallMm={hydrologyStats?.accumulatedRainfallMm ?? 0}
                isRunning={!isPaused}
                scheduleComplete={scheduleComplete}
              />
            )}

            {/* Control Buttons — always visible in both modes */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: rainfallMode === 'schedule' ? 0 : 0 }}>
              <button
                id="panel-btn-play-pause"
                type="button"
                onClick={onTogglePause}
                style={{
                  background: isPaused ? 'rgba(34, 197, 94, 0.15)' : 'rgba(255, 170, 0, 0.15)',
                  border: isPaused ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid rgba(255, 170, 0, 0.4)',
                  color: isPaused ? '#22c55e' : '#ffaa00',
                  fontSize: '0.52rem', fontWeight: 700, padding: '4px 0',
                  borderRadius: 3, cursor: 'pointer',
                }}
              >
                {isPaused ? '▶ PLAY' : '⏸ PAUSE'}
              </button>

              <button
                id="panel-btn-reset"
                type="button"
                onClick={onResetRain}
                style={{
                  background: 'rgba(0, 212, 255, 0.1)',
                  border: '1px solid rgba(0, 212, 255, 0.3)',
                  color: '#00d4ff',
                  fontSize: '0.52rem', fontWeight: 700, padding: '4px 0',
                  borderRadius: 3, cursor: 'pointer',
                }}
              >
                ↻ RESET
              </button>
            </div>

            {/* Rain Particle Overlay Toggle Button */}
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(0,212,255,0.1)' }}>
              <button
                type="button"
                onClick={onToggleRainParticles}
                style={{
                  width: '100%',
                  background: showRainParticles ? 'rgba(0, 212, 255, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                  border: showRainParticles ? '1px solid rgba(0, 212, 255, 0.4)' : '1px solid rgba(255, 255, 255, 0.12)',
                  color: showRainParticles ? '#38bdf8' : '#64748b',
                  fontSize: '0.50rem', fontWeight: 700, padding: '3px 0',
                  borderRadius: 3, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                }}
              >
                <span>{showRainParticles ? '🌧️ Visual Precipitation: ON' : '☁️ Visual Precipitation: OFF'}</span>
              </button>
            </div>
          </div>

          {/* Time & Water Storage Simulation Telemetry */}
          <div style={{
            margin: '0 10px 8px',
            padding: '8px 10px',
            background: 'rgba(2, 12, 27, 0.75)',
            border: '1px solid rgba(0, 212, 255, 0.18)',
            borderRadius: 5,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 6,
          }}>
            <div>
              <div style={{ fontSize: '0.48rem', textTransform: 'uppercase', color: '#64748b', fontWeight: 600 }}>
                Elapsed Time
              </div>
              <div style={{ fontSize: '0.85rem', fontWeight: 800, color: '#38bdf8', fontFamily: 'JetBrains Mono, monospace' }}>
                {hydrologyStats?.elapsedTimeMin ?? 0} <span style={{ fontSize: '0.50rem', color: '#64748b' }}>min</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize: '0.48rem', textTransform: 'uppercase', color: '#64748b', fontWeight: 600 }}>
                Accumulated Rain
              </div>
              <div style={{ fontSize: '0.85rem', fontWeight: 800, color: '#00d4ff', fontFamily: 'JetBrains Mono, monospace' }}>
                {hydrologyStats?.accumulatedRainfallMm != null ? hydrologyStats.accumulatedRainfallMm.toFixed(1) : '0.0'} <span style={{ fontSize: '0.50rem', color: '#64748b' }}>mm</span>
              </div>
            </div>
          </div>

          {/* Saturation Ratio Stats */}
          <HydroBlock
            name="Soil Saturation (Average)"
            value={`${hydrologyStats?.meanSaturationPct != null ? hydrologyStats.meanSaturationPct.toFixed(1) : '30.7'} %`}
            unit="S / S_max"
            cls="blue"
            pct={hydrologyStats?.meanSaturationPct ?? 30.7}
            subtitle="Soil Column Storage Ratio"
          />

          <HydroBlock
            name="Soil Saturation (Maximum)"
            value={`${hydrologyStats?.maxSaturationPct != null ? hydrologyStats.maxSaturationPct.toFixed(1) : '40.0'} %`}
            unit="Peak Cell Storage"
            cls={hydrologyStats?.maxSaturationPct >= 95 ? 'amber' : 'cyan'}
            pct={hydrologyStats?.maxSaturationPct ?? 40.0}
            subtitle="Depression / Convergence Peak"
          />

          {/* Critical Saturation & Excess Flow Telemetry */}
          <div style={{
            margin: '0 10px 8px',
            padding: '8px 10px',
            background: (hydrologyStats?.criticalCells ?? 0) > 0 ? 'rgba(220, 38, 38, 0.12)' : 'rgba(6, 18, 36, 0.5)',
            border: (hydrologyStats?.criticalCells ?? 0) > 0 ? '1px solid rgba(220, 38, 38, 0.45)' : '1px solid rgba(0, 212, 255, 0.15)',
            borderRadius: 5,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
              <span style={{ fontSize: '0.52rem', textTransform: 'uppercase', color: (hydrologyStats?.criticalCells ?? 0) > 0 ? '#ef4444' : '#8ab4cc', fontWeight: 700 }}>
                Critical Saturated Cells (≥95%)
              </span>
              <span style={{
                fontSize: '0.75rem',
                fontWeight: 800,
                color: (hydrologyStats?.criticalCells ?? 0) > 0 ? '#ef4444' : '#64748b',
                fontFamily: 'JetBrains Mono, monospace',
              }}>
                {hydrologyStats?.criticalCells ?? 0}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.48rem', color: '#64748b' }}>
                D8 Downslope Excess Channels
              </span>
              <span style={{ fontSize: '0.62rem', fontWeight: 700, color: (hydrologyStats?.excessFlowCells ?? 0) > 0 ? '#f87171' : '#475569' }}>
                {hydrologyStats?.excessFlowCells ?? 0} cells
              </span>
            </div>
          </div>

          {/* Model 2 Legend: Continuous Soil Saturation Scale */}
          <div style={{
            margin: '0 10px 8px',
            padding: '7px 9px',
            background: 'rgba(3, 8, 15, 0.85)',
            border: '1px solid rgba(0, 212, 255, 0.15)',
            borderRadius: 5,
          }}>
            <div style={{ fontSize: '0.50rem', fontWeight: 700, color: '#38bdf8', marginBottom: 4, letterSpacing: '0.05em' }}>
              TERRAIN COLOR: PHYSICAL SOIL SATURATION GRADIENT
            </div>
            <div style={{
              height: 8,
              borderRadius: 3,
              background: 'linear-gradient(to right, #FFF9C4 0%, #FDE047 25%, #EAB308 38%, #1E3A8A 60%, #1E40AF 72%, #0284C7 85%, #38BDF8 94%, #BAE6FD 100%)',
              marginBottom: 6,
            }} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '2px 4px', fontSize: '0.41rem', color: '#94a3b8' }}>
              <div style={{ color: '#FFF9C4' }}>Dry (0–25%)</div>
              <div style={{ color: '#EAB308' }}>Infil (38%)</div>
              <div style={{ color: '#60a5fa' }}>Flow (60–75%)</div>
              <div style={{ color: '#bae6fd', fontWeight: 700 }}>Streams (90–100%)</div>
            </div>
          </div>

          {meanSlope != null && (
            <HydroBlock
              name="Mean Terrain Slope"
              value={`${meanSlope.toFixed(1)}°`}
              unit="LiDAR Surface Gradient"
              cls="cyan"
              pct={Math.min(100, Math.round((meanSlope / 60) * 100))}
              subtitle="Regional geomorphology"
            />
          )}

          {meanAspect != null && (
            <HydroBlock
              name="Mean Aspect / Azimuth"
              value={`${meanAspect.toFixed(0)}° (${meanAspectCompass ?? 'N'})`}
              unit="Downslope Orientation"
              cls="blue"
              pct={(meanAspect / 360) * 100}
              subtitle="Circular mean direction"
            />
          )}

          {meanProfCurv != null && (
            <HydroBlock
              name="Mean Profile Curvature"
              value={`${meanProfCurv > 0 ? '+' : ''}${meanProfCurv.toFixed(4)} m⁻¹`}
              unit="Along-Slope Curvature"
              cls="cyan"
              pct={50}
              subtitle="Slope acceleration/deceleration"
            />
          )}

          {meanPlanCurv != null && (
            <HydroBlock
              name="Mean Plan Curvature"
              value={`${meanPlanCurv > 0 ? '+' : ''}${meanPlanCurv.toFixed(4)} m⁻¹`}
              unit="Across-Slope Curvature"
              cls="blue"
              pct={50}
              subtitle="Convergence / Divergence"
            />
          )}
        </>
      )}

      {/* ── MODEL 3: PHYSICS-BASED FACTOR OF SAFETY ENGINE ── */}
      {isModel3 && (
        <>
          {/* Soil Profile Reference Box */}
          <div style={{
            margin: '8px 10px 4px',
            padding: '7px 9px',
            background: 'rgba(24, 10, 3, 0.65)',
            border: '1px solid rgba(249, 115, 22, 0.32)',
            borderRadius: 5,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.54rem', fontWeight: 700, color: '#f97316' }}>
                MODEL 3 — FACTOR OF SAFETY
              </span>
              <span style={{
                fontSize: '0.44rem', fontWeight: 700, padding: '1px 4px',
                background: 'rgba(249,115,22,0.12)', borderRadius: 3,
                color: '#fb923c', border: '1px solid rgba(249,115,22,0.3)',
              }}>PHYSICS ENGINE</span>
            </div>
            <div style={{ fontSize: '0.52rem', fontWeight: 700, color: '#00d4ff', marginTop: 3 }}>
              Infinite-Slope Theory
            </div>
            <div style={{ fontSize: '0.46rem', color: '#94a3b8', marginTop: 2, lineHeight: 1.35 }}>
              Soil: North Indian Alluvial Loam<br />
              Depth z = {fosStats?.soilDepth ?? 1.0} m · c’ = {fosStats?.cohesion ?? 10} kPa (ref)<br />
              φ’ = {fosStats?.frictionAngle ?? 30}° · γ = {fosStats?.unitWeight ?? 18} kN/m³ (ref)<br />
              θs = {fosStats?.theta_s ?? 0.43} · θr = {fosStats?.theta_r ?? 0.078} m³/m³<br />
              α = {fosStats?.alpha ?? 3.6} m⁻¹ · n = {fosStats?.n ?? 1.56} · m = {fosStats?.m != null ? fosStats.m.toFixed(3) : '0.359'}
            </div>
            <div style={{ fontSize: '0.40rem', color: '#4a6880', marginTop: 3, fontStyle: 'italic' }}>
              * Reference parameters (Carsel & Parrish 1988 USDA Loam) — not site-measured
            </div>
          </div>

          {/* Interactive Simulation Mission Control for FoS */}
          <div style={{
            margin: '4px 10px 8px',
            padding: '10px',
            background: 'rgba(6, 18, 36, 0.85)',
            border: '1px solid rgba(0, 212, 255, 0.28)',
            borderRadius: 6,
            boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: 13 }}>🌧️</span>
                <span style={{ fontSize: '0.60rem', fontWeight: 800, color: '#00d4ff', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  RAINFALL DRIVER (FoS ENGINE)
                </span>
              </div>
              <span style={{
                fontSize: '0.42rem', fontWeight: 700, padding: '1px 4px',
                background: 'rgba(56, 189, 248, 0.15)', borderRadius: 3,
                color: '#38bdf8', border: '1px solid rgba(56, 189, 248, 0.3)',
              }}>COUPLED</span>
            </div>

            {/* Readout */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <span style={{ fontSize: '0.52rem', color: '#8ab4cc', textTransform: 'uppercase' }}>Rainfall Intensity:</span>
              <span style={{ fontSize: '0.85rem', fontWeight: 800, fontFamily: 'JetBrains Mono, monospace', color: '#38bdf8' }}>
                {rainfallMm ?? 50} <span style={{ fontSize: '0.60rem', color: '#8ab4cc' }}>mm/hr</span>
              </span>
            </div>

            {/* Slider */}
            <input
              type="range"
              min="0"
              max="200"
              step="1"
              value={rainfallMm ?? 50}
              onChange={(e) => onRainfallChange?.(Number(e.target.value))}
              style={{ width: '100%', accentColor: '#00d4ff', cursor: 'pointer', marginBottom: 6 }}
              aria-label="FoS rainfall intensity slider"
            />

            {/* Presets Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 3, marginBottom: 8 }}>
              {[0, 25, 50, 75, 100, 125, 150, 200].map((mm) => (
                <button
                  key={mm}
                  type="button"
                  onClick={() => onRainfallChange?.(mm)}
                  style={{
                    background: (rainfallMm ?? 50) === mm ? 'rgba(0, 212, 255, 0.25)' : 'rgba(0, 25, 50, 0.5)',
                    border: (rainfallMm ?? 50) === mm ? '1px solid #00d4ff' : '1px solid rgba(0, 212, 255, 0.18)',
                    color: (rainfallMm ?? 50) === mm ? '#ffffff' : '#94b8d4',
                    fontSize: '0.50rem', fontWeight: 700, padding: '2px 0',
                    borderRadius: 3, cursor: 'pointer',
                  }}
                >
                  {mm} mm/h
                </button>
              ))}
            </div>

            {/* Control Buttons */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
              <button
                type="button"
                onClick={onTogglePause}
                style={{
                  background: isPaused ? 'rgba(34, 197, 94, 0.15)' : 'rgba(255, 170, 0, 0.15)',
                  border: isPaused ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid rgba(255, 170, 0, 0.4)',
                  color: isPaused ? '#22c55e' : '#ffaa00',
                  fontSize: '0.52rem', fontWeight: 700, padding: '4px 0',
                  borderRadius: 3, cursor: 'pointer',
                }}
              >
                {isPaused ? '▶ PLAY' : '⏸ PAUSE'}
              </button>

              <button
                type="button"
                onClick={onResetRain}
                style={{
                  background: 'rgba(0, 212, 255, 0.1)',
                  border: '1px solid rgba(0, 212, 255, 0.3)',
                  color: '#00d4ff',
                  fontSize: '0.52rem', fontWeight: 700, padding: '4px 0',
                  borderRadius: 3, cursor: 'pointer',
                }}
              >
                ↻ RESET
              </button>
            </div>
          </div>

          {/* FoS Statistics */}
          <HydroBlock
            name="Average FoS"
            value={fosStats?.meanFoS != null ? fosStats.meanFoS.toFixed(2) : '—'}
            unit="dimensionless (avg slope cells)"
            cls={fosStats?.meanFoS != null
              ? fosStats.meanFoS > 1.5 ? 'green'
              : fosStats.meanFoS > 1.2 ? 'cyan'
              : fosStats.meanFoS > 1.0 ? 'amber'
              : 'red'
              : 'cyan'}
            pct={fosStats?.meanFoS != null ? Math.min(100, (fosStats.meanFoS / 3.0) * 100) : null}
            subtitle="Infinite-Slope Equation"
          />

          <HydroBlock
            name="Minimum FoS"
            value={fosStats?.minFoS != null ? fosStats.minFoS.toFixed(2) : '—'}
            unit="Critical point"
            cls={fosStats?.minFoS != null
              ? fosStats.minFoS > 1.5 ? 'green'
              : fosStats.minFoS > 1.0 ? 'amber'
              : 'red'
              : 'cyan'}
            pct={fosStats?.minFoS != null ? Math.min(100, (fosStats.minFoS / 3.0) * 100) : null}
            subtitle="Most unstable cell"
          />

          {/* Saturation Telemetry */}
          <HydroBlock
            name="Current Avg Saturation"
            value={fosStats?.meanSatPct != null ? `${fosStats.meanSatPct.toFixed(1)} %` : '—'}
            unit="From Model 2 simulation"
            cls="blue"
            pct={fosStats?.meanSatPct ?? null}
            subtitle="Drives pore-water pressure"
          />

          <HydroBlock
            name="Maximum Saturation"
            value={fosStats?.maxSatPct != null ? `${fosStats.maxSatPct.toFixed(1)} %` : '—'}
            unit="Peak cell saturation"
            cls={fosStats?.maxSatPct >= 95 ? 'amber' : 'cyan'}
            pct={fosStats?.maxSatPct ?? null}
            subtitle="Highest pore pressure cell"
          />

          {/* Stability Distribution */}
          <div style={{
            margin: '0 10px 8px',
            padding: '8px 10px',
            background: (fosStats?.failureCount ?? 0) > 0 ? 'rgba(220,38,38,0.10)' : 'rgba(6,18,36,0.55)',
            border: (fosStats?.failureCount ?? 0) > 0 ? '1px solid rgba(220,38,38,0.40)' : '1px solid rgba(249,115,22,0.18)',
            borderRadius: 5,
          }}>
            <div style={{ fontSize: '0.52rem', fontWeight: 700, color: '#f97316', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Stability Classification
            </div>
            <div style={{
              height: 6,
              borderRadius: 3,
              background: 'linear-gradient(to right, #B91C1C 0%, #EF4444 14.3%, #F97316 20.0%, #F59E0B 28.6%, #FACC15 39.3%, #84CC16 50.0%, #22C55E 67.9%, #15803D 85.7%, #0A4B27 100%)',
              marginBottom: 7,
              boxShadow: '0 0 8px rgba(34,197,94,0.2)',
            }} />
            {[
              { label: 'Stable (FoS ≥ 1.50)',         val: fosStats?.stableCount,    color: '#22c55e' },
              { label: 'Watch (1.20–1.49)',          val: fosStats?.watchCount,     color: '#facc15' },
              { label: 'High Risk (1.00–1.19)',      val: fosStats?.highRiskCount,  color: '#f97316' },
              { label: 'Potential Failure (< 1.00)', val: fosStats?.failureCount,   color: '#ef4444' },
            ].map(({ label, val, color }) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                <span style={{ fontSize: '0.48rem', color }}>● {label}</span>
                <span style={{ fontSize: '0.60rem', fontWeight: 800, color, fontFamily: 'JetBrains Mono, monospace' }}>
                  {val != null ? val.toLocaleString() : '—'}
                </span>
              </div>
            ))}
            <div style={{ fontSize: '0.42rem', color: '#4a6880', marginTop: 4, fontStyle: 'italic', paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              • Continuous geotechnical gradient from &lt; 1.00 (Red) through Yellow to ≥ 2.20 (Dark Green).
            </div>
          </div>

          {/* Pore Pressure Info */}
          <div style={{
            margin: '0 10px 8px',
            padding: '7px 9px',
            background: 'rgba(3,8,15,0.85)',
            border: '1px solid rgba(249,115,22,0.15)',
            borderRadius: 5,
          }}>
            <div style={{ fontSize: '0.50rem', fontWeight: 700, color: '#f97316', marginBottom: 4 }}>
              PORE-PRESSURE CALIBRATION (VAN GENUCHTEN)
            </div>
            <div style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: '0.48rem',
              color: '#00d4ff',
              background: 'rgba(0,212,255,0.06)',
              border: '1px solid rgba(0,212,255,0.15)',
              borderRadius: 3,
              padding: '4px 7px',
              marginBottom: 4,
              lineHeight: 1.4,
            }}>
              h = −(1/α)·[Se^(−1/m) − 1]^(1/n)<br />
              u_mat = γw·h ≤ 0 · u_pos = γw·hw
            </div>
            <div style={{ fontSize: '0.40rem', color: '#64748b', fontStyle: 'italic', marginBottom: 5 }}>
              Previous prototype approximation (u = γw·S·z) replaced by retention-curve calibration.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '3px 6px', fontSize: '0.42rem', color: '#94a3b8' }}>
              <span>α = {fosStats?.alpha ?? 3.6} m⁻¹</span>
              <span>n = {fosStats?.n ?? 1.56}</span>
              <span>m = {fosStats?.m != null ? fosStats.m.toFixed(3) : '0.359'}</span>
            </div>
            {fosStats?.avgPorePressure != null && (
              <div style={{ marginTop: 5, fontSize: '0.47rem', color: '#7dd3fc', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 4 }}>
                Avg Se: <strong style={{ color: '#00d4ff' }}>{fosStats?.meanSatPct != null ? (fosStats.meanSatPct / 100).toFixed(2) : '—'}</strong> |
                h_avg: <strong style={{ color: '#00d4ff' }}>{fosStats?.avgPressureHead != null ? `${fosStats.avgPressureHead.toFixed(2)} m` : '—'}</strong><br />
                u_eff_avg = <strong style={{ color: '#00f0ff' }}>{fosStats.avgPorePressure.toFixed(2)} kPa</strong>
              </div>
            )}
          </div>

          {/* FoS Equation Reminder */}
          <div style={{
            margin: '0 10px 8px',
            padding: '7px 9px',
            background: 'rgba(3,8,15,0.85)',
            border: '1px solid rgba(249,115,22,0.15)',
            borderRadius: 5,
          }}>
            <div style={{ fontSize: '0.50rem', fontWeight: 700, color: '#f97316', marginBottom: 4 }}>
              FoS EQUATION (INFINITE-SLOPE)
            </div>
            <div style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: '0.47rem',
              color: '#7dd3fc',
              lineHeight: 1.5,
              background: 'rgba(0,212,255,0.04)',
              borderRadius: 3,
              padding: '4px 7px',
            }}>
              FoS = [c’ + (γz·cos²θ − u)·tanφ’]
              <br />     ────────────────────────
              <br />         [γz·sinθ·cosθ]
            </div>
          </div>

          {terrainStats && (
            <ElevBlock
              name="Terrain Relief (ΔZ)"
              value={`${fmt(terrainStats.maxElevation - terrainStats.minElevation, 0)} m`}
              cls="cyan"
              pct={70}
              subtitle="USGS LiDAR DEM"
            />
          )}
        </>
      )}



      {/* ── Fixed Metadata: Grid Info ── */}
      <div style={{ padding: '8px 10px', borderTop: '1px solid rgba(0, 212, 255, 0.1)', marginTop: 'auto' }}>
        <p style={{
          fontSize: '0.56rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: '#4a6880',
          marginBottom: 6,
          fontWeight: 700,
        }}>
          Grid & Source Info
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px' }}>
          {(terrainStats?.dx != null ? [
            { key: 'Grid Size',   val: `${terrainStats.width ?? 872} × ${terrainStats.height ?? 589}` },
            { key: 'Resolution',  val: `${terrainStats.dx.toFixed(1)} × ${terrainStats.dy.toFixed(1)} m/cell` },
            { key: 'Source CRS',  val: terrainStats.crs ?? 'EPSG:26912 (UTM 12N)' },
            { key: 'Data Source', val: 'LiDAR / DEM (GeoTIFF)' },
          ] : GRID_INFO).map(({ key, val }) => (
            <div key={key}>
              <p style={{ fontSize: '0.50rem', color: '#3d5870' }}>{key}</p>
              <p style={{ fontSize: '0.56rem', color: '#7a9bb8', fontWeight: 600 }}>{val}</p>
            </div>
          ))}
        </div>
      </div>
    </aside>
  )
}
