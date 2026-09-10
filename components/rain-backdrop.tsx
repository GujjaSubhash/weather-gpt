'use client'

import { useEffect, useRef } from 'react'

type Streak = { x: number; y: number; len: number; speed: number; alpha: number }

// Subtle by design: a light veil of rain behind the copy, not a downpour. The
// entry screen puts a text input over this, so the rain has to stay quiet
// enough that it never competes with what the user is typing. Both are ceilings
// — `intensity` scales down from here.
const COUNT = 80
const SLANT = 0.26 // px of horizontal drift per px of fall — the diagonal
const MAX_ALPHA = 0.3

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Full-bleed animated rain, sized to whatever it is placed inside.
 *
 * On the entry screen this is decoration. On the dashboard it is not: the
 * caller passes an `intensity` derived from the measured rainfall, and a dry
 * reading renders no rain at all — so what is on screen is the weather, not an
 * effect. Either way the canvas is aria-hidden and makes no claim of its own;
 * the numbers on the page are the reading.
 *
 * Motion is stilled under prefers-reduced-motion: one static frame is drawn
 * instead, so the rain is still *shown*, it just does not move.
 */
type RainBackdropProps = {
  /**
   * Streak colour as an `R,G,B` channel triplet (alpha is applied per streak).
   * Defaults to white, which only reads on a dark surface — the bright
   * onboarding screen passes a dark tint so the rain stays visible against it.
   */
  color?: string
  /**
   * How hard it is raining, 0–1. Scales both the number of streaks and their
   * opacity, so light rain is genuinely a few faint lines rather than the same
   * downpour turned down. Defaults to 1 — the full veil the entry screen has
   * always drawn.
   */
  intensity?: number
  className?: string
}

export default function RainBackdrop({
  color = '255,255,255',
  intensity = 1,
  className,
}: RainBackdropProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Clamped rather than trusted: a bad reading upstream must not be able to
    // spawn an unbounded number of streaks.
    const strength = Math.max(0, Math.min(1, intensity))
    const count = Math.max(1, Math.round(COUNT * strength))
    // Opacity falls off more gently than count, or light rain disappears
    // entirely on a dark panel instead of reading as light rain.
    const maxAlpha = MAX_ALPHA * (0.45 + 0.55 * strength)

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
      streaks = Array.from({ length: count }, () => {
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
        ctx.strokeStyle = `rgba(${color},${(maxAlpha * s.alpha).toFixed(3)})`
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
  }, [color, intensity])

  return (
    <canvas
      ref={canvasRef}
      className={['rain-backdrop', className].filter(Boolean).join(' ')}
      aria-hidden="true"
    />
  )
}
