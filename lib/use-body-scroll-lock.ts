'use client'

import { useEffect } from 'react'

/*
 * One body scroll lock, shared by every surface that needs it.
 *
 * Two surfaces claim it today — the Dynamic Island and the demo scenario picker
 * — and both can be open at once, because the demo control lives in the topbar
 * and the island floats above it. Two independent effects each saving and
 * restoring `document.body.style.overflow` would stomp on each other: whichever
 * closed first would restore the value it captured *before* the other one
 * locked, unlocking the page while a surface was still open. So the lock is
 * reference counted at module scope. It applies on the first claim and releases
 * on the last, and the original styles are captured once, at that first claim.
 */

let claims = 0
let restore: { overflow: string; paddingRight: string } | null = null

/**
 * Width of the classic scrollbar, or 0 on an overlay-scrollbar platform.
 *
 * Hiding the scrollbar widens the viewport — measured at 15px on this machine —
 * so without compensation opening the island shoves the whole dashboard sideways
 * and drags the centred island with it. Measured live rather than cached: a
 * window moved between a trackpad-only display and a mouse can change the
 * answer, and this runs at most twice per open.
 */
function scrollbarWidth(): number {
  return Math.max(0, window.innerWidth - document.documentElement.clientWidth)
}

/**
 * Freeze the page behind an overlay while `active` is true.
 *
 * Safe to call unconditionally from any number of components; the count does the
 * arbitration. The cleanup releases this component's claim even if it unmounts
 * while still locked, so a surface that disappears mid-transition cannot strand
 * the page.
 */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return

    if (claims === 0) {
      const body = document.body
      restore = { overflow: body.style.overflow, paddingRight: body.style.paddingRight }
      const gap = scrollbarWidth()
      body.style.overflow = 'hidden'
      // Only when there is a real scrollbar to replace. Adding 0px is harmless
      // but writing the property at all overrides a stylesheet value, so skip it.
      if (gap > 0) body.style.paddingRight = `${gap}px`
    }
    claims += 1

    return () => {
      claims -= 1
      if (claims > 0 || !restore) return
      document.body.style.overflow = restore.overflow
      document.body.style.paddingRight = restore.paddingRight
      restore = null
    }
  }, [active])
}
