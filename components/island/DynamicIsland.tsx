'use client'

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react'
import { ChevronDown, MessageSquare, ShieldCheck, TriangleAlert, Zap } from 'lucide-react'
import { useBodyScrollLock } from '@/lib/use-body-scroll-lock'

/**
 * Which face the island is currently wearing.
 *
 * These are states of ONE object, not three components. The whole point of the
 * shape is that it morphs — a container that resizes while its contents
 * cross-fade — so every state is mounted at all times and the shell animates
 * between their sizes. Swapping elements in and out would give a popover that
 * appears, which is a different and much cheaper effect.
 */
export type IslandState = 'collapsed' | 'alert' | 'expanded'

/** Reuses the page's own risk vocabulary so the island can never invent a level. */
export type IslandAlertLevel = 'high' | 'moderate' | 'safe' | 'notice'

export type IslandAlert = {
  level: IslandAlertLevel
  /** One short line. The island is not a place to read a bulletin in full. */
  title: string
  detail?: string
}

export type DynamicIslandCopy = {
  /** Collapsed label — what tapping the island does. */
  hint: string
  /** Accessible name for the collapsed control and the expanded panel. */
  label: string
  /** Heading inside the expanded state. */
  title: string
  close: string
}

export type DynamicIslandProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * A transient warning to wear instead of the pill, or null. Only ever shown
   * from the collapsed state — see the guard in the page: interrupting someone
   * mid-question to flash a banner at them is worse than letting the alerts
   * section and the OS notification carry it.
   */
  alert?: IslandAlert | null
  onAlertDismiss?: () => void
  /** Leading glyph in the collapsed pill. The brand mark, in practice. */
  mark: ReactNode
  copy: DynamicIslandCopy
  /** The expanded body. The chat panel, in practice. */
  children: ReactNode
}

