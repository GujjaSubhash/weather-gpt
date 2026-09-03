'use client'

import { CloudRain, History, Sun, Umbrella } from 'lucide-react'

/**
 * Monthly climate normals for Hyderabad — India Meteorological Department,
 * 1991–2020 averaging period. These are PUBLISHED CITY-WIDE NORMALS, not a
 * measurement of the user's area and not derived from this app's own history:
 * that distinction is stated in the card's footnote rather than left implied.
 *
 * `season` is the monsoon phase, which is what makes a rainfall figure
 * interpretable — 204mm in August is ordinary, the same number in January
 * would not be.
 */
type Season = 'dry' | 'hot' | 'monsoon' | 'peak'
type Normal = { high: number; low: number; rain: number; season: Season }

const NORMALS: Normal[] = [
  { high: 28.6, low: 13.9, rain: 9.2, season: 'dry' },      // Jan
  { high: 31.8, low: 15.5, rain: 10.2, season: 'dry' },     // Feb
  { high: 35.2, low: 20.3, rain: 12.3, season: 'hot' },     // Mar
  { high: 37.6, low: 24.1, rain: 27.2, season: 'hot' },     // Apr
  { high: 38.8, low: 26.0, rain: 34.5, season: 'hot' },     // May
  { high: 34.4, low: 23.9, rain: 113.8, season: 'monsoon' }, // Jun
  { high: 30.5, low: 22.5, rain: 162.0, season: 'monsoon' }, // Jul
  { high: 29.6, low: 22.0, rain: 203.9, season: 'peak' },   // Aug
  { high: 30.1, low: 21.7, rain: 148.5, season: 'monsoon' }, // Sep
  { high: 30.4, low: 20.0, rain: 113.9, season: 'monsoon' }, // Oct
  { high: 28.8, low: 16.4, rain: 19.1, season: 'dry' },     // Nov
  { high: 27.8, low: 13.1, rain: 5.0, season: 'dry' },      // Dec
]

/** How far outside the normal daily range today has to sit to be called unusual. */
const ANOMALY_MARGIN = 1.5

export type ClimateCopy = {
  kicker: string
  title: string
  typicalLabel: string
  normalHigh: string
  normalLow: string
  normalRain: string
  seasonDry: string
  seasonHot: string
  seasonMonsoon: string
  seasonPeak: string
  todayLabel: string
  nowTemp: string
  normalRange: string
  warmer: string
  cooler: string
  aboutNormal: string
  rainNow: string
  rainNote: string
  noReading: string
  source: string
  outsideArea: string
}

type Props = {
  /** Live temperature (°C) and rainfall (mm/hr), when a reading exists. */
  temperature?: number
  rain?: number
  /** False when the reading is outside the Hyderabad window these normals describe. */
  inSupportedArea?: boolean
  /** BCP-47 tag for month names, so the month is named in the active language. */
  locale: string
  copy: ClimateCopy
}

export default function ClimateCard({
  temperature,
  rain,
  inSupportedArea,
  locale,
  copy,
}: Props) {
  const now = new Date()
  const normal = NORMALS[now.getMonth()]
  const monthName = now.toLocaleString(locale, { month: 'long' })

  const seasonLabel = {
    dry: copy.seasonDry,
    hot: copy.seasonHot,
    monsoon: copy.seasonMonsoon,
    peak: copy.seasonPeak,
  }[normal.season]
  const SeasonIcon = normal.season === 'hot' ? Sun : normal.season === 'dry' ? Umbrella : CloudRain

  // Today against the month's normal daily range. Compared to the range rather
  // than to the normal high alone, because a single reading can be taken at any
  // hour — "27° at 6am" is not below normal, it is simply not the daily peak.
  const hasTemp = typeof temperature === 'number'
  const anomaly: 'warm' | 'cool' | 'normal' | null = !hasTemp
    ? null
    : temperature > normal.high + ANOMALY_MARGIN
      ? 'warm'
      : temperature < normal.low - ANOMALY_MARGIN
        ? 'cool'
        : 'normal'
  const verdict = anomaly === 'warm' ? copy.warmer : anomaly === 'cool' ? copy.cooler : copy.aboutNormal

  return (
    <section className="card climate-card">
      <div className="card-top">
        <div>
          <span className="kicker">{copy.kicker}</span>
          <h3>{copy.title}</h3>
        </div>
        <History size={15} className="climate-mark" />
      </div>

      <div className="climate-grid">
        {/* Left: the published normal for the month we are actually in. */}
        <div className="climate-block">
          <span className="kicker">{copy.typicalLabel} · {monthName}</span>
          <span className={`climate-season climate-season-${normal.season}`}>
            <SeasonIcon aria-hidden="true" />{seasonLabel}
          </span>
          <div className="climate-rows">
            <div className="climate-row">
              <span>{copy.normalHigh}</span><b>{normal.high.toFixed(1)}°C</b>
            </div>
            <div className="climate-row">
              <span>{copy.normalLow}</span><b>{normal.low.toFixed(1)}°C</b>
            </div>
            <div className="climate-row">
              <span>{copy.normalRain}</span><b>{normal.rain.toFixed(0)} mm</b>
            </div>
          </div>
        </div>

        {/* Right: the live reading placed against that normal. */}
        <div className="climate-block">
          <span className="kicker">{copy.todayLabel}</span>
          {hasTemp ? (
            <>
              <span className={`climate-verdict climate-verdict-${anomaly === 'warm' ? 'warm' : anomaly === 'cool' ? 'cool' : 'normal'}`}>
                {verdict}
              </span>
              <div className="climate-rows">
                <div className="climate-row">
                  <span>{copy.nowTemp}</span>
                  <b>{temperature}°C</b>
                </div>
                <div className="climate-row">
                  <span>{copy.normalRange}</span>
                  <b>{normal.low.toFixed(0)}–{normal.high.toFixed(0)}°C</b>
                </div>
                {typeof rain === 'number' && (
                  <div className="climate-row">
                    <span>{copy.rainNow}</span><b>{rain} mm/hr</b>
                  </div>
                )}
              </div>
            </>
          ) : (
            <p className="climate-note">{copy.noReading}</p>
          )}
        </div>
      </div>

      {/* Rainfall is a monthly total against an hourly rate: stated, never
          silently divided into a fake comparison. */}
      <p className="climate-source">
        {copy.rainNote} {inSupportedArea === false ? copy.outsideArea : copy.source}
      </p>
    </section>
  )
}
