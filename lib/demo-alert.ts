/**
 * Warning tones for the demo scenario picker — PRESENTATION ONLY.
 *
 * Synthesized with the Web Audio API rather than shipped as an audio file: no
 * new dependency, no asset to load, and nothing to fetch mid-demo. A civil-
 * defence style two-tone warble, because that is what a flood warning is
 * expected to sound like.
 *
 * Only ever called from a demo button's click handler. That matters twice over:
 * browsers block audio that is not tied to a user gesture, and it means the
 * alarm can never fire on its own in front of an audience — never on a real
 * reading, only when a demo scenario is deliberately launched. Clear Sky calls
 * nothing at all.
 */

export type DemoAlertLevel = 'high' | 'moderate';

/** The two alternating pitches. The hard switch between them is what reads as a siren. */
const TONE_HIGH_HZ = 660;
const TONE_LOW_HZ = 440;

type Profile = {
  /** One cycle is a high tone followed by a low tone. */
  cycles: number;
  /** Seconds per tone. */
  segment: number;
  /** Peak gain. Kept well under 1 — this plays through laptop speakers in a room. */
  peak: number;
  /** Fade in/out, so neither edge clicks. Longer on moderate to soften it further. */
  ramp: number;
};

const PROFILES: Record<DemoAlertLevel, Profile> = {
  // ~1.5s of unmistakable alarm.
  high: { cycles: 3, segment: 0.25, peak: 0.18, ramp: 0.015 },
  // One cycle at roughly a third the level, with a slower fade: present, but
  // clearly not an emergency.
  moderate: { cycles: 1, segment: 0.22, peak: 0.065, ramp: 0.05 },
};

let context: AudioContext | null = null;
let active: { osc: OscillatorNode; gain: GainNode } | null = null;

/** Lazily created, so no AudioContext exists until a demo button is actually pressed. */
function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context) context = new Ctor();
  return context;
}

/** Fade out anything still sounding, so rapid scenario switching does not overlap. */
function stopActive(audio: AudioContext): void {
  if (!active) return;
  const { osc, gain } = active;
  active = null;
  try {
    const now = audio.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.02);
    osc.stop(now + 0.03);
  } catch {
    // The oscillator had already finished; nothing to stop.
  }
}

/**
 * Play the warble for a demo scenario's severity. Silently does nothing when the
 * browser has no Web Audio support — a missing sound must never break the demo.
 */
export function playDemoAlert(level: DemoAlertLevel): void {
  const audio = getContext();
  if (!audio) return;

  const profile = PROFILES[level];

  try {
    stopActive(audio);

    // Contexts can start suspended until a gesture resumes them. The call site is
    // always a click, so this settles immediately in practice.
    if (audio.state === 'suspended') void audio.resume();

    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(audio.destination);

    const start = audio.currentTime;
    const segments = profile.cycles * 2;
    const duration = segments * profile.segment;

    for (let i = 0; i < segments; i++) {
      osc.frequency.setValueAtTime(
        i % 2 === 0 ? TONE_HIGH_HZ : TONE_LOW_HZ,
        start + i * profile.segment,
      );
    }

    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(profile.peak, start + profile.ramp);
    gain.gain.setValueAtTime(profile.peak, start + duration - profile.ramp);
    gain.gain.linearRampToValueAtTime(0, start + duration);

    osc.start(start);
    osc.stop(start + duration);
    osc.onended = () => {
      if (active?.osc === osc) active = null;
    };
    active = { osc, gain };
  } catch {
    // Audio is decoration on a presentation aid. If the browser refuses, the
    // scenario still loads.
  }
}