const ALERT_ICON: Record<IslandAlertLevel, typeof TriangleAlert> = {
  high: TriangleAlert,
  moderate: Zap,
  safe: ShieldCheck,
  notice: MessageSquare,
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * How long a warning wears the island before it settles back to the pill.
 * Long enough to read two short lines without rushing; short enough that it is
 * clearly a notification and not a new permanent header.
 */
const ALERT_DWELL_MS = 5200

/**
 * A Dynamic Island: the app's chat, folded into a floating pill at the top of
 * the page that morphs open when you tap it.
 *
 * Three things make the morph read as Apple's rather than as a dropdown:
 *
 *  1. **One container.** The shell's width, height and corner radius animate
 *     together. Nothing is unmounted, nothing slides in from off-screen.
 *  2. **A real spring.** The open transition uses a sampled spring curve
 *     (`--island-spring` in globals.css) with ~5% overshoot, which a
 *     `cubic-bezier` cannot express — it is monotonic by construction. Closing
 *     uses a plain decelerating curve instead, because a shape that shrinks
 *     past its target and springs back looks like a glitch.
 *  3. **The container leads.** Incoming content starts slightly scaled down and
 *     fades in on a delay, so the shape arrives first and the contents settle
 *     into it. That lag is most of what the eye reads as physical.
 *
 * State lives in the page, not here, so closing the island never cancels a
 * question in flight: the answer lands in the transcript and is waiting the next
 * time it opens.
 */
export default function DynamicIsland({
  open,
  onOpenChange,
  alert = null,
  onAlertDismiss,
  mark,
  copy,
  children,
}: DynamicIslandProps) {
  const panelId = useId()
  const shellRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)

  const state: IslandState = open ? 'expanded' : alert ? 'alert' : 'collapsed'

  // The page behind holds still while the island is open. Without this, reaching
  // the end of the transcript hands the wheel straight to the document and the
  // dashboard slides away underneath the panel — which reads as a bug, not as a
  // layer. `overscroll-behavior: contain` on the transcript (globals.css) stops
  // the chaining; this stops the page moving at all, including from a wheel over
  // the scrim. Shared and reference counted, because the demo picker locks too
  // and both can be open at once.
  useBodyScrollLock(open)

  const close = useCallback(() => {
    onOpenChange(false)
    // Focus goes back where it came from, or a keyboard user is dropped at the
    // top of the document with no idea what just collapsed.
    pillRef.current?.focus()
  }, [onOpenChange])

  // Escape closes from anywhere, including from inside the transcript.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // Click anywhere outside. `pointerdown` rather than `click` so a drag that
  // starts outside and ends inside does not count as an inside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!shellRef.current?.contains(e.target as Node)) close()
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open, close])

  // Put the caret in the input on open. One frame late, so it happens after the
  // panel is laid out — focusing a zero-height element makes some browsers
  // scroll the page to it.
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => {
      shellRef.current?.querySelector<HTMLInputElement>('.chat-input input')?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [open])

  // A warning settles back to the pill on its own. Under reduced motion it is
  // held twice as long instead: someone who has asked for less movement is more
  // likely to be reading slowly, and the alert is the one thing here that
  // disappears whether or not it was read.
  useEffect(() => {
    if (!alert || open || !onAlertDismiss) return
    const hold = prefersReducedMotion() ? ALERT_DWELL_MS * 2 : ALERT_DWELL_MS
    const timer = window.setTimeout(onAlertDismiss, hold)
    return () => window.clearTimeout(timer)
  }, [alert, open, onAlertDismiss])

  const AlertIcon = alert ? ALERT_ICON[alert.level] : MessageSquare

  return (
    <div className="island-root" data-state={state}>
      {/* Dims the page a little behind the expanded panel. Apple's island has no
          scrim, but Apple's island is not sitting on top of a dense dashboard —
          without this the transcript competes with the hero behind it. It is
          also what makes click-to-dismiss discoverable. Inert: the pointerdown
          listener above does the closing, so this never swallows a click meant
          for the page. */}
      <div className="island-scrim" aria-hidden="true" />

      <div className="island-shell" ref={shellRef}>
        {/* ── Collapsed ── */}
        <button
          type="button"
          ref={pillRef}
          className="island-face island-pill"
          onClick={() => onOpenChange(true)}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={copy.label}
          // Removed from the tab order while another face is showing, so Tab
          // never lands on a control that is faded out and unclickable.
          tabIndex={state === 'collapsed' ? 0 : -1}
        >
          <span className="island-pill-mark">{mark}</span>
          <span className="island-pill-hint">{copy.hint}</span>
          <MessageSquare size={14} className="island-pill-cue" />
        </button>

        {/* ── Alert ──
            A button, because the useful thing to do with a warning is ask about
            it, and that is one tap away. */}
        <button
          type="button"
          className={`island-face island-alert level-${alert?.level ?? 'notice'}`}
          onClick={() => onOpenChange(true)}
          tabIndex={state === 'alert' ? 0 : -1}
          aria-hidden={state !== 'alert'}
        >
          <span className="island-alert-icon"><AlertIcon size={16} /></span>
          <span className="island-alert-copy">
            <strong>{alert?.title}</strong>
            {alert?.detail && <span>{alert.detail}</span>}
          </span>
        </button>

        {/* ── Expanded ──
            role=dialog without aria-modal. The page behind is frozen in place
            while this is open, but it is not hidden and it is not inert: it
            stays fully visible, its links and controls still work, and clicking
            any of them dismisses the island rather than being swallowed.
            aria-modal would tell a screen reader the rest of the document has
            been removed from the accessibility tree, which is not what happens
            here. Escape and click-outside are the exits. */}
        <div
          id={panelId}
          className="island-face island-panel"
          role="dialog"
          aria-label={copy.label}
          aria-hidden={state !== 'expanded'}
        >
          <div className="island-panel-top">
            <div className="island-panel-titles">
              <strong>{copy.title}</strong>
            </div>
            <button
              type="button"
              className="island-close"
              onClick={close}
              aria-label={copy.close}
              title={copy.close}
              tabIndex={state === 'expanded' ? 0 : -1}
            >
              <ChevronDown size={16} />
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}
