'use client'

/**
 * The weather-reactive animated backdrop.
 *
 * This is the only seam between the app and the WebGL gradient. It owns the
 * palettes, decides whether the canvas runs at all, and always paints a matching
 * CSS gradient underneath so the screen looks right even when the canvas never
 * appears — no WebGL, reduced motion, or a driver that rejects the shader.
 */

import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'

import { variantOf, type Variant } from '@/lib/weather-variant'
import { cn } from '@/lib/utils'

// ~15 KB of WebGL renderer stays out of the initial bundle, and ssr:false keeps
// it away from the server where there is no canvas to draw on.
const GradientWave = dynamic(
  () => import('@/components/ui/gradient-wave').then((m) => m.GradientWave),
  { ssr: false }
)

/**
 * Tone, not theme: the two surfaces this mounts on have opposite luminance.
 * 'bright' is the full-bleed onboarding screen, which carries dark text.
 * 'deep' is the band behind the dashboard header, which has to resolve into
 * #0a0a0a without washing out the light text sitting on top of it.
 */
export type AuroraTone = 'bright' | 'deep'

/**
 * Base colour first, then up to three wave layers — four total, which is the
 * most the shader's vec4 layer gate can address (see MAX_COLORS in
 * components/ui/gradient-wave.tsx).
 */
const PALETTES: Record<AuroraTone, Record<Variant, string[]>> = {
  bright: {
    clear: ['#7CC6FE', '#E8F4FF', '#FFD79A', '#FFF7E6'],
    rain: ['#6E8CA8', '#B8D4F0', '#8FA8C4', '#E4EEF7'],
    storm: ['#6B6D9E', '#C6C9E8', '#8A7FB5', '#E8E6F5'],
    cloud: ['#C9BFA8', '#F0E9DC', '#A8B5AE', '#F5F2EA'],
  },
  deep: {
    clear: ['#1A1408', '#4A3410', '#8A5E1C', '#0F0C06'],
    rain: ['#0B1E3D', '#123A6B', '#1E5A9E', '#0A1526'],
    storm: ['#1A1030', '#34206B', '#5B3FA8', '#0D0A1C'],
    cloud: ['#14161A', '#2A2F38', '#3E4653', '#0D0F12'],
  },
}

/** Shown before any reading exists — a calm blue sky, matching the mascot's idle 'clear'. */
const BRIGHT_DEFAULT = ['#7CC6FE', '#E8F4FF', '#A8D8FF', '#FFFFFF']

/**
 * The static gradient painted under the canvas. Colours are ordered
 * base → layers, so reading them corner-to-corner approximates what the mesh
 * settles into and the swap is not jarring when the canvas does start.
 */
function fallbackGradient(colors: string[]): string {
  const [base, a, b, c] = colors
  return [
    `radial-gradient(110% 80% at 15% 15%, ${a} 0%, transparent 55%)`,
    `radial-gradient(90% 70% at 85% 25%, ${b} 0%, transparent 60%)`,
    `radial-gradient(120% 90% at 50% 100%, ${c} 0%, transparent 65%)`,
    `linear-gradient(160deg, ${base} 0%, ${a} 100%)`,
  ].join(', ')
}

/** Slower and softer on the dashboard: it sits behind text that must stay readable. */
const MOTION: Record<AuroraTone, { noiseSpeed: number; deform: Record<string, number> }> = {
  bright: { noiseSpeed: 0.00001, deform: { incline: 0.4, noiseAmp: 240, noiseFlow: 5 } },
  deep: { noiseSpeed: 0.000006, deform: { incline: 0.25, noiseAmp: 170, noiseFlow: 4 } },
}

type WeatherAuroraProps = {
  /** Live condition text. Omitted before the first reading lands. */
  condition?: string
  /** mm/hr — a positive value forces a rain or storm palette. */
  rain?: number
  tone: AuroraTone
  className?: string
}

export default function WeatherAurora({ condition, rain, tone, className }: WeatherAuroraProps) {
  // Starts false so the server-rendered markup and the first client paint agree
  // (no hydration mismatch); the effect below turns the canvas on when allowed.
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      setAnimate(true)
      return
    }

    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setAnimate(!query.matches)

    // Honour the preference changing mid-session rather than only at load.
    const onChange = (e: MediaQueryListEvent) => setAnimate(!e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const hasReading = Boolean(condition) || typeof rain === 'number'

  // Stable identities matter: GradientWave re-initialises its WebGL context when
  // these change, and the onboarding screen re-renders on every keystroke.
  const colors = useMemo(() => {
    if (tone === 'bright' && !hasReading) return BRIGHT_DEFAULT
    return PALETTES[tone][variantOf(condition, rain)]
  }, [tone, hasReading, condition, rain])

  const motion = MOTION[tone]
  const deform = useMemo(() => motion.deform, [motion])

  return (
    <div
      className={cn('weather-aurora', className)}
      aria-hidden="true"
      style={{ backgroundImage: fallbackGradient(colors) }}
    >
      {animate && (
        <GradientWave
          colors={colors}
          noiseSpeed={motion.noiseSpeed}
          deform={deform}
          className="weather-aurora-canvas"
        />
      )}
    </div>
  )
}
