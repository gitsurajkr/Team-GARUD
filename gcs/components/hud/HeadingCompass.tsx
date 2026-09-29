"use client";

/**
 * Heading compass, north-up: the N/E/S/W ring is FIXED and the arrow rotates to
 * point at the current heading. `heading` is degrees 0..360.
 */
export function HeadingCompass({
  heading,
  size = 128,
}: {
  heading: number | null;
  size?: number;
}) {
  const hdg = heading ?? 0;
  const c = 60;
  const cardinals = [
    { a: 0, t: "N", col: "#f87171" },
    { a: 90, t: "E", col: "#ffffff" },
    { a: 180, t: "S", col: "#ffffff" },
    { a: 270, t: "W", col: "#ffffff" },
  ];
  const ticks = Array.from({ length: 36 }, (_, i) => i * 10);

  return (
    <svg width={size} height={size} viewBox="0 0 120 120">
      <circle cx={c} cy={c} r={56} fill="#0d1117" stroke="#3a3a3a" strokeWidth={1.5} />

      {/* FIXED tick ring */}
      {ticks.map((t) => {
        const major = t % 30 === 0;
        const rad = (t * Math.PI) / 180;
        const sin = Math.sin(rad);
        const cos = Math.cos(rad);
        const r1 = 56;
        const r2 = major ? 47 : 51;
        return (
          <line
            key={t}
            x1={c + r1 * sin}
            y1={c - r1 * cos}
            x2={c + r2 * sin}
            y2={c - r2 * cos}
            stroke="#6b7280"
            strokeWidth={major ? 1.5 : 0.8}
          />
        );
      })}

      {/* FIXED cardinals */}
      {cardinals.map(({ a, t, col }) => {
        const rad = (a * Math.PI) / 180;
        const r = 38;
        return (
          <text
            key={t}
            x={c + r * Math.sin(rad)}
            y={c - r * Math.cos(rad) + 4}
            textAnchor="middle"
            fontSize={12}
            fontWeight={700}
            fill={col}
          >
            {t}
          </text>
        );
      })}

      {/* ROTATING heading arrow (points at the heading) */}
      <g transform={`rotate(${hdg} ${c} ${c})`}>
        {/* tail */}
        <line x1={c} y1={c} x2={c} y2={c + 24} stroke="#38bdf8" strokeWidth={2} opacity={0.5} />
        {/* nose */}
        <path d={`M ${c} ${c - 34} l -6 14 l 12 0 z`} fill="#38bdf8" />
        <line x1={c} y1={c} x2={c} y2={c - 20} stroke="#38bdf8" strokeWidth={2.5} />
      </g>
      <circle cx={c} cy={c} r={3} fill="#38bdf8" />

      {/* readout */}
      <text x={c} y={c + 20} textAnchor="middle" fontSize={13} fontWeight={700} fill="#ffffff" fontFamily="monospace">
        {Math.round(hdg)}°
      </text>
    </svg>
  );
}
