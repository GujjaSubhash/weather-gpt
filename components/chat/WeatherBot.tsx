'use client'

import { Bot } from 'lucide-react'

type WeatherBotProps = {
  /** Live condition text, e.g. "Drizzle", "Partly cloudy". */
  condition?: string
  /** mm/hr. A positive value forces a rain (or storm) mood outright. */
  rain?: number
  /** Pixel size of the face box. Effects scale relative to this. */
  size?: number
  className?: string
}

type Variant = 'clear' | 'cloud' | 'rain' | 'storm'

/**
 * Picks the mascot's mood from the live reading. A positive rainfall is a real
 * measurement, so it wins outright (storm when the text says thunder/lightning,
 * otherwise plain rain). With no rain we fall back to the condition text, and
 * finally to 'clear' — which is also what the onboarding screen gets before any
 * reading exists, giving it a calm idle bot rather than a blank one.
 */
function variantOf(condition?: string, rain?: number): Variant {
  const c = condition ?? ''
  if (typeof rain === 'number' && rain > 0) {
    return /storm|thunder|lightning/i.test(c) ? 'storm' : 'rain'
  }
  if (/storm|thunder|lightning/i.test(c)) return 'storm'
  if (/rain|drizzle|shower/i.test(c)) return 'rain'
  if (/cloud|overcast|mist|fog|haze|smoke/i.test(c)) return 'cloud'
  return 'clear'
}

/**
 * A small weather-reactive robot that sits by the chat input, like a friendly
 * companion. It idle-bobs and breathes, and wears a weather effect that mirrors
 * the current conditions: a warm glow when clear, a drifting cloud when
 * overcast, falling drops when it rains, a lightning flicker in a storm. All the
 * motion lives in globals.css and is stilled under prefers-reduced-motion; the
 * effect layer is decorative, so only the face carries the accessible label.
 */
export default function WeatherBot({ condition, rain, size = 30, className = '' }: WeatherBotProps) {
  const variant = variantOf(condition, rain)
  // The face fills most of the box, matching the .ai-mark proportions.
  const iconSize = Math.round(size * 0.58)

  return (
    <span
      className={`weather-bot weather-bot-${variant} ${className}`.trim()}
      style={{ width: size, height: size }}
      role="img"
      aria-label="WeatherGPT assistant"
    >
      <span className="wb-fx" aria-hidden="true">
        {variant === 'clear' && <span className="wb-sun" />}
        {variant === 'cloud' && <span className="wb-cloud" />}
        {(variant === 'rain' || variant === 'storm') && (
          <>
            <span className="wb-drop" />
            <span className="wb-drop" />
            <span className="wb-drop" />
          </>
        )}
        {variant === 'storm' && <span className="wb-bolt" />}
      </span>
      <Bot size={iconSize} className="wb-face" aria-hidden="true" />
    </span>
  )
}
