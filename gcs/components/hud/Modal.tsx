"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * Centred dialog over a dimmed backdrop. Closes on Escape or a backdrop click;
 * clicks inside are stopped so dragging a value never dismisses the panel.
 *
 * Rendered through a portal into <body> ON PURPOSE. The callers live inside the
 * HUD, whose wrappers use `-translate-x-1/2` to centre themselves — and a CSS
 * transform makes an ancestor the containing block for `position: fixed`
 * descendants. Rendered in place, `inset-0` would size itself to the command
 * dock instead of the viewport and the dialog would sit down by the dock.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Never rendered during prerender — a panel only exists after an operator
  // click — so this guard costs nothing and avoids touching document on the server.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // calc, not 100vh: the backdrop's p-4 means a full-height child would
        // overflow the centring container and clip at the top.
        className="flex max-h-[calc(100vh-2rem)] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-white/15 bg-[#0a0e13] shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-white/10 px-4 py-2.5">
          <div className="min-w-0 pr-2">
            <div className="text-[13px] font-bold tracking-wide text-white/90">{title}</div>
            {subtitle && <div className="mt-0.5 text-[10px] leading-snug text-white/40">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 px-2 text-lg leading-none text-white/40 hover:text-white/90"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        <div className="hud-scroll flex-1 overflow-y-auto px-4 py-3">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-white/10 px-4 py-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
