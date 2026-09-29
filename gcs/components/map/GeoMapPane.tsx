"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { useGcsStore } from "../../lib/store";
import { droneColor } from "../../lib/droneColors";
import { cmd } from "../../lib/commands";
import { haversineM } from "../../lib/geo";
import type { TileBounds } from "../../shared/types";

/**
 * Full-screen live map. Drones are plotted at their REAL GPS position (from
 * telemetry) and the map recentres on the first drone that reports a fix.
 * Left-click draws waypoints (Draw mode) or repositions (Reposition mode);
 * right-click always repositions.
 */

/** Default map view — Galgotias University, Greater Noida, Uttar Pradesh. */
const DEFAULT_VIEW = { lat: 28.3672, lon: 77.541, zoom: 16 };

/** Fence colour — the theme's `--danger` red, so the boundary reads as a hard
 *  limit rather than a caution. */
const FENCE_COLOR = "#ef4444";

/** ArduCopter FENCE_ACTION values, for the fence tooltip. */
const FENCE_ACTION: Record<number, string> = {
  0: "report only",
  1: "RTL (or Land)",
  2: "always Land",
  3: "SmartRTL → RTL → Land",
  4: "Brake (or Land)",
  5: "SmartRTL → Land",
};

/**
 * The live Leaflet instance, so HUD chrome rendered outside this pane (the zoom
 * buttons) can drive it. Only ever one map is mounted at a time — the main view
 * and the corner view are the two arms of a ternary, never both.
 */
let activeMap: any = null;

export function mapZoomIn(): void {
  activeMap?.zoomIn();
}

export function mapZoomOut(): void {
  activeMap?.zoomOut();
}

/** The area currently on screen, for "Save area offline". Null before init. */
export function mapBounds(): TileBounds | null {
  const b = activeMap?.getBounds();
  if (!b) return null;
  return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
}

/**
 * Reposition: send the drone to a clicked point at its current altitude and
 * mark the spot, so the operator can see where it was sent. The backend stops
 * it, turns it to face the spot, then flies — and acks with the FC's verdict
 * (including "only works in GUIDED"), which lands in the status console.
 */
function flyTo(sysid: number, lat: number, lon: number): void {
  const st = useGcsStore.getState();
  if (!cmd.reposition(sysid, lat, lon, flyToAlt(sysid))) return; // link down — nothing sent
  st.setGuidedTarget(sysid, { lat, lon, alt: flyToAlt(sysid), at: Date.now() });
}

/** Reposition keeps the drone's current height (10 m if it is on the ground). */
function flyToAlt(sysid: number): number {
  const cur = useGcsStore.getState().drones[sysid]?.navigation.altitude ?? 10;
  return cur > 1 ? cur : 10;
}

/**
 * A map click only PROPOSES a fly-to: a stray click must not send a real
 * aircraft anywhere. The spot waits in the store until Fly here / Enter.
 */
function proposeFlyTo(sysid: number, lat: number, lon: number): void {
  useGcsStore.getState().setPendingFlyTo({ sysid, lat, lon });
}

function confirmFlyTo(): void {
  const st = useGcsStore.getState();
  const p = st.pendingFlyTo;
  if (!p) return;
  st.setPendingFlyTo(null);
  flyTo(p.sysid, p.lat, p.lon);
}

function cancelFlyTo(): void {
  useGcsStore.getState().setPendingFlyTo(null);
}

/** Fly-to target: a ring with a cross, in the drone's colour. */
function targetMarkerHtml(color: string): string {
  return `<div style="width:26px;height:26px;filter:drop-shadow(0 0 2px rgba(0,0,0,.95));">
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="${color}" stroke-width="2.4">
      <circle cx="13" cy="13" r="9"/>
      <line x1="13" y1="1" x2="13" y2="8"/><line x1="13" y1="18" x2="13" y2="25"/>
      <line x1="1" y1="13" x2="8" y2="13"/><line x1="18" y1="13" x2="25" y2="13"/>
      <circle cx="13" cy="13" r="2" fill="${color}" stroke="none"/>
    </svg>
  </div>`;
}

