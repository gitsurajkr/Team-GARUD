"use client";

import { DroneLogo } from "./DroneLogo";

/** Compact product name + drone logo — replaces the removed header bar. */
export function Brand() {
  return (
    <div className="flex items-center gap-2">
      <DroneLogo size={30} />
      <div className="leading-tight">
        <div className="text-sm font-bold tracking-wide text-white/95">GARUD</div>
      </div>
    </div>
  );
}
