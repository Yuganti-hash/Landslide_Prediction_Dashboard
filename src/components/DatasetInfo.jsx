import React from 'react'

// ── DatasetInfo ───────────────────────────────────────────────────────────────
// Props:
//   smStats: { min, max, mean, count } | null  — from App.jsx
//
// Static rows reflect known metadata from the GeoTIFF source files (Step 6).
// The soil-moisture source note is appended dynamically once smStats loads.
export default function DatasetInfo({ smStats }) {
  const ROWS = [
    { key: 'Dataset Type',  val: 'DEM / Elevation Raster' },
    { key: 'Format',        val: 'GeoTIFF (LiDAR-derived)' },
    { key: 'Visualization', val: 'Plotly 3D Surface' },
    { key: 'Resolution',    val: '1.0 m / pixel' },
    { key: 'Source CRS',    val: 'EPSG:26912 · UTM Zone 12N' },
    { key: 'Location',      val: 'Utah, USA (Oquirrh Mtns area)' },
    {
      key: 'Soil Moisture',
      val: smStats
        ? `NSIDC SMAP L4 · ${smStats.count} obs · IDW interp.`
        : 'NSIDC SMAP L4 · loading…',
    },
    { key: 'Status', val: 'Ready' },
  ]

  return (
    <div className="bottom-panel">
      <div className="panel-header">
        <span className="panel-title">Dataset Information</span>
        <span className="panel-badge cyan">Live</span>
      </div>

      <div className="panel-body">
        <table className="ds-table" aria-label="Dataset metadata">
          <tbody>
            {ROWS.map(({ key, val }) => (
              <tr key={key}>
                <td>{key}</td>
                <td style={
                  key === 'Status'
                    ? { color: 'var(--green)' }
                    : key === 'Soil Moisture'
                      ? { color: 'var(--cyan-dim)', fontSize: '0.62rem' }
                      : undefined
                }>
                  {val}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
