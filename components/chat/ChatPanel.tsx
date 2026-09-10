'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Send, Mic, Square, Volume2, VolumeX } from 'lucide-react'
import WeatherContextStrip, { type ChatContext } from './WeatherContextStrip'
import { MetalButton } from '@/components/ui/liquid-glass-button'
import {
  canSpeak,
  isListeningSupported,
  listenOnce,
  onVoicesReady,
  speak,
  stopSpeaking,
  type SpeechLang,
  type SpeechRecognitionHandle,
} from '@/lib/speech'

export type ChatPanelMessage = { role: 'user' | 'bot'; text: string }

export type ChatPanelCopy = {
  /**
   * Accessible name for the transcript and the input. The visible heading now
   * belongs to whatever surface hosts the panel (the Dynamic Island), so this is
   * the only copy the panel needs to name itself.
   */
  title: string
  placeholder: string
  sending: string
  contextLabel: string
  /** Accessible name and visible label for the submit control. */
  send: string
  /** Voice controls. See lib/speech.ts for why these can go unrendered. */
  voiceListen: string
  voiceListening: string
  voiceSpeak: string
  voiceStopSpeaking: string
  voiceDenied: string
  voiceNoSpeech: string
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
  /** Drives which voice speaks and which language is dictated. */
  lang: SpeechLang
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
  lang,
}: ChatPanelProps) {
  const [reveal, setReveal] = useState<{ index: number; chars: number } | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)

  // ── Voice ──
  // Both capabilities are resolved after mount, never during render: they read
  // `window`, and a server render that guessed "supported" would hydrate into a
  // button that does nothing on a browser without the API.
  const [canListen, setCanListen] = useState(false)
  const [canSpeakHere, setCanSpeakHere] = useState(false)
  const [listening, setListening] = useState(false)
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognitionHandle | null>(null)

  useEffect(() => {
    setCanListen(isListeningSupported())
  }, [])

  // Chrome fills the voice list asynchronously and refills it when the OS gains
  // a voice pack, so this is a subscription rather than a one-shot check —
  // otherwise the Telugu button would stay hidden on a machine that can in fact
  // speak Telugu.
  useEffect(() => {
    setCanSpeakHere(canSpeak(lang))
    return onVoicesReady(() => setCanSpeakHere(canSpeak(lang)))
  }, [lang])

  // Switching language mid-conversation must not leave an English voice reading
  // on, or the microphone listening for the wrong language.
  useEffect(() => {
    stopSpeaking()
    setSpeakingIndex(null)
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setListening(false)
    setVoiceError(null)
  }, [lang])

  // Leaving the page with audio still playing is the one failure the user
  // cannot cancel from the UI.
  useEffect(() => () => {
    stopSpeaking()
    recognitionRef.current?.stop()
  }, [])

  const handleMic = useCallback(() => {
    if (listening) {
      // stop() still delivers whatever was heard; it does not discard it.
      recognitionRef.current?.stop()
      return
    }

    setVoiceError(null)
    const handle = listenOnce(lang, {
      onResult: (transcript) => onInputChange(transcript),
      onError: (code) => {
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          setVoiceError(copy.voiceDenied)
        } else if (code === 'no-speech') {
          setVoiceError(copy.voiceNoSpeech)
        }
        // Every other code ('aborted', 'network', …) is either self-inflicted or
        // not actionable by the user, so it passes silently.
      },
      onEnd: () => {
        recognitionRef.current = null
        setListening(false)
      },
    })

    if (!handle) return
    recognitionRef.current = handle
    setListening(true)
  }, [listening, lang, onInputChange, copy.voiceDenied, copy.voiceNoSpeech])

  const handleSpeak = useCallback(
    (index: number, text: string) => {
      if (speakingIndex === index) {
        stopSpeaking()
        setSpeakingIndex(null)
        return
      }
      // Always the whole message, never the progressively revealed slice.
      const started = speak(text, lang, () => setSpeakingIndex(null))
      setSpeakingIndex(started ? index : null)
    },
    [speakingIndex, lang]
  )

  useEffect(() => {
    const index = messages.length - 1
    // `index < 1` covers both the empty transcript (-1) and the opening user
    // turn (0) — the first thing that can ever be revealed is the reply at index
    // 1. A user turn also cancels any reveal in flight, which drops the previous
    // answer straight to its full text.
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

  const canSend = !loading && input.trim().length > 0

  return (
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
            {/* Read-aloud is offered only when a voice for THIS language is
                actually installed — see the honesty rule in lib/speech.ts. */}
            {msg.role === 'bot' && canSpeakHere && msg.text.trim() && (
              <button
                type="button"
                className="chat-speak"
                onClick={() => handleSpeak(i, msg.text)}
                aria-label={speakingIndex === i ? copy.voiceStopSpeaking : copy.voiceSpeak}
                title={speakingIndex === i ? copy.voiceStopSpeaking : copy.voiceSpeak}
              >
                {speakingIndex === i ? <VolumeX size={13} /> : <Volume2 size={13} />}
              </button>
            )}
          </div>
        ))}
        {loading && (
          <div className="bot-bubble chat-thinking">
            <span className="loading-spinner" />
            {copy.sending}
          </div>
        )}
      </div>

      <WeatherContextStrip context={context} label={copy.contextLabel} />

      {/* Single-line input inside a form, so Enter submits and there is no
          Shift+Enter newline case to handle. */}
      <form className="chat-input" onSubmit={onSubmit}>
        <input
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder={copy.placeholder}
          aria-label={copy.title}
          disabled={loading}
        />
        {canListen && (
          <button
            type="button"
            className={`chat-mic${listening ? ' is-listening' : ''}`}
            onClick={handleMic}
            disabled={loading}
            aria-label={listening ? copy.voiceListening : copy.voiceListen}
            title={listening ? copy.voiceListening : copy.voiceListen}
            aria-pressed={listening}
          >
            {listening ? <Square size={14} /> : <Mic size={14} />}
          </button>
        )}
        <MetalButton
          type="submit"
          aria-label={copy.send}
          disabled={!canSend}
          className="h-9 gap-1.5 rounded-full px-3.5 text-xs"
        >
          <Send size={14} />
          <span>{copy.send}</span>
        </MetalButton>
      </form>

      {/* Only the two failures a user can act on: grant the permission, or
          speak up. role=status so it is announced without stealing focus. */}
      {voiceError && (
        <p className="chat-voice-error" role="status">
          {voiceError}
        </p>
      )}
    </div>
  )
}
