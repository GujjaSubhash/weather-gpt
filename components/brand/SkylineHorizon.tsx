/**
 * A Hyderabad horizon, drawn low across the base of the hero.
 *
 * Left to right: the Golconda ridge, Mecca Masjid, Charminar dead centre, then
 * the HITEC City towers and a domed civic block. Charminar is rendered from the
 * *same path as the logo* (components/brand/CharminarMark.tsx), scaled up and
 * with the droplet subpath dropped — so the mark in the header and the monument
 * on the skyline are literally the same shape, and the rain falls onto it.
 *
 * `slice` rather than `meet`: on a narrow screen the band keeps its height and
 * crops from the sides, which loses a tower or two but never squashes the
 * buildings or shrinks the horizon to a stripe. Charminar is centred, so it is
 * the last thing to go.
 *
 * Decorative and inert — no reading, no claim, no pointer events.
 */
export default function SkylineHorizon({ className }: { className?: string }) {
  return (
    <svg
      className={['skyline-horizon', className].filter(Boolean).join(' ')}
      viewBox="0 0 1200 120"
      preserveAspectRatio="xMidYMax slice"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {/* Golconda: a rising ridge with the fort on the plateau. */}
      <path d="M0 120V104C40 104 78 88 104 74H118V60H132V74H150C170 82 188 92 206 96V120Z" />

      {/* Old city low-rise leading up to the mosque. */}
      <rect x="206" y="96" width="46" height="24" />
      <rect x="258" y="86" width="34" height="34" />
      <rect x="298" y="98" width="28" height="22" />
      <rect x="332" y="90" width="40" height="30" />

      {/* Mecca Masjid: dome flanked by two capped minarets. */}
      <rect x="386" y="88" width="76" height="32" />
      <path d="M404 88a20 20 0 0 1 40 0Z" />
      <rect x="380" y="62" width="8" height="58" />
      <rect x="460" y="62" width="8" height="58" />
      <circle cx="384" cy="62" r="4" />
      <circle cx="464" cy="62" r="4" />

      <rect x="474" y="100" width="30" height="20" />
      <rect x="508" y="94" width="28" height="26" />

      {/* Charminar — the logo path, scaled to the skyline and centred on x=600.
          Only the silhouette and its arch; the droplet belongs to the mark. */}
      <g transform="translate(532.8 -3.2) scale(5.6)">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M2 22V7.4C2 4.6 5.6 4.6 5.6 7.4V10.4H18.4V7.4C18.4 4.6 22 4.6 22 7.4V22H2Z
             M8.6 22V17C8.6 14.4 10.2 12.9 12 12.6C13.8 12.9 15.4 14.4 15.4 17V22H8.6Z"
        />
      </g>

      {/* HITEC City. */}
      <rect x="660" y="96" width="26" height="24" />
      <rect x="692" y="84" width="34" height="36" />
      <rect x="734" y="52" width="30" height="68" />
      <rect x="770" y="66" width="22" height="54" />
      <path d="M800 120V46l12-14 12 14v74Z" />
      <rect x="834" y="58" width="36" height="62" />
      <rect x="876" y="88" width="24" height="32" />
      <rect x="906" y="70" width="40" height="50" />
      <rect x="952" y="92" width="26" height="28" />

      {/* A domed civic block to close the run. */}
      <rect x="990" y="90" width="84" height="30" />
      <path d="M1014 90a18 18 0 0 1 36 0Z" />
      <rect x="984" y="76" width="6" height="44" />
      <rect x="1068" y="76" width="6" height="44" />

      <rect x="1084" y="98" width="30" height="22" />
      <rect x="1120" y="88" width="34" height="32" />
      <rect x="1160" y="100" width="40" height="20" />
    </svg>
  )
}
