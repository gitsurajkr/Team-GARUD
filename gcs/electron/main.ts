import { app, BrowserWindow, protocol, session } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { registerIpc } from "./ipc/register";
import { registerTileProtocol, TILE_SCHEME_PRIVILEGES } from "./tiles";

const isDev = !app.isPackaged;
const DEV_URL = "http://localhost:3000";

/** Root of the Next.js static export (`out/`), relative to this compiled file. */
const OUT_DIR = path.join(__dirname, "..", "..", "out");

let mainWindow: BrowserWindow | null = null;
let disposeIpc: (() => void) | null = null;

// A custom privileged scheme lets the static export load with absolute asset
// paths (which file:// breaks) while keeping a locked-down origin.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  // Map tiles via the offline cache (see tiles.ts).
  TILE_SCHEME_PRIVILEGES,
]);

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#0a0a0a",
    title: "AirMouse — Ground Control Station",
    // Garud eagle (title bar + taskbar) instead of Electron's default atom.
    // public/ is copied into out/ by `next build`, so the same file serves both.
    icon: path.join(__dirname, "..", "..", isDev ? "public" : "out", "app-icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.webContents.on("did-fail-load", (_, errorCode) => {
      if (errorCode === -102 /* ERR_CONNECTION_REFUSED */ || errorCode === -105) {
        setTimeout(() => {
          mainWindow?.loadURL(DEV_URL);
        }, 1000);
      }
    });
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadURL("app://local/index.html");
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerAppProtocol(): void {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    // Strip the leading slash and default to index.html.
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (rel === "" || rel.endsWith("/")) rel += "index.html";

    const filePath = path.join(OUT_DIR, rel);
    // Guard against path traversal outside the export directory.
    if (!filePath.startsWith(OUT_DIR)) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const data = await fs.readFile(filePath);
      return new Response(new Uint8Array(data), {
        headers: { "content-type": mimeFor(filePath) },
      });
    } catch {
      // SPA-style fallback to the exported 404 page.
      try {
        const fallback = await fs.readFile(path.join(OUT_DIR, "404.html"));
        return new Response(new Uint8Array(fallback), {
          status: 404,
          headers: { "content-type": "text/html" },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }
  });
}

/**
 * Public map-tile hosts allowed through the offline hardening so the live
 * geographic map (GeoMapPane, centred on Galgotias University) can load.
 * NOTE: this is a deliberate exception to the "no external network" rule —
 * during a true offline mission these will still fail and the map stays blank.
 */
const TILE_HOSTS = [
  "mt0.google.com",
  "mt1.google.com",
  "mt2.google.com",
  "mt3.google.com",
  "server.arcgisonline.com",
  "services.arcgisonline.com",
  "tile.openstreetmap.org",
  "basemaps.cartocdn.com",
];

function isTileUrl(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return false;
  }
  return TILE_HOSTS.some((t) => host === t || host.endsWith("." + t));
}

/** True for loopback and RFC-1918 private hosts (the permitted local link). */
function isLocalUrl(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) // link-local
  );
}

function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}

app.whenReady().then(() => {
  if (!isDev) registerAppProtocol();
  registerTileProtocol();

  // Harden: allow only local-link traffic (dev server + private/loopback
  // addresses such as the companion-computer video feed) and block any public
  // internet request — the mission runs with no external network (section 7).
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      const allowDevServer = isDev && details.url.startsWith(DEV_URL);
      const allowDevTools =
        isDev &&
        (details.url.includes("chrome-devtools") ||
          details.url.includes("appspot.com"));
      callback({
        cancel: !(
          allowDevServer ||
          allowDevTools ||
          isLocalUrl(details.url) ||
          isTileUrl(details.url)
        ),
      });
    },
  );

  createWindow();
  disposeIpc = registerIpc(() => mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  disposeIpc?.();
  disposeIpc = null;
  if (process.platform !== "darwin") app.quit();
});
