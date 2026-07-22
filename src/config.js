// Single source of truth for every URL the app requests.
//
// Two rules, and nothing in src/ may break them:
//   1. External services are absolute https:// URLs. They do not move when the
//      deployment moves, so they are hard-coded (overridable via env).
//   2. Everything this app ships is resolved through asset(), which prefixes
//      Vite's base path.
//
// A bare leading-slash path ("/aquifers.geojson") is always a bug: it resolves
// against the *origin* root, so it works in dev and at a root deployment and
// silently 404s — or, behind CloudFront, 503s — the moment the app is served
// from a sub-path like /portal/grace/.

// Vite substitutes this at build time with the resolved `base` from
// vite.config.js, always normalized with a trailing slash.
export const BASE_URL = import.meta.env.BASE_URL || "/";

// Join a ship-with-the-app path (anything in public/) onto the base path.
export const asset = (path) => `${BASE_URL}${String(path).replace(/^\/+/, "")}`;

const fromEnv = (value, fallback) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || fallback;
};

// The zarr store holding every mapped variable, its coordinates, and time axis.
export const ZARR_URL = fromEnv(
  import.meta.env.VITE_ZARR_URL,
  "https://d3hbj0z0f67zhd.cloudfront.net/ggg/grace-gldas-water-balance.zarr",
).replace(/\/+$/, "");

// Aquifer outlines. Served from public/ by default; point VITE_AQUIFERS_URL at
// an absolute https:// URL to serve the 2 MB file from a CDN instead.
export const AQUIFERS_URL = fromEnv(import.meta.env.VITE_AQUIFERS_URL, asset("aquifers.geojson"));

// Where the "back to portal" logo links. Defaults to the app's own base path
// (i.e. reload this app) when the portal location is not configured.
export const PORTAL_URL = fromEnv(import.meta.env.VITE_PORTAL_URL, BASE_URL);
