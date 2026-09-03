'use client'

import { useEffect, useRef } from 'react'

type Streak = { x: number; y: number; len: number; speed: number; alpha: number }

// Subtle by design: a light veil of rain behind the copy, not a downpour. The
// entry screen puts a text input over this, so the rain has to stay quiet
// enough that it never competes with what the user is typing.
const COUNT = 80
const SLANT = 0.26 // px of horizontal drift per px of fall — the diagonal
const MAX_ALPHA = 0.3

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Full-bleed animated rain, sized to whatever it is placed inside. Purely
 * decorative — it carries no reading and makes no claim about the weather, so
 * it is aria-hidden and takes no pointer events.
 *
 * Motion is stilled under prefers-reduced-motion: one static frame is drawn
 * instead, so the rain is still *shown*, it just does not move.
 */
export default function RainBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let streaks: Streak[] = []

    // Match the pixel buffer to the CSS-laid-out size (×dpr, capped at 2).
    // Returns true when it actually changed, so the caller can re-scatter.
    const syncSize = (): boolean => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width === w && canvas.height === h) return false
      canvas.width = w
      canvas.height = h
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return true
    }

    const reset = (s: Streak, w: number, h: number, initial: boolean) => {
      // Overshoot the edges so the slant never leaves a bare margin.
      s.x = Math.random() * (w + 120) - 60
      s.y = initial ? Math.random() * h : Math.random() * -120
      s.len = 12 + Math.random() * 16
      s.speed = 2.6 + Math.random() * 2.8
      s.alpha = 0.35 + Math.random() * 0.65
    }

    const spawn = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      streaks = Array.from({ length: COUNT }, () => {
        const s: Streak = { x: 0, y: 0, len: 0, speed: 0, alpha: 0 }
        reset(s, w, h, true)
        return s
      })
    }

    const render = (advance: boolean) => {
      // Self-heal the size every frame, so a resize can never leave a dead band.
      if (syncSize()) spawn()
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)
      ctx.lineWidth = 1
      ctx.lineCap = 'round'
      for (const s of streaks) {
        if (advance) {
          s.y += s.speed
          s.x += s.speed * SLANT
          if (s.y - s.len > h) reset(s, w, h, false)
        }
        ctx.strokeStyle = `rgba(255,255,255,${(MAX_ALPHA * s.alpha).toFixed(3)})`
        ctx.beginPath()
        ctx.moveTo(s.x, s.y)
        ctx.lineTo(s.x - s.len * SLANT, s.y - s.len)
        ctx.stroke()
      }
    }

    const reduce = prefersReducedMotion()

    syncSize()
    spawn()

    const ro = new ResizeObserver(() => render(!reduce))
    ro.observe(canvas)

    if (reduce) {
      render(false)
      return () => ro.disconnect()
    }

    // One synchronous frame first, so the rain is on screen even before the
    // first animation frame fires (and in tabs where rAF is throttled).
    render(true)

    let raf = 0
    const loop = () => {
      render(true)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return <canvas ref={canvasRef} className="rain-backdrop" aria-hidden="true" />
}
