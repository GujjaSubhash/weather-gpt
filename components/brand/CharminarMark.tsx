/**
 * The WeatherGPT mark: Charminar, holding a raindrop in its arch.
 *
 * Drawn as ONE path with three subpaths and `fill-rule="evenodd"`:
 *   1. the monument silhouette   → filled
 *   2. the central arch opening  → knocked out
 *   3. the droplet               → filled again, floating inside the opening
 *
 * The droplet is a negative-space island rather than a shape stacked on top,
 * because a 1px droplet outline vanishes at favicon size while a solid blob
 * inside a solid arch still reads. Everything is sized on a 24 grid and tested
 * down to 16px, where the two domed minarets flanking a lower cornice are what
 * carries the recognition — not the detail.
 *
 * Decorative: the wordmark next to it is the accessible name, so this is
 * aria-hidden everywhere it appears.
 *
 * ── Swapping this out ──
 * Replacing the logo means replacing the `<path>` below and the identical one
 * in `app/icon.svg`. No call site changes.
 */
export default function CharminarMark({
  size = 16,
  className,
}: {
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2 22V7.4C2 4.6 5.6 4.6 5.6 7.4V10.4H18.4V7.4C18.4 4.6 22 4.6 22 7.4V22H2Z
           M8.6 22V17C8.6 14.4 10.2 12.9 12 12.6C13.8 12.9 15.4 14.4 15.4 17V22H8.6Z
           M12 14.4C12 14.4 9.9 17.3 9.9 18.8A2.1 2.1 0 1 0 14.1 18.8C14.1 17.3 12 14.4 12 14.4Z"
      />
    </svg>
  )
}
