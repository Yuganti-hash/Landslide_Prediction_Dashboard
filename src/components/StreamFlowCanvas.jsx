import React, { useEffect, useRef, useCallback } from 'react'

/**
 * StreamFlowCanvas
 * ============================================================================
 * Canvas 2D overlay that renders animated water-flow particles along the
 * EXISTING D8 flow network. This is PURELY a visual rendering layer.
 *
 * DOES NOT modify any hydrology model data. Reads accumulationMatrix and
 * d8Target from hydroStatic (precomputed, read-only) and maps those to
 * screen-space stream paths with animated moving particles.
 *
 * Visualizes: RAIN → PEAK/PLATEAU → SMALL TRIBUTARIES → STREAMS → MERGING → OUTLET
 */
export default function StreamFlowCanvas({
  hydroStatic,           // Read-only precomputed terrain derivatives
  rainfallMm = 0,        // Current rainfall intensity (controls particle speed/density)
  accumulatedRainMm = 0, // Total accumulated rain (controls network extent threshold)
  isPaused = false,
  visible = true,
  containerRef,          // ref to the plotly-wrap container div
}) {
  const canvasRef = useRef(null)
  const rafRef    = useRef(null)
  const stateRef  = useRef({
    particles:   [],
    streamPaths: [],
    maxLogAccum: 1,
    initialized: false,
    prevRainMm:  -1,
  })

  // ── Build stream paths from D8 accumulation (read-only) ─────────────────────
  const buildStreamPaths = useCallback(() => {
    if (!hydroStatic?.accumulationMatrix || !hydroStatic?.d8Target) return

    const { accumulationMatrix, d8Target, width, height } = hydroStatic
    const totalCells = width * height

    // Compute log-accumulation range over full grid
    let maxLogAccum = 1.0
    for (let i = 0; i < totalCells; i++) {
      const la = Math.log(1 + (accumulationMatrix[i] || 1))
      if (la > maxLogAccum) maxLogAccum = la
    }
    stateRef.current.maxLogAccum = maxLogAccum

    // Rain-based stream threshold: at low rain only deepest channels visible;
    // as rain increases, more tributaries appear
    const rainScale    = Math.min(1.0, Math.max(0, accumulatedRainMm / 90.0))
    const streamThresh = Math.max(0.04, 0.55 - rainScale * 0.50)

    // Trace connected downhill paths following D8 targets
    const paths   = []
    const visited = new Uint8Array(totalCells)

    // Two-pass: collect only cells above threshold (much faster than sorting all 513k cells)
    const candidates = []
    for (let i = 0; i < totalCells; i++) {
      const normA = Math.log(1 + (accumulationMatrix[i] || 1)) / maxLogAccum
      if (normA >= streamThresh) candidates.push(i)
    }
    // Sort only the qualifying candidates by descending accumulation (trunks first)
    candidates.sort((a, b) => accumulationMatrix[b] - accumulationMatrix[a])

    const maxPaths = 600

    for (let si = 0; si < candidates.length && paths.length < maxPaths; si++) {
      const startIdx = candidates[si]
      const normA    = Math.log(1 + (accumulationMatrix[startIdx] || 1)) / maxLogAccum
      if (normA < streamThresh) break  // All remaining have even lower accumulation


      if (visited[startIdx]) continue

      // Trace downstream path from this cell
      const path    = []
      let currIdx   = startIdx

      for (let step = 0; step < 120; step++) {
        if (visited[currIdx]) break
        visited[currIdx] = 1

        const cr = Math.floor(currIdx / width)
        const cc = currIdx % width
        const la = Math.log(1 + (accumulationMatrix[currIdx] || 1))
        path.push({ r: cr, c: cc, normAccum: la / maxLogAccum })

        const target = d8Target[currIdx]
        if (target < 0 || target >= totalCells) break
        currIdx = target
      }

      if (path.length >= 3) {
        paths.push(path)
      }
    }

    stateRef.current.streamPaths = paths
    stateRef.current.initialized = true
  }, [hydroStatic, accumulatedRainMm])

  // ── Spawn / refresh flow particles ──────────────────────────────────────────
  const spawnParticles = useCallback(() => {
    const { streamPaths } = stateRef.current
    if (!streamPaths.length) return

    const rainScale   = Math.min(1.0, Math.max(0, rainfallMm / 200.0))
    const targetCount = Math.round(50 + rainScale * 250)

    const particles = []
    for (let i = 0; i < targetCount; i++) {
      const pathIdx = Math.floor(Math.random() * streamPaths.length)
      const path    = streamPaths[pathIdx]
      if (!path || path.length < 2) continue

      particles.push({
        pathIdx,
        segIdx: Math.floor(Math.random() * (path.length - 1)),
        segT:   Math.random(),
        speed:  0.006 + Math.random() * 0.020 + rainScale * 0.012,
        alpha:  0.35 + Math.random() * 0.50,
        size:   1.0 + Math.random() * 2.0,
      })
    }
    stateRef.current.particles = particles
  }, [rainfallMm])

  // ── Animation render loop ────────────────────────────────────────────────────
  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      rafRef.current = requestAnimationFrame(render)
      return
    }

    const ctx = canvas.getContext('2d')
    const W   = canvas.width
    const H   = canvas.height
    const { streamPaths, particles, maxLogAccum } = stateRef.current

    ctx.clearRect(0, 0, W, H)

    if (!streamPaths.length || !W || !H || !visible) {
      rafRef.current = requestAnimationFrame(render)
      return
    }

    const { width: gW, height: gH } = hydroStatic
    // Map grid coordinates to canvas pixels
    const toX = (c) => (c / (gW - 1)) * W
    const toY = (r) => (r / (gH - 1)) * H

    const rainScale = Math.min(1.0, Math.max(0, accumulatedRainMm / 90.0))

    // ── Draw stream centerlines ──────────────────────────────────────────────
    for (const path of streamPaths) {
      if (path.length < 2) continue

      // Use the maximum accumulation in the path for line styling
      let peakNorm = 0
      for (const pt of path) if (pt.normAccum > peakNorm) peakNorm = pt.normAccum

      const lineW = Math.max(0.5, Math.min(3.5, peakNorm * 4.0 * (0.4 + rainScale * 0.6)))
      const alpha = Math.min(0.60, 0.06 + peakNorm * 0.40 + rainScale * 0.14)

      // Color gradient: deep blue (thin/high) → bright cyan (trunk)
      const rC = Math.round(0  + peakNorm * 56)
      const gC = Math.round(60 + peakNorm * 150)
      const bC = Math.round(160 + peakNorm * 88)

      ctx.beginPath()
      ctx.moveTo(toX(path[0].c), toY(path[0].r))
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(toX(path[i].c), toY(path[i].r))
      }
      ctx.strokeStyle = `rgba(${rC},${gC},${bC},${alpha})`
      ctx.lineWidth   = lineW
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.stroke()
    }

    // ── Animate particles along stream paths ─────────────────────────────────
    if (!isPaused && rainfallMm > 0) {
      for (const p of particles) {
        const path = streamPaths[p.pathIdx]
        if (!path || path.length < 2) continue

        // Advance particle downstream
        p.segT += p.speed
        if (p.segT >= 1.0) {
          p.segT -= 1.0
          p.segIdx++
          if (p.segIdx >= path.length - 1) {
            // Respawn at a random path start position
            p.pathIdx = Math.floor(Math.random() * streamPaths.length)
            p.segIdx  = 0
            p.segT    = Math.random() * 0.4
          }
        }

        const i0  = Math.min(p.segIdx, path.length - 1)
        const i1  = Math.min(p.segIdx + 1, path.length - 1)
        const s0  = path[i0]
        const s1  = path[i1]
        if (!s0 || !s1) continue

        // Interpolated screen position
        const px = toX(s0.c) + p.segT * (toX(s1.c) - toX(s0.c))
        const py = toY(s0.r) + p.segT * (toY(s1.r) - toY(s0.r))

        const na   = s0.normAccum
        const pAlp = p.alpha * (0.5 + (rainfallMm / 200) * 0.5) * (0.6 + na * 0.4)
        const pSz  = p.size * (0.8 + na * 0.5)
        const gR   = pSz * 2.8

        // Soft radial glow: bright white-cyan core → transparent edge
        const grd = ctx.createRadialGradient(px, py, 0, px, py, gR)
        grd.addColorStop(0,   `rgba(210, 245, 255, ${Math.min(1, pAlp)})`)
        grd.addColorStop(0.4, `rgba(56, 189, 248, ${Math.min(1, pAlp * 0.65)})`)
        grd.addColorStop(1,   `rgba(14, 74, 140, 0)`)

        ctx.beginPath()
        ctx.arc(px, py, gR, 0, Math.PI * 2)
        ctx.fillStyle = grd
        ctx.fill()
      }
    }

    // ── Plateau source wetness glow (where streams originate from peaks) ──────
    if (rainScale > 0.15) {
      const glowOpacity = rainScale * 0.12
      for (let i = 0; i < Math.min(streamPaths.length, 120); i++) {
        const path = streamPaths[i]
        if (!path.length) continue
        const src  = path[0]
        const sx   = toX(src.c)
        const sy   = toY(src.r)
        const gR   = 5 + rainScale * 8
        const gAlp = glowOpacity * src.normAccum

        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, gR)
        g.addColorStop(0, `rgba(120, 210, 255, ${gAlp})`)
        g.addColorStop(1, `rgba(14,  74, 140, 0)`)
        ctx.beginPath()
        ctx.arc(sx, sy, gR, 0, Math.PI * 2)
        ctx.fillStyle = g
        ctx.fill()
      }
    }

    rafRef.current = requestAnimationFrame(render)
  }, [visible, isPaused, rainfallMm, accumulatedRainMm, hydroStatic])

  // ── Sync canvas size to container ───────────────────────────────────────────
  useEffect(() => {
    const container = containerRef?.current
    const canvas    = canvasRef.current
    if (!container || !canvas) return

    const sync = () => {
      canvas.width  = container.clientWidth
      canvas.height = container.clientHeight
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(container)
    return () => ro.disconnect()
  }, [containerRef])

  // ── Rebuild stream paths when hydroStatic or rain threshold changes ──────────
  useEffect(() => {
    if (hydroStatic?.accumulationMatrix) {
      buildStreamPaths()
      spawnParticles()
    }
  }, [hydroStatic, accumulatedRainMm, buildStreamPaths, spawnParticles])

  // ── Respawn particles when rainfall intensity changes significantly ──────────
  useEffect(() => {
    if (stateRef.current.initialized) {
      spawnParticles()
    }
  }, [rainfallMm, spawnParticles])

  // ── Start render loop ────────────────────────────────────────────────────────
  useEffect(() => {
    rafRef.current = requestAnimationFrame(render)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [render])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position:      'absolute',
        top:           0,
        left:          0,
        width:         '100%',
        height:        '100%',
        pointerEvents: 'none',
        zIndex:        5,
        opacity:       visible ? 1 : 0,
        transition:    'opacity 0.4s ease',
        mixBlendMode:  'screen',
      }}
      aria-hidden="true"
    />
  )
}
