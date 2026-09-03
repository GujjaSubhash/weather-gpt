'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Send } from 'lucide-react'
import WeatherContextStrip, { type ChatContext } from './WeatherContextStrip'
import WeatherBot from './WeatherBot'

export type ChatPanelMessage = { role: 'user' | 'bot'; text: string }

export type ChatPanelCopy = {
  assistant: string
  title: string
  subtitle: string
  placeholder: string
  sending: string
  /** Shown while only the seeded greeting exists, so the scope is obvious. */
  emptyHint: string
  contextLabel: string
  /** Accessible name and visible label for the submit control. */
  send: string
}

type ChatPanelProps = {
  messages: ChatPanelMessage[]
  input: string
  loading: boolean
  onInputChange: (v: string) => void
  onSubmit: (e: FormEvent) => void
  /** The active language slice, so nothing here needs its own dictionary. */
  copy: ChatPanelCopy
  context?: ChatContext
}

/*
 * Progressive reveal is a PRESENTATION EFFECT ONLY.
 *
 * /api/chat answers with one complete JSON reply, so there are no tokens to
 * stream — the full text is already in state before anything is drawn. This
 * simply uncovers that finished text over a short window so a long answer does
 * not land as a wall of text in one frame. It never changes, delays or fakes
 * what the model said. True token streaming would require changing the route to
 * emit a streamed response, which is deliberately out of scope for this UI task.
 *
 * Skipped entirely when the user prefers reduced motion: the text is painted in
 * full immediately.
 */
const REVEAL_MS_PER_CHAR = 12
const REVEAL_MAX_MS = 1200
const REVEAL_FRAME_MS = 16

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export default function ChatPanel({
  messages,
  input,
  loading,
  onInputChange,
  onSubmit,
  copy,
  context,
}: ChatPanelProps) {
  const [reveal, setReveal] = useState<{ index: number; chars: number } | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const index = messages.length - 1
    // Index 0 is the seeded greeting: it is already on screen at mount, so it is
    // never animated. A user turn also cancels any reveal in flight, which drops
    // the previous answer straight to its full text.
    if (index < 1 || messages[index].role !== 'bot') {
      setReveal(null)
      return
    }

    const text = messages[index].text
    if (!text || prefersReducedMotion()) {
      setReveal(null)
      return
    }

    // Long answers are revealed in bigger steps so the whole reveal still
    // finishes inside REVEAL_MAX_MS.
    const duration = Math.min(text.length * REVEAL_MS_PER_CHAR, REVEAL_MAX_MS)
    const frames = Math.max(1, Math.round(duration / REVEAL_FRAME_MS))
    const step = Math.max(1, Math.ceil(text.length / frames))

    let chars = step
    setReveal({ index, chars })
    const timer = window.setInterval(() => {
      chars += step
      if (chars >= text.length) {
        window.clearInterval(timer)
        setReveal(null)
        return
      }
      setReveal({ index, chars })
    }, REVEAL_FRAME_MS)

    return () => window.clearInterval(timer)
  }, [messages])

  // Keep the transcript pinned to its newest line. This scrolls ONLY the
  // messages container — never the page — so sending a message can't yank the
  // whole dashboard around. It re-runs on `reveal` too, so as the progressive
  // reveal grows the last bubble the view follows it down and the finished reply
  // lands fully in view instead of half below the fold.
  useEffect(() => {
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, loading, reveal])

  const textOf = (index: number, text: string) =>
    reveal && reveal.index === index ? text.slice(0, reveal.chars) : text

  // Only the seeded greeting so far — a first-time visitor gets told what the
  // assistant will answer instead of an empty transcript.
  const isFirstVisit = messages.length <= 1
  const canSend = !loading && input.trim().length > 0

  return (
    <>
      <div className="chat-intro">
        <WeatherBot condition={context?.condition} rain={context?.rain} size={30} />
        <div className="chat-intro-copy">
          <span className="kicker">{copy.assistant}</span>
          <h2>{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
      </div>

      <div className="chat-panel">
        {/* role=log + aria-live so each new turn is announced. Focusable so the
            transcript can be scrolled from the keyboard. */}
        <div
          className="chat-messages"
          role="log"
          aria-live="polite"
          aria-label={copy.title}
          tabIndex={0}
          ref={messagesRef}
        >
          {messages.map((msg, i) => (
            <div key={i} className={msg.role === 'bot' ? 'bot-bubble' : 'user-bubble'}>
              {textOf(i, msg.text)}
            </div>
          ))}
          {loading && (
            <div className="bot-bubble chat-thinking">
              <span className="loading-spinner" />
              {copy.sending}
            </div>
          )}
        </div>

        {isFirstVisit && <p className="chat-empty-hint">{copy.emptyHint}</p>}

        <WeatherContextStrip context={context} label={copy.contextLabel} />

        {/* Single-line input inside a form, so Enter submits and there is no
            Shift+Enter newline case to handle. The mascot on the left reacts to
            the live conditions, like a small companion on the search bar. */}
        <form className="chat-input" onSubmit={onSubmit}>
          <WeatherBot condition={context?.condition} rain={context?.rain} size={26} className="chat-input-bot" />
          <input
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder={copy.placeholder}
            aria-label={copy.title}
            disabled={loading}
          />
          <button type="submit" className="chat-send" aria-label={copy.send} disabled={!canSend}>
            <Send size={14} />
            <span>{copy.send}</span>
          </button>
        </form>
      </div>
    </>
  )
}
