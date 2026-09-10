/**
 * One place that decides what the weather "is", for anything that has to look
 * like the weather rather than report it.
 */
export type Variant = 'clear' | 'cloud' | 'rain' | 'storm'

/**
 * Classifies a reading into one of four moods.
 *
 * Rainfall is a MEASUREMENT, so a positive value wins outright over the
 * condition text — an upstream feed that says "Clear" while the gauge reads
 * 4mm is wrong about the sky, and the number is the thing we trust. Within a
 * rainy reading the text still decides between plain rain and a storm. With no
 * rain we fall back to the text, and finally to 'clear', which is also what the
 * entry screen gets before any reading exists.
 *
 * Lives in lib/ rather than beside a component because two surfaces read it and
 * neither owns it: the backdrop picks its gradient palette here, and the rain
 * canvas keys its density off the same answer. If they disagreed, the page would
 * be raining on a sunny gradient.
 */
export function variantOf(condition?: string, rain?: number): Variant {
  const c = condition ?? ''
  if (typeof rain === 'number' && rain > 0) {
    return /storm|thunder|lightning/i.test(c) ? 'storm' : 'rain'
  }
  if (/storm|thunder|lightning/i.test(c)) return 'storm'
  if (/rain|drizzle|shower/i.test(c)) return 'rain'
  if (/cloud|overcast|mist|fog|haze|smoke/i.test(c)) return 'cloud'
  return 'clear'
}