/** Quadcopter marker (top-view, nose pointing at the drone's heading). */
function droneMarkerHtml(color: string, heading: number, selected: boolean, dim: boolean): string {
  const size = selected ? 42 : 34;
  const ring = selected
    ? `<circle cx="20" cy="20" r="18.5" fill="none" stroke="#ffffff" stroke-width="1.5" opacity="0.9"/>`
    : "";
  return `<div style="width:${size}px;height:${size}px;transform:rotate(${heading}deg);opacity:${dim ? 0.4 : 1};filter:drop-shadow(0 0 2px rgba(0,0,0,.95));">
    <svg width="${size}" height="${size}" viewBox="0 0 40 40">
      ${ring}
      <path d="M20 3 l4 6 l-8 0 z" fill="${color}"/>
      <g stroke="${color}" stroke-width="2.6" stroke-linecap="round">
        <line x1="20" y1="20" x2="9" y2="9"/><line x1="20" y1="20" x2="31" y2="9"/>
        <line x1="20" y1="20" x2="9" y2="31"/><line x1="20" y1="20" x2="31" y2="31"/>
      </g>
      <g stroke="${color}" stroke-width="2" fill="#0b0f14">
        <circle cx="9" cy="9" r="5"/><circle cx="31" cy="9" r="5"/>
        <circle cx="9" cy="31" r="5"/><circle cx="31" cy="31" r="5"/>
      </g>
      <rect x="15" y="15" width="10" height="10" rx="3" fill="${color}"/>
    </svg>
  </div>`;
}

