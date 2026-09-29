"use client";

/**
 * Artificial horizon with a graduated pitch ladder (±10/±20°) and a roll scale
 * (0/±10/±20/±30/±45/±60°). Roll rotates the horizon + roll scale under a fixed
 * top index; pitch slides the ladder. `roll`/`pitch` are radians.
 */
export function AttitudeIndicator({
  roll,
  pitch,
  size = 120,
}: {
  roll: number | null;
  pitch: number | null;
  size?: number;
}) {
  const rollDeg = ((roll ?? 0) * 180) / Math.PI;
  const pitchDeg = ((pitch ?? 0) * 180) / Math.PI;
  const c = 60;
  const pxPerDeg = 1.7;
  const pitchOffset = Math.max(-50, Math.min(50, pitchDeg * pxPerDeg));

  const ladder = [-20, -10, 10, 20];
  const rollTicks = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];

  return (
    <svg width={size} height={size} viewBox="0 0 120 120">
      <defs>
        <clipPath id="att-clip">
          <circle cx={c} cy={c} r={54} />
        </clipPath>
      </defs>

      <g clipPath="url(#att-clip)">
        {/* horizon: rolls + pitches */}
        <g transform={`rotate(${-rollDeg} ${c} ${c})`}>
          <g transform={`translate(0 ${pitchOffset})`}>
            <rect x={-160} y={-320} width={380} height={380} fill="#2b6cff" />
            <rect x={-160} y={60} width={380} height={380} fill="#5a7d2b" />
            <line x1={-160} y1={60} x2={220} y2={60} stroke="#ffffff" strokeWidth={1.5} />
            {ladder.map((d) => {
              const y = 60 - d * pxPerDeg;
              const w = d % 20 === 0 ? 30 : 18;
              return (
                <g key={d} stroke="#ffffff" strokeWidth={1}>
                  <line x1={c - w / 2} y1={y} x2={c - 6} y2={y} />
                  <line x1={c + 6} y1={y} x2={c + w / 2} y2={y} />
                  <text x={c - w / 2 - 3} y={y + 2.5} textAnchor="end" fontSize={6} fill="#ffffff" stroke="none">
                    {Math.abs(d)}
                  </text>
                  <text x={c + w / 2 + 3} y={y + 2.5} textAnchor="start" fontSize={6} fill="#ffffff" stroke="none">
                    {Math.abs(d)}
                  </text>
                </g>
              );
            })}
          </g>
        </g>

        {/* roll scale: rolls only, slides under the fixed index */}
        <g transform={`rotate(${-rollDeg} ${c} ${c})`}>
          {rollTicks.map((t) => {
            const rad = (t * Math.PI) / 180;
            const major = t === 0 || Math.abs(t) === 30 || Math.abs(t) === 60;
            const r1 = 53;
            const r2 = major ? 45 : 48.5;
            return (
              <line
                key={t}
                x1={c + r1 * Math.sin(rad)}
                y1={c - r1 * Math.cos(rad)}
                x2={c + r2 * Math.sin(rad)}
                y2={c - r2 * Math.cos(rad)}
                stroke="#ffffff"
                strokeWidth={major ? 1.4 : 0.8}
              />
            );
          })}
        </g>
      </g>

      {/* bezel */}
      <circle cx={c} cy={c} r={54} fill="none" stroke="#0a0a0a" strokeWidth={4} />
      <circle cx={c} cy={c} r={55.5} fill="none" stroke="#3a3a3a" strokeWidth={1.5} />

      {/* fixed roll index (top) */}
      <path d={`M ${c} 9 l -4 7 l 8 0 z`} fill="#ffcc00" />

      {/* fixed aircraft reference */}
      <g stroke="#ffcc00" strokeWidth={2.5} fill="none" strokeLinecap="round">
        <line x1={c - 22} y1={c} x2={c - 8} y2={c} />
        <line x1={c + 8} y1={c} x2={c + 22} y2={c} />
        <path d={`M ${c - 8} ${c} l 8 6 l 8 -6`} />
      </g>
      <circle cx={c} cy={c} r={1.8} fill="#ffcc00" />

      {/* pitch / roll readout */}
      {/* <rect x={26} y={96} width={68} height={13} rx={3} fill="#000000" opacity={0.55} /> */}
      {/* <text x={c} y={105} textAnchor="middle" fontSize={8.5} fill="#ffffff" fontFamily="monospace">
        {`P${pitchDeg >= 0 ? "+" : ""}${Math.round(pitchDeg)}°  R${rollDeg >= 0 ? "+" : ""}${Math.round(rollDeg)}°`}
      </text> */}
    </svg>
  );
}
