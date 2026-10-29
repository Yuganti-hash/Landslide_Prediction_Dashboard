import React from 'react'

/**
 * StatCard – displays a single elevation metric.
 * @param {string}  variant  - 'elevation' | 'min-elev' | 'max-elev'
 * @param {string}  icon     - Emoji icon
 * @param {string}  tag      - Short tag text (e.g. "Mean")
 * @param {string}  label    - Card label
 * @param {string}  value    - Numeric string
 * @param {string}  unit     - Unit label
 * @param {string}  footer   - Footer description text
 */
export default function StatCard({ variant, icon, tag, label, value, unit, footer }) {
  return (
    <article className={`stat-card ${variant}`} aria-label={`${label}: ${value} ${unit}`}>
      <div className="stat-card-header">
        <div className="stat-icon" aria-hidden="true">{icon}</div>
        <span className="stat-tag">{tag}</span>
      </div>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      <p className="stat-unit">{unit}</p>
      {footer && (
        <div className="stat-footer">
          <span>📍</span>
          <span>{footer}</span>
        </div>
      )}
    </article>
  )
}
