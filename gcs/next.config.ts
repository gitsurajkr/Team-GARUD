import type { NextConfig } from "next";

/**
 * The renderer is a Next.js app compiled to a fully static bundle (`out/`)
 * that Electron loads over a custom `app://` protocol in production and from
 * the `next dev` server (http://localhost:3000) in development.
 *
 * A static export is required because the packaged app runs offline (mission
 * rule: no external network) and there is no Node server behind the UI — all
 * privileged work (MAVLink link, IPC) lives in the Electron main process.
 */
const nextConfig: NextConfig = {
  output: "export",
  // No image optimization server exists in a static export / offline build.
  images: { unoptimized: true },
  // Emit `/route/index.html` so file-based loading resolves cleanly.
  trailingSlash: true,
};

export default nextConfig;
