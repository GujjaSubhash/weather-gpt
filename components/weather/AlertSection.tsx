'use client'

import { BellRing, ExternalLink, Info, MessageSquare, ShieldCheck, TriangleAlert } from 'lucide-react'

/**
 * A single official warning as issued by a meteorological authority.
 * Every field except `source` and `description` is optional, because a feed may
 * publish a warning without a severity grade, a validity window or a permalink.
 */
export type OfficialAlert = {
  /** Issuing authority, e.g. "IMD". Always attributed on the card. */
  source: string
  description: string
  /** The issuer's own severity wording. Rendered verbatim — never re-graded. */
  severity?: string | null
  startsAt?: string | null
  endsAt?: string | null
  link?: string | null
}

export type AlertSectionCopy = {
  kicker: string
  title: string
  subtitle: string
  /** Tag placed on every official warning card. */
  officialLabel: string
  /** State 2: a feed is connected and reports nothing active. */
  none: string
  /** State 3: no feed is connected, so we cannot see warnings at all. */
  notConnected: string
  notConnectedSub: string
  derivedLabel: string
  derivedNote: string
  /** Localized word for the current risk level. */
  riskWord: string
  severityLabel: string
  fromLabel: string
  untilLabel: string
  sourceLink: string
  askCta: string
  /** Localized question prefix sent to the assistant. */
  askQuestion: string
}

export type AlertSectionProps = {
  /*
   * NOT YET SUPPLIED BY /api/weather.
   *
   * `officialAlerts` and `alertsAvailable` are deliberately absent from the
   * weather response today — wiring the AccuWeather alerts endpoint is a
   * separate, deferred task. Until those fields exist the component renders
   * state 3 ("warnings are not connected yet"), and it starts rendering real
   * warnings the moment the API begins returning them. No UI change is needed
   * at that point: only the two props below have to be passed through.
   */
  officialAlerts?: OfficialAlert[]
  /**
   * `true` = a warning feed answered, so an empty array genuinely means "nothing
   * active". Falsy/undefined = we have no feed, which is a different fact and is
   * never presented as "no warnings".
   */
  alertsAvailable?: boolean
  risk?: 'high' | 'moderate' | 'safe'
  /** Rainfall-derived caution from /api/weather. Not an official warning. */
  rainfallGuidance?: string
  onAskAboutAlert?: (question: string) => void
  copy: AlertSectionCopy
}

/** Locale-formatted validity stamp. Unparseable input yields nothing. */
function stamp(value?: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString([], {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function AlertSection({
  officialAlerts,
  alertsAvailable,
  risk,
  rainfallGuidance,
  onAskAboutAlert,
  copy,
}: AlertSectionProps) {
  const alerts = officialAlerts ?? []
  const hasOfficial = alerts.length > 0
  // A safe reading has nothing to explain, so the derived block gets no CTA.
  const derivedWorthExplaining = risk === 'high' || risk === 'moderate'

  const ask = (question: string) => {
    if (onAskAboutAlert) onAskAboutAlert(question)
  }

  return (
    <>
      <div className="section-title">
        <div>
          <span className="kicker">{copy.kicker}</span>
          <h2>{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <BellRing size={17} className="alerts-mark" />
      </div>

      <div className="alerts-body">
        {hasOfficial ? (
          alerts.map((alert, i) => {
            const from = stamp(alert.startsAt)
            const until = stamp(alert.endsAt)
            return (
              <article className="alert-card" key={`${alert.source}-${i}`}>
                <div className="alert-card-top">
                  <span className="alert-official-tag">
                    <TriangleAlert size={12} />{copy.officialLabel}
                  </span>
                  <span className="alert-issuer">{alert.source}</span>
                </div>
                <p className="alert-description">{alert.description}</p>
                <div className="alert-meta">
                  {/* The issuer's grade, shown as written. It is not mapped onto
                      this app's risk scale, which measures something else. */}
                  {alert.severity && <span>{copy.severityLabel}: {alert.severity}</span>}
                  {from && <span>{copy.fromLabel} {from}</span>}
                  {until && <span>{copy.untilLabel} {until}</span>}
                  {alert.link && (
                    <a className="alert-link" href={alert.link} target="_blank" rel="noopener noreferrer">
                      {copy.sourceLink}<ExternalLink size={11} />
                    </a>
                  )}
                </div>
                {onAskAboutAlert && (
                  <button
                    type="button"
                    className="button secondary alert-ask"
                    onClick={() => ask(`${copy.askQuestion} "${alert.description}"`)}
                  >
                    <MessageSquare size={13} />{copy.askCta}
                  </button>
                )}
              </article>
            )
          })
        ) : alertsAvailable ? (
          /* State 2 — a feed answered and there is nothing active. */
          <div className="alert-banner safe alert-stacked">
            <ShieldCheck size={15} />
            <div className="alert-copy"><strong>{copy.none}</strong></div>
          </div>
        ) : (
          /* State 3 — capability gap, not an all-clear. Worded so it cannot be
             read as "there are no warnings". */
          <div className="alert-banner notice alert-stacked">
            <Info size={15} />
            <div className="alert-copy">
              <strong>{copy.notConnected}</strong>
              <span>{copy.notConnectedSub}</span>
            </div>
          </div>
        )}

        {/* Kept visually and textually separate from official warnings in every
            state: this is computed from measured rainfall, nothing more. */}
        {risk && (
          <div className="alert-derived">
            <span className="kicker">{copy.derivedLabel}</span>
            <div className={`alert-banner ${risk} alert-stacked`}>
              {risk === 'safe' ? <ShieldCheck size={15} /> : <TriangleAlert size={15} />}
              <div className="alert-copy">
                <strong>{copy.riskWord}</strong>
                {rainfallGuidance && <span>{rainfallGuidance}</span>}
              </div>
            </div>
            <p className="alert-derived-note">{copy.derivedNote}</p>
            {derivedWorthExplaining && onAskAboutAlert && (
              <button
                type="button"
                className="button secondary alert-ask"
                onClick={() =>
                  ask(
                    rainfallGuidance
                      ? `${copy.askQuestion} "${copy.riskWord} — ${rainfallGuidance}"`
                      : `${copy.askQuestion} "${copy.riskWord}"`,
                  )
                }
              >
                <MessageSquare size={13} />{copy.askCta}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )
}
