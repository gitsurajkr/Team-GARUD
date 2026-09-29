"use client";

import { useState } from "react";
import { cmd } from "../../lib/commands";
import { Modal } from "./Modal";
import { PreflightTab } from "./PreflightPanel";
import { FailsafeTab } from "./FailsafePanel";

type Tab = "checks" | "failsafe";

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "checks", label: "Preflight", hint: "fit to fly now?" },
  { id: "failsafe", label: "Failsafe", hint: "what happens when it goes wrong?" },
];

/**
 * One dialog, two tabs — so the dock needs a single button and the kill switch
 * gets the freed slot.
 *
 * They stay separate tabs rather than one merged list on purpose: "is this
 * aircraft fit to fly right now" and "what should it do when something breaks"
 * are different questions, answered by different data (live prearm state vs
 * stored parameters), and blurring them is how a green preflight ends up
 * implying failsafes are configured when they are not.
 */
export function ChecksPanel({ sysid, onClose }: { sysid: number; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("checks");

  return (
    <Modal
      title={`Checks — SYS ${sysid}`}
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold text-white/70 hover:bg-white/10"
        >
          Close
        </button>
      }
    >
      <div className="mb-3 flex gap-1 rounded-lg border border-white/10 bg-black/40 p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id);
              // Each tab is filled by a request fired on entry, so switching to
              // it re-reads rather than showing whatever was cached last time.
              if (t.id === "checks") cmd.preflight(sysid);
              else cmd.getFailsafe(sysid);
            }}
            className={`flex-1 rounded px-3 py-1.5 text-left transition-colors ${
              tab === t.id ? "bg-white/12" : "hover:bg-white/5"
            }`}
          >
            <span
              className={`block text-[11px] font-bold ${
                tab === t.id ? "text-white/90" : "text-white/50"
              }`}
            >
              {t.label}
            </span>
            <span className="block text-[9px] leading-tight text-white/30">{t.hint}</span>
          </button>
        ))}
      </div>

      {tab === "checks" ? <PreflightTab sysid={sysid} /> : <FailsafeTab sysid={sysid} />}
    </Modal>
  );
}
