const fs = require('fs')
const path = require('path')

const inputPath = path.join(__dirname, '..', 'public', 'terrain_web.json')
const outputDir = path.join(__dirname, '..', 'public', 'models', 'mobile')
const outputPath = path.join(outputDir, 'dem_mobile.json')

if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`)
  process.exit(1)
}

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true })
}

console.log('Reading original terrain_web.json...')
const rawData = fs.readFileSync(inputPath, 'utf8')
const terrain = JSON.parse(rawData)

const originalRows = terrain.elevation.length
const originalCols = terrain.elevation[0].length

console.log(`Original DEM: ${originalCols} cols × ${originalRows} rows (${originalRows * originalCols} points)`)

// Downsample function using bilinear interpolation
function downsampleGrid(elevation, origRows, origCols, targetRows, targetCols) {
  const grid = []
  for (let r = 0; r < targetRows; r++) {
    const row = []
    const normV = r / (targetRows - 1) // 0 to 1
    const srcRow = normV * (origRows - 1)
    const r0 = Math.floor(srcRow)
    const r1 = Math.min(origRows - 1, r0 + 1)
    const fr = srcRow - r0

    for (let c = 0; c < targetCols; c++) {
      const normU = c / (targetCols - 1) // 0 to 1
      const srcCol = normU * (origCols - 1)
      const c0 = Math.floor(srcCol)
      const c1 = Math.min(origCols - 1, c0 + 1)
      const fc = srcCol - c0

      const h00 = elevation[r0][c0]
      const h10 = elevation[r0][c1]
      const h01 = elevation[r1][c0]
      const h11 = elevation[r1][c1]

      const val = (h00 * (1 - fc) + h10 * fc) * (1 - fr) +
                  (h01 * (1 - fc) + h11 * fc) * fr
      row.push(Math.round(val * 10) / 10)
    }
    grid.push(row)
  }
  return grid
}

// Generate 3 LOD tiers:
// High: 218 x 148 (~32k points) -> default mobile smooth quality
// Mid:  146 x 98  (~14k points) -> smooth for mid-range mobile
// Low:  73 x 49   (~3.5k points) -> ultra-fast fallback if FPS drops
const highCols = Math.round(originalCols / 4) // 218
const highRows = Math.round(originalRows / 4) // 147

const midCols = Math.round(originalCols / 6)  // 145
const midRows = Math.round(originalRows / 6)  // 98

const lowCols = Math.round(originalCols / 12) // 73
const lowRows = Math.round(originalRows / 12) // 49

console.log(`Generating High LOD (${highCols} × ${highRows})...`)
const highGrid = downsampleGrid(terrain.elevation, originalRows, originalCols, highRows, highCols)

console.log(`Generating Mid LOD (${midCols} × ${midRows})...`)
const midGrid = downsampleGrid(terrain.elevation, originalRows, originalCols, midRows, midCols)

console.log(`Generating Low LOD (${lowCols} × ${lowRows})...`)
const lowGrid = downsampleGrid(terrain.elevation, originalRows, originalCols, lowRows, lowCols)

const mobileData = {
  name: 'Utah Traverse Mountain LiDAR DEM (Mobile Optimized)',
  source: 'Derived from public/terrain_web.json',
  minElevation: terrain.minElevation,
  maxElevation: terrain.maxElevation,
  meanElevation: terrain.meanElevation,
  aspectRatio: (originalCols * (terrain.dx || 1)) / (originalRows * (terrain.dy || 1)),
  crs: terrain.crs,
  lods: {
    high: {
      cols: highCols,
      rows: highRows,
      elevation: highGrid,
      pointCount: highCols * highRows,
      polyCount: (highCols - 1) * (highRows - 1) * 2,
    },
    mid: {
      cols: midCols,
      rows: midRows,
      elevation: midGrid,
      pointCount: midCols * midRows,
      polyCount: (midCols - 1) * (midRows - 1) * 2,
    },
    low: {
      cols: lowCols,
      rows: lowRows,
      elevation: lowGrid,
      pointCount: lowCols * lowRows,
      polyCount: (lowCols - 1) * (lowRows - 1) * 2,
    },
  },
  // Default direct access to high grid for simple single-mesh consumption
  elevation: highGrid,
  width: highCols,
  height: highRows,
}

fs.writeFileSync(outputPath, JSON.stringify(mobileData))
const stats = fs.statSync(outputPath)
console.log(`Successfully written mobile DEM to: ${outputPath}`)
console.log(`Size: ${(stats.size / 1024).toFixed(1)} KB (vs original ${(fs.statSync(inputPath).size / 1024 / 1024).toFixed(2)} MB)`)
