"use client";

/** Quadcopter mark used as the GARUD brand logo. */
export function DroneLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
      <defs>
        <linearGradient id="garud-drone" x1="0" y1="0" x2="48" y2="48">
          <stop offset="0" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#34d399" />
        </linearGradient>
      </defs>

      {/* arms (X frame) */}
      <g stroke="url(#garud-drone)" strokeWidth="2.5" strokeLinecap="round">
        <line x1="24" y1="24" x2="10" y2="10" />
        <line x1="24" y1="24" x2="38" y2="10" />
        <line x1="24" y1="24" x2="10" y2="38" />
        <line x1="24" y1="24" x2="38" y2="38" />
      </g>

      {/* rotor hubs */}
      <g stroke="url(#garud-drone)" strokeWidth="2" fill="#0b0f14">
        <circle cx="10" cy="10" r="6" />
        <circle cx="38" cy="10" r="6" />
        <circle cx="10" cy="38" r="6" />
        <circle cx="38" cy="38" r="6" />
      </g>

      {/* spinning blades (hint) */}
      <g stroke="url(#garud-drone)" strokeWidth="1.4" strokeLinecap="round" opacity="0.9">
        <line x1="5.5" y1="10" x2="14.5" y2="10" />
        <line x1="33.5" y1="10" x2="42.5" y2="10" />
        <line x1="5.5" y1="38" x2="14.5" y2="38" />
        <line x1="33.5" y1="38" x2="42.5" y2="38" />
      </g>

      {/* body */}
      <rect x="18" y="18" width="12" height="12" rx="3.5" fill="url(#garud-drone)" />
    </svg>
  );
}
