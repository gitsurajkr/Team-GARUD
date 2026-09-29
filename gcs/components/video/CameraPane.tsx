"use client";

import { useEffect, useState } from "react";
import { useGcsStore } from "../../lib/store";
import { parseCameraUrl, thermalUrl, type LiveCamera } from "../../shared/videoConfig";
import { findThermalTwin, findVideoUrl } from "./probeFeed";

/**
 * Selected drone's camera feed: the MJPEG stream from its companion computer,
 * with live per-category detection counts polled alongside it.
 *
 * No camera URL is built in: the operator pastes each drone's URL right here,
 * and it is remembered per drone across restarts.
 */
export function CameraPane() {
  const sysid = useGcsStore((s) => s.selectedSysid);
  const expanded = useGcsStore((s) => s.cameraExpanded);
  const drone = useGcsStore((s) => (s.selectedSysid !== null ? s.drones[s.selectedSysid] : undefined));
  const typedUrls = useGcsStore((s) => (s.selectedSysid !== null ? s.cameraUrls[s.selectedSysid] : undefined));
  const [editing, setEditing] = useState(false);

  // After mount, not at store creation: the page is prerendered without
  // localStorage, and reading it earlier would mismatch that HTML.
  useEffect(() => useGcsStore.getState().hydrateCameraUrls(), []);

  if (sysid === null) return <NoSignal />;
  const typed = typedUrls ? parseCameraUrl(typedUrls.rgb, typedUrls.thermal) : null;
  const live = typed?.ok ? typed.cam : undefined;

  if (!live || editing) {
    return (
      <CameraUrlForm
        key={sysid}
        sysid={sysid}
        currentRgb={typedUrls?.rgb ?? ""}
        currentThermal={typedUrls?.thermal ?? ""}
        typed={!!typedUrls}
        onDone={() => setEditing(false)}
        cancellable={!!live}
      />
    );
  }

  return (
    <LiveView
      key={`${live.stream}|${live.thermal ?? ""}`}
      sysid={sysid}
      cam={live}
      expanded={expanded}
      lat={drone?.navigation.latitude ?? null}
      lon={drone?.navigation.longitude ?? null}
      onEdit={() => setEditing(true)}
    />
  );
}

function NoSignal() {
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-0.5 bg-black">
      <span className="text-[11px] font-semibold text-white/45">No Signal</span>
      <span className="text-[9px] text-white/25">select a drone to see its camera</span>
    </div>
  );
}

