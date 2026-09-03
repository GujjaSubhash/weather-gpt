'use client'

import type { ReactNode } from 'react'
import { Clock, CloudSun, Droplets, MapPin, ShieldCheck, Sun, Thermometer, TriangleAlert } from 'lucide-react'

/**
 * The facts the assistant already holds when it answers, shown as a single
 * wrapping row of chips.
 *
 * Every field is optional and every chip is omitted when its field is absent.
 * Nothing here is defaulted, rounded up or invented: a missing reading reads as
 * missing rather than as a zero. This is deliberately not a second dashboard —
 * the full readings live in the conditions / risk / forecast cards.
 */
export type ChatContext = {
  area?: string
  temperature?: number
  condition?: string
  /** mm/hr. 0 is a real observation ("no rain"), not an absent value. */
  rain?: number
  risk?: 'high' | 'moderate' | 'safe'
  /** Provider observation instant, used only for the tooltip. */
  observedAt?: string
  /** Provider that served the reading, attributed in the freshness tooltip. */
  source?: string
  /**
   * Pre-localized text. The three language dictionaries live in app/page.tsx,
   * so the strip is handed ready-to-render labels instead of translating or
   * formatting anything itself.
   */
  labels?: {
    /** Shown instead of a rainfall figure when rain is exactly 0. */
    noRain?: string
    /** Localized risk word for the current risk level. */
    risk?: string
    /** e.g. "Updated 4 min ago". Omitted when the timestamp is unusable. */
    freshness?: string
  }
}

type Chip = {
  key: string
  icon: ReactNode
  text: string
  className?: string
  title?: string
}

const ICON = 12

function buildChips(context: ChatContext): Chip[] {
  const { area, temperature, condition, rain, risk, observedAt, source, labels } = context
  const chips: Chip[] = []

  if (area) {
    chips.push({ key: 'area', icon: <MapPin size={ICON} />, text: area })
  }

  if (typeof temperature === 'number' && Number.isFinite(temperature)) {
    chips.push({ key: 'temperature', icon: <Thermometer size={ICON} />, text: `${temperature}°C` })
  }

  if (condition) {
    chips.push({
      key: 'condition',
      icon: <CloudSun size={ICON} />,
      text: condition,
      className: 'chat-chip-condition',
    })
  }

  if (typeof rain === 'number' && Number.isFinite(rain)) {
    if (rain > 0) {
      chips.push({ key: 'rain', icon: <Droplets size={ICON} />, text: `${rain} mm/hr` })
    } else if (labels?.noRain) {
      // 0 mm/hr is a measurement. It gets the "no rain" wording rather than a
      // bare zero, and is skipped entirely if no localized label was supplied.
      chips.push({ key: 'rain', icon: <Sun size={ICON} />, text: labels.noRain })
    }
  }

  if (risk && labels?.risk) {
    chips.push({
      key: 'risk',
      icon: risk === 'safe' ? <ShieldCheck size={ICON} /> : <TriangleAlert size={ICON} />,
      text: labels.risk,
      className: `chat-chip-risk chat-chip-risk-${risk}`,
    })
  }

  if (labels?.freshness) {
    // The tooltip attributes the provider and the exact observation instant.
    // Locale-formatted, so it needs no translated wording of its own.
    const observed = observedAt ? new Date(observedAt) : null
    const stamp = observed && !Number.isNaN(observed.getTime()) ? observed.toLocaleString() : ''
    const title = [source, stamp].filter(Boolean).join(' · ')
    chips.push({
      key: 'freshness',
      icon: <Clock size={ICON} />,
      text: labels.freshness,
      className: 'chat-chip-freshness',
      title: title || undefined,
    })
  }

  return chips
}

type WeatherContextStripProps = {
  context?: ChatContext
  /** Localized row label, e.g. "LIVE CONTEXT". */
  label: string
}

export default function WeatherContextStrip({ context, label }: WeatherContextStripProps) {
  if (!context) return null
  const chips = buildChips(context)
  if (chips.length === 0) return null

  return (
    <div className="chat-context">
      <span className="chat-context-label">{label}</span>
      {/* Display-only. These are not buttons and not filters. */}
      {chips.map((chip) => (
        <span
          key={chip.key}
          className={chip.className ? `chat-chip ${chip.className}` : 'chat-chip'}
          title={chip.title}
        >
          {chip.icon}
          {chip.text}
        </span>
      ))}
    </div>
  )
}