export function GeoMapPane() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const droneLayerRef = useRef<any>(null);
  const wpLayerRef = useRef<any>(null);
  const targetLayerRef = useRef<any>(null);
  const pendingLayerRef = useRef<any>(null);
  const pendingLineRef = useRef<any>(null);
  // The confirm popup's live parts, updated in place on every telemetry tick —
  // rebuilding the popup at 10 Hz would swap the button out from under a click.
  const pendingInfoRef = useRef<HTMLDivElement | null>(null);
  const pendingFlyBtnRef = useRef<HTMLButtonElement | null>(null);
  const fenceLayerRef = useRef<any>(null);
  const leafletRef = useRef<any>(null);
  const hasCenteredRef = useRef(false);

  const drones = useGcsStore((s) => s.drones);
  const fence = useGcsStore((s) => s.fence);
  const selectedSysid = useGcsStore((s) => s.selectedSysid);
  const draftWaypoints = useGcsStore((s) => s.draftWaypoints);
  const waypointMode = useGcsStore((s) => s.waypointMode);
  const repositionMode = useGcsStore((s) => s.repositionMode);
  const guidedTarget = useGcsStore((s) => s.guidedTarget);
  const pendingFlyTo = useGcsStore((s) => s.pendingFlyTo);

  // Init map + gestures.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !wrapRef.current || mapRef.current) return;
      leafletRef.current = L;

      const map = L.map(wrapRef.current, { zoomControl: false, attributionControl: false })
        .setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], DEFAULT_VIEW.zoom);
      // Zoom buttons are not a Leaflet control: they live in the HUD's
      // bottom-right stack (see ZoomControl) so they sit directly above the
      // status console and follow it when it collapses.
      activeMap = map;

      // Google satellite tiles, the same source Mission Planner uses — much
      // newer imagery here than Esri World Imagery (which still showed campus
      // buildings under construction). No API key: this is Google's plain tile
      // endpoint, spread over mt0-mt3. In Electron they go through the
      // on-disk cache (electron/tiles.ts) so the map still shows offline.
      // maxNativeZoom = highest zoom Google has real imagery for here; beyond
      // it, Leaflet upscales the last real tile.
      L.tileLayer(
        window.gcs?.tileCache
          ? "gcstile://google/{z}/{x}/{y}"
          : "https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
        { subdomains: ["0", "1", "2", "3"], maxZoom: 21, maxNativeZoom: 20 },
      ).addTo(map);

      // Fence first so drones and waypoints draw on top of it.
      fenceLayerRef.current = L.layerGroup().addTo(map);
      targetLayerRef.current = L.layerGroup().addTo(map);
      droneLayerRef.current = L.layerGroup().addTo(map);
      wpLayerRef.current = L.layerGroup().addTo(map);
      pendingLayerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;

      map.on("click", (e: any) => {
        const st = useGcsStore.getState();
        if (st.selectedSysid === null) return;
        if (st.repositionMode) {
          proposeFlyTo(st.selectedSysid, e.latlng.lat, e.latlng.lng);
        } else if (st.waypointMode) {
          // Altitude comes from the dock's field, not a constant — otherwise
          // that control would silently do nothing. Per-waypoint edits happen
          // in the mission panel afterwards.
          st.addDraftWaypoint(st.selectedSysid, {
            lat: e.latlng.lat, lon: e.latlng.lng, alt: st.draftAlt, hold: 0,
          });
        }
      });
      map.on("contextmenu", (e: any) => {
        const st = useGcsStore.getState();
        if (st.selectedSysid === null) return;
        proposeFlyTo(st.selectedSysid, e.latlng.lat, e.latlng.lng);
      });

      setTimeout(() => map.invalidateSize(), 200);
    })();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        // Guard against nulling a newer map if mount/unmount ever interleave.
        if (activeMap === mapRef.current) activeMap = null;
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (wrapRef.current) wrapRef.current.style.cursor = waypointMode || repositionMode ? "crosshair" : "";
  }, [waypointMode, repositionMode]);

  // Geofence for the selected drone — a circle on the FC's OWN home position
  // (HOME_POSITION), which is what ArduPilot actually centres the fence on.
  // Drawn only when the fence is enabled and we know where home is.
  useEffect(() => {
    const L = leafletRef.current;
    const group = fenceLayerRef.current;
    if (!L || !group) return;
    group.clearLayers();
    if (selectedSysid === null) return;

    const f = fence[selectedSysid];
    const home = drones[selectedSysid]?.home;
    if (!f?.enabled || !f.radius || !home?.latitude || !home?.longitude) return;

    const centre: [number, number] = [home.latitude, home.longitude];
    // The breach fires FENCE_MARGIN inside the boundary, so show both: the hard
    // limit, and the ring where the aircraft will actually turn back.
    L.circle(centre, {
      radius: f.radius,
      color: FENCE_COLOR,
      weight: 2,
      opacity: 0.9,
      fillColor: FENCE_COLOR,
      fillOpacity: 0.06,
      dashArray: "6 6",
      interactive: false,
    })
      .addTo(group)
      .bindTooltip(
        `Geofence — r=${f.radius} m, alt≤${f.alt_max ?? "?"} m<br>breach → ${FENCE_ACTION[f.action ?? -1] ?? "?"}`,
        { direction: "top", sticky: true },
      );

    if (f.margin && f.margin > 0 && f.margin < f.radius) {
      L.circle(centre, {
        radius: f.radius - f.margin,
        color: FENCE_COLOR,
        weight: 1,
        opacity: 0.35,
        fill: false,
        dashArray: "2 6",
        interactive: false,
      }).addTo(group);
    }

    // Home marker — the fence centre and the RTL target are the same point.
    L.marker(centre, {
      icon: L.divIcon({
        className: "",
        html:
          `<div style="width:18px;height:18px;filter:drop-shadow(0 0 2px rgba(0,0,0,.95));">` +
          `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${FENCE_COLOR}" stroke-width="2.4">` +
          `<path d="M3 11l9-8 9 8"/><path d="M6 10v10h12V10"/></svg></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
      interactive: false,
    })
      .addTo(group)
      .bindTooltip("Home · fence centre · RTL target", { direction: "top" });
  }, [fence, drones, selectedSysid]);

  // Drone markers at their real GPS; recentre once on the first fix.
  useEffect(() => {
    const L = leafletRef.current;
    const group = droneLayerRef.current;
    if (!L || !group) return;
    group.clearLayers();

    const list = Object.values(drones).sort((a, b) => a.sysid - b.sysid);

    // A drone only has a real position once it has a GPS fix — 0,0 (or null)
    // means "no fix" (e.g. a real drone indoors) and must NOT be plotted or
    // recentred on, or the map jumps to the ocean ("map data not available").
    const hasFix = (la: number | null, lo: number | null) =>
      la !== null && lo !== null && !(Math.abs(la) < 1e-4 && Math.abs(lo) < 1e-4);

    list.forEach((d) => {
      const lat = d.navigation.latitude;
      const lon = d.navigation.longitude;
      if (!hasFix(lat, lon)) return;
      const selected = d.sysid === selectedSysid;
      const color = droneColor(d.sysid);
      const size = selected ? 42 : 34;
      const html = droneMarkerHtml(color, d.navigation.heading ?? 0, selected, !d.connected);
      L.marker([lat, lon], {
        icon: L.divIcon({ className: "", html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
        zIndexOffset: selected ? 1000 : 0,
      })
        .addTo(group)
        .bindTooltip(`SYS ${d.sysid} · ${d.mode}${d.armed ? " · ARM" : ""}`, {
          permanent: selected,
          direction: "top",
          offset: [0, -size / 2],
        });
    });

    if (!hasCenteredRef.current && mapRef.current) {
      const withFix = list.find((d) => hasFix(d.navigation.latitude, d.navigation.longitude));
      if (withFix) {
        mapRef.current.setView([withFix.navigation.latitude!, withFix.navigation.longitude!], 17);
        hasCenteredRef.current = true;
      }
    }
  }, [drones, selectedSysid]);

  // Unconfirmed fly-to: a dimmed crosshair and a Fly here / Cancel popup.
  // Built once per proposal; the live parts are updated by the next effect.
  useEffect(() => {
    const L = leafletRef.current;
    const group = pendingLayerRef.current;
    if (!L || !group) return;
    group.clearLayers();
    pendingLineRef.current = null;
    pendingInfoRef.current = null;
    pendingFlyBtnRef.current = null;
    const p = pendingFlyTo;
    if (!p) return;

    const color = droneColor(p.sysid);
    L.marker([p.lat, p.lon], {
      icon: L.divIcon({
        className: "",
        html: `<div style="opacity:.6">${targetMarkerHtml(color)}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
      interactive: false,
    }).addTo(group);
    pendingLineRef.current = L.polyline([], {
      color, weight: 2, dashArray: "2 6", opacity: 0.6, interactive: false,
    }).addTo(group);

    const el = document.createElement("div");
    el.innerHTML =
      `<div class="gcs-confirm-title" style="color:${color}">Fly SYS ${p.sysid} here?</div>` +
      `<div class="gcs-confirm-info"></div>` +
      `<div class="gcs-confirm-btns">` +
      `<button type="button" data-act="cancel">Cancel <kbd>Esc</kbd></button>` +
      `<button type="button" data-act="fly" class="gcs-confirm-fly">Fly here <kbd>Enter</kbd></button>` +
      `</div>`;
    el.querySelector('[data-act="cancel"]')!.addEventListener("click", cancelFlyTo);
    const fly = el.querySelector<HTMLButtonElement>('[data-act="fly"]')!;
    fly.addEventListener("click", confirmFlyTo);
    pendingInfoRef.current = el.querySelector<HTMLDivElement>(".gcs-confirm-info");
    pendingFlyBtnRef.current = fly;

    L.popup({
      className: "gcs-confirm",
      closeButton: false,
      autoClose: false,
      closeOnClick: false,
      autoPan: false,
      offset: [0, -12],
    })
      .setLatLng([p.lat, p.lon])
      .setContent(el)
      .addTo(group);

    const onKey = (e: KeyboardEvent) => {
      // Enter in a dock field (altitude, speed…) is typing, not a confirm.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") cancelFlyTo();
      else if (e.key === "Enter" && !pendingFlyBtnRef.current?.disabled) confirmFlyTo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingFlyTo]);

  // Keep the pending popup honest as the drone moves: distance, height, and
  // whether it can actually take a reposition right now.
  useEffect(() => {
    const p = pendingFlyTo;
    const info = pendingInfoRef.current;
    if (!p || !info) return;
    const d = drones[p.sysid];
    const lat = d?.navigation.latitude ?? null;
    const lon = d?.navigation.longitude ?? null;
    const fix = lat !== null && lon !== null && !(Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4);
    pendingLineRef.current?.setLatLngs(fix ? [[lat, lon], [p.lat, p.lon]] : []);

    const parts = [
      fix ? `${Math.round(haversineM(lat!, lon!, p.lat, p.lon))} m away` : "no GPS fix",
      `alt ${Math.round(flyToAlt(p.sysid))} m`,
    ];
    // ArduCopter only takes a reposition in GUIDED — say so here, before the
    // operator commits, rather than as a refusal afterwards.
    const guided = d?.mode === "GUIDED";
    info.innerHTML =
      parts.join(" · ") +
      (d && !guided
        ? `<div class="gcs-confirm-warn">Drone is in ${d.mode} — switch to GUIDED first</div>`
        : "");
    if (pendingFlyBtnRef.current) pendingFlyBtnRef.current.disabled = !!d && !guided;
  }, [pendingFlyTo, drones]);

  // Fly-to targets from Reposition: a crosshair where each drone was sent, with
  // a dashed line from the drone to it, and the distance still to go.
  useEffect(() => {
    const L = leafletRef.current;
    const group = targetLayerRef.current;
    if (!L || !group) return;
    group.clearLayers();

    for (const [k, t] of Object.entries(guidedTarget)) {
      const sysid = Number(k);
      const color = droneColor(sysid);
      const d = drones[sysid];
      const lat = d?.navigation.latitude ?? null;
      const lon = d?.navigation.longitude ?? null;
      const fix = lat !== null && lon !== null && !(Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4);
      if (fix) {
        L.polyline([[lat, lon], [t.lat, t.lon]], {
          color, weight: 2, dashArray: "4 6", opacity: 0.85, interactive: false,
        }).addTo(group);
      }
      const togo = fix ? ` · ${Math.round(haversineM(lat!, lon!, t.lat, t.lon))} m to go` : "";
      L.marker([t.lat, t.lon], {
        icon: L.divIcon({ className: "", html: targetMarkerHtml(color), iconSize: [26, 26], iconAnchor: [13, 13] }),
        // Clicks go through to the map, so the operator can pick a new spot
        // right on top of the old one.
        interactive: false,
      })
        .addTo(group)
        .bindTooltip(`SYS ${sysid} fly-to · ${Math.round(t.alt)} m${togo}`, {
          permanent: sysid === selectedSysid,
          direction: "top",
          offset: [0, -13],
        });
    }
  }, [guidedTarget, drones, selectedSysid]);

  // Mission waypoints for EVERY drone, so the operator planning drone 2 can see
  // where drone 1 is already going. Each path is in its drone's colour; the
  // selected one is drawn last (on top) at full strength, the rest dimmed and
  // tagged "SYS n" at their first waypoint.
  useEffect(() => {
    const L = leafletRef.current;
    const group = wpLayerRef.current;
    if (!L || !group) return;
    group.clearLayers();

    const sysids = Object.keys(draftWaypoints)
      .map(Number)
      .filter((s) => (draftWaypoints[s]?.length ?? 0) > 0)
      // selected last, so its path and numbers sit above everyone else's
      .sort((a, b) => (a === selectedSysid ? 1 : b === selectedSysid ? -1 : a - b));

    for (const sysid of sysids) {
      const wps = draftWaypoints[sysid];
      const color = droneColor(sysid);
      const selected = sysid === selectedSysid;
      const size = selected ? 20 : 16;
      const path: [number, number][] = [];
      wps.forEach((w, i) => {
        path.push([w.lat, w.lon]);
        // Owner tag on the first point only — enough to tell paths apart
        // without cluttering every waypoint.
        const tag = !selected && i === 0
          ? `<div style="position:absolute;left:${size + 2}px;top:50%;transform:translateY(-50%);white-space:nowrap;background:rgba(0,0,0,.75);color:${color};font-size:10px;font-weight:700;padding:1px 4px;border-radius:3px;">SYS ${sysid}</div>`
          : "";
        L.marker([w.lat, w.lon], {
          icon: L.divIcon({
            className: "",
            html:
              `<div style="position:relative;opacity:${selected ? 1 : 0.6};">` +
              `<div style="background:${color};color:#000;font-size:${selected ? 11 : 9}px;font-weight:700;width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:${selected ? 2 : 1.5}px solid #fff;">${i + 1}</div>` +
              tag +
              `</div>`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
          }),
          // Other drones' points must not swallow the click that draws the
          // selected drone's next waypoint on top of them.
          interactive: selected,
          zIndexOffset: selected ? 500 : 0,
        }).addTo(group);
      });
      L.polyline(path, {
        color,
        weight: selected ? 2.5 : 1.5,
        dashArray: "6 6",
        opacity: selected ? 0.9 : 0.45,
        interactive: false,
      }).addTo(group);
    }
  }, [draftWaypoints, selectedSysid]);

  return <div ref={wrapRef} className="absolute inset-0 w-full h-full z-0 bg-black" />;
}