/** Paste a URL (and optionally a thermal one), press Connect — the feed plays. */
function CameraUrlForm({
  sysid, currentRgb, currentThermal, typed, cancellable, onDone,
}: {
  sysid: number;
  currentRgb: string;
  currentThermal: string;
  typed: boolean;
  cancellable: boolean;
  onDone: () => void;
}) {
  const setCameraUrl = useGcsStore((s) => s.setCameraUrl);
  const [rgb, setRgb] = useState(currentRgb);
  const [thermal, setThermal] = useState(currentThermal);
  const [error, setError] = useState<string | null>(null);
  // The address being tried right now, while Connect searches for the video.
  const [trying, setTrying] = useState<string | null>(null);

  const connect = async () => {
    if (trying) return;
    const parsed = parseCameraUrl(rgb, thermal);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    // What was typed is often the camera's web page, not the video itself —
    // find the real video (the address as typed first) and save that.
    const video = await findVideoUrl(parsed.cam.stream, setTrying);
    if (!video) {
      setTrying(null);
      setError("No video found at that address. Open it in a browser and copy the video's own address.");
      return;
    }
    let thermalVideo: string | undefined;
    if (parsed.cam.thermal) {
      thermalVideo = (await findVideoUrl(parsed.cam.thermal, setTrying)) ?? undefined;
      if (!thermalVideo) {
        setTrying(null);
        setError("RGB found, but no thermal video at the thermal address.");
        return;
      }
    } else if (video.includes("/stream")) {
      // Companion scripts put thermal at …/thermal — offer THM only if it plays.
      setTrying(video.replace("/stream", "/thermal"));
      thermalVideo = await findThermalTwin(video);
    }
    setTrying(null);
    setCameraUrl(sysid, { rgb: video, ...(thermalVideo ? { thermal: thermalVideo } : {}) });
    onDone();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void connect();
    else if (e.key === "Escape" && cancellable && !trying) onDone();
  };
  const inputCls =
    "w-full rounded border border-white/15 bg-white/5 px-2 py-1 font-mono text-[11px] text-white/90 outline-none placeholder:text-white/25 focus:border-sky-500/70";

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-black px-4">
      <span className="text-[11px] font-semibold text-white/60">Camera for SYS {sysid}</span>
      <label className="w-full">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-white/40">RGB</span>
        <input
          autoFocus
          value={rgb}
          onChange={(e) => { setRgb(e.target.value); setError(null); }}
          onKeyDown={onKeyDown}
          placeholder="http://192.168.137.75:5000/"
          spellCheck={false}
          className={inputCls}
        />
      </label>
      <label className="w-full">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-white/40">
          Thermal <span className="normal-case tracking-normal text-white/25">(optional)</span>
        </span>
        <input
          value={thermal}
          onChange={(e) => { setThermal(e.target.value); setError(null); }}
          onKeyDown={onKeyDown}
          placeholder="thermal camera address, if any"
          spellCheck={false}
          className={inputCls}
        />
      </label>
      {trying ? (
        <span className="w-full truncate text-center text-[10px] text-sky-300" title={trying}>
          Finding video… {trying.replace(/^https?:\/\//, "")}
        </span>
      ) : error ? (
        <span className="text-center text-[10px] text-amber-400">{error}</span>
      ) : (
        <span className="text-center text-[9px] text-white/30">
          MJPEG over HTTP · the camera&apos;s page address is enough
        </span>
      )}
      <div className="flex gap-1.5">
        {cancellable && (
          <button type="button" onClick={onDone} disabled={!!trying}
            className="rounded border border-white/15 bg-white/5 px-2.5 py-1 text-[10px] font-semibold text-white/70 hover:bg-white/15">
            Cancel
          </button>
        )}
        {typed && (
          <button type="button" onClick={() => { setCameraUrl(sysid, null); onDone(); }} disabled={!!trying}
            className="rounded border border-white/15 bg-white/5 px-2.5 py-1 text-[10px] font-semibold text-white/70 hover:bg-white/15"
            title="Forget this drone's camera URL">
            Remove
          </button>
        )}
        <button type="button" onClick={() => void connect()} disabled={!!trying}
          className="rounded border border-sky-500 bg-sky-600 px-3 py-1 text-[10px] font-semibold text-white hover:bg-sky-700 disabled:opacity-50">
          {trying ? "Finding…" : "Connect"}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------- LIVE ---------------------------------- */
function LiveView({ sysid, cam, expanded, lat, lon, onEdit }: { sysid: number; cam: LiveCamera; expanded: boolean; lat: number | null; lon: number | null; onEdit: () => void }) {
  const [epoch, setEpoch] = useState(0); // bump to reconnect the MJPEG
  const [errored, setErrored] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [fps, setFps] = useState(0);
  const [mode, setMode] = useState<"rgb" | "thermal">("rgb");

  // poll detections
  useEffect(() => {
    if (!cam.detections) return;
    let live = true;
    const tick = () => {
      fetch(cam.detections!, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => { if (live) { setCounts(d.counts ?? {}); setFps(d.fps ?? 0); setErrored(false); } })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => { live = false; clearInterval(id); };
  }, [cam.detections]);

  const thermal = thermalUrl(cam);
  const hasThermal = !!thermal;
  const src = mode === "thermal" && thermal ? thermal : cam.stream;
  const img = (
    <img
      key={`${src}#${epoch}`}
      src={src}
      alt="live camera"
      className="w-full h-full object-contain"
      onError={() => { setErrored(true); setTimeout(() => setEpoch((e) => e + 1), 3000); }}
      onLoad={() => setErrored(false)}
    />
  );

  const badge = (
    <div className="flex items-center gap-1 rounded bg-black/60 border border-white/10 px-1.5 py-0.5 backdrop-blur-sm">
      <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
      <span className="text-[9px] font-semibold text-white/80">
        SYS {sysid} · LIVE · {mode === "rgb" ? "RGB" : "THERMAL"}{fps ? ` · ${fps} FPS` : ""}
      </span>
    </div>
  );

  const editBtn = (
    <button
      type="button"
      onClick={onEdit}
      title="Change camera URL"
      aria-label="Change camera URL"
      className="rounded bg-black/60 border border-white/10 px-1.5 py-0.5 text-[10px] text-white/60 backdrop-blur-sm hover:text-white"
    >
      ⚙
    </button>
  );

  const rgbThmToggle = !hasThermal ? null : (
    <div className="flex gap-0.5 rounded bg-black/60 border border-white/10 p-0.5 backdrop-blur-sm">
      {(["rgb", "thermal"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setMode(m)}
          className={`rounded px-1.5 py-0.5 text-[9px] font-semibold tracking-wide ${
            mode === m ? "bg-white/20 text-white" : "text-white/40 hover:text-white/70"
          }`}
        >
          {m === "rgb" ? "RGB" : "THM"}
        </button>
      ))}
    </div>
  );

  const errorOverlay = errored ? (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/70">
      <span className="text-xs font-semibold text-white/60">Connecting to camera…</span>
      <span className="text-[10px] text-white/30 font-mono break-all px-4 text-center">{cam.stream}</span>
      <button type="button" onClick={onEdit}
        className="mt-1 rounded border border-white/15 bg-white/5 px-2.5 py-0.5 text-[10px] font-semibold text-white/70 hover:bg-white/15">
        Change URL
      </button>
    </div>
  ) : null;

  if (expanded) {
    return (
      <div className="flex h-full w-full bg-black">
        <div className="relative flex-1 min-w-0">
          {img}
          <div className="absolute top-2 left-2">{badge}</div>
          <div className="absolute top-2 right-2 flex gap-1">{rgbThmToggle}{editBtn}</div>
          {errorOverlay}
        </div>
        {/* <aside className="hud-scroll w-80 shrink-0 overflow-y-auto border-l border-white/10 bg-[#0a0e13] p-4">
          <div className="space-y-4">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-sky-300">Live Detection</div>
              <div className="text-lg font-bold text-white">{cam.label ?? `Camera (SYS ${sysid})`}</div>
            </div>
            <div>
              <Row label="Drone" value={`SYS ${sysid}`} />
              <Row label="Feed" value="Live · YOLO" tone="text-emerald-300" />
              <Row label="Latitude" value={lat === null ? "—" : lat.toFixed(6)} />
              <Row label="Longitude" value={lon === null ? "—" : lon.toFixed(6)} />
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-white/40 mb-1">Detections</div>
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 mb-2">
                <div className="text-[10px] uppercase tracking-wider text-red-300/80">Survivors</div>
                <div className="text-3xl font-bold text-red-400 tabular-nums">{counts.survivor ?? 0}</div>
              </div>
              {Object.entries(counts)
                .filter(([k]) => k !== "survivor")
                .map(([k, v]) => (
                  <Row key={k} label={k} value={String(v)} tone="text-amber-300" />
                ))}
              {Object.keys(counts).length === 0 && (
                <div className="text-[11px] text-white/30 py-1">waiting for detections…</div>
              )}
            </div>
          </div>
        </aside> */}
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black overflow-hidden">
      {img}
      <div className="absolute top-1.5 left-1.5">{badge}</div>
      <div className="absolute top-1.5 right-1.5 flex gap-1">{rgbThmToggle}{editBtn}</div>
      {errorOverlay}
      {/* <div className="absolute bottom-1.5 left-1.5 right-1.5 flex flex-wrap items-center gap-x-2 rounded bg-black/55 border border-white/10 px-1.5 py-0.5 backdrop-blur-sm text-[10px] font-mono">
        <span className="font-bold text-red-400">SURVIVORS {counts.survivor ?? 0}</span>
        {Object.entries(counts).filter(([k]) => k !== "survivor").slice(0, 3).map(([k, v]) => (
          <span key={k} className="text-amber-300">{k} {v}</span>
        ))}
      </div> */}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between py-1 border-b border-white/5">
      <span className="text-[10px] uppercase tracking-wider text-white/40">{label}</span>
      <span className={`font-mono text-xs font-semibold ${tone ?? "text-white/90"}`}>{value}</span>
    </div>
  );
}
