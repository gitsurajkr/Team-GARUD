"use client";

/**
 * Vertical measurement tape (speed on the left, altitude on the right), styled
 * after the reference GCS. Shows a moving scale with the live value boxed at
 * the centre index.
 */
export function Tape({
  label,
  unit,
  value,
  step = 2,
  side,
}: {
  label: string;
  unit: string;
  value: number | null;
  step?: number;
  side: "left" | "right";
}) {
  const v = value ?? 0;
  const rows = 11; // odd so there's a middle row
  const mid = (rows - 1) / 2;
  // nearest step boundary near the value, so ticks scroll smoothly
  const base = Math.round(v / step) * step;
  const ticks = Array.from({ length: rows }, (_, i) => base + (mid - i) * step);
  const pxPerUnit = 14 / step;
  const shift = (v - base) * pxPerUnit;

  return (
    <div className="w-14 h-50 rounded-lg overflow-hidden flex flex-col">
      <div className="text-center text-[12px] uppercase tracking-wider font-extrabold text-black pt-1">
        {label}
      </div>
      <div className="text-center font-bold text-[10px] text-black -mt-0.5">{unit}</div>
      <div className="relative flex-1 overflow-hidden">
        <div
          className="absolute inset-x-0"
          style={{ top: "50%", transform: `translateY(calc(-50% + ${shift}px))` }}
        >
          {ticks.map((t, i) => (
            <div
              key={i}
              className="flex items-center justify-center text-[10px] font-bold text-black"
              style={{ height: 14 }}
            >
              {t}
            </div>
          ))}
        </div>
        {/* centre index box with live value */}
        <div
          className={`absolute left-0 right-0 top-1/2 -translate-y-1/2 h-4 flex items-center justify-center bg-black border-y border-sky-400/50`}
        >
          <span className="text-xs font-mono font-bold text-white">{v.toFixed(1)}</span>
        </div>
        <div
          className={`absolute top-1/2 -translate-y-1/2 ${side === "left" ? "right-0" : "left-0"} w-0 h-0`}
          style={{
            borderTop: "5px solid transparent",
            borderBottom: "5px solid transparent",
            [side === "left" ? "borderRight" : "borderLeft"]: "6px solid #38bdf8",
          }}
        />
      </div>
    </div>
  );
}
