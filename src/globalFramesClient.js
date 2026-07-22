import {ZARR_URL} from "./config.js";

// A load that never resolves and never rejects is the worst outcome: the
// progress bar sits at whatever it last showed and the app looks dead. The
// worker posts progress on every chunk, so a long silence means something is
// genuinely wedged (a stalled socket that never times out, a worker that failed
// to start). Reject so callers can show the retry message.
const STALL_TIMEOUT_MS = 90_000;

/**
 * Load one variable's whole-world frame buffer in a dedicated Web Worker.
 *
 * Resolves to {frames, nT, nLat, nLon, fromCache, stats}. The returned promise
 * carries a .terminate() that kills the worker for abandoned loads.
 */
export function loadGlobalVariable({varName, geo, onProgress, onPreview, zarrUrl = ZARR_URL}) {
  // `new URL(..., import.meta.url)` is the only form Vite can statically detect
  // and rewrite, so the worker is emitted as a hashed chunk under the
  // configured base path. A literal "/src/globalFrames.worker.js" string would
  // 404 in production and under every non-root base.
  const worker = new Worker(new URL("./globalFrames.worker.js", import.meta.url), {
    type: "module",
    name: `global-frames-${varName}`,
  });

  let settled = false;
  let stallTimer = null;

  const finish = () => {
    settled = true;
    clearTimeout(stallTimer);
    worker.terminate();
  };

  const promise = new Promise((resolve, reject) => {
    const fail = (message) => {
      if (settled) return;
      finish();
      reject(new Error(message));
    };

    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => fail(`Loading ${varName} stalled with no progress for ${STALL_TIMEOUT_MS / 1000}s`),
        STALL_TIMEOUT_MS,
      );
    };

    worker.addEventListener("message", ({data: msg}) => {
      if (settled) return;
      armStallTimer();
      if (msg.type === "progress") {
        onProgress?.(msg.fraction);
        return;
      }
      if (msg.type === "preview") {
        onPreview?.(msg);
        return;
      }
      if (msg.type === "done") {
        finish();
        resolve({
          frames: new Float32Array(msg.buffer),
          nT: msg.nT,
          nLat: msg.nLat,
          nLon: msg.nLon,
          fromCache: msg.fromCache,
          stats: msg.stats,
        });
        return;
      }
      fail(msg.message || `Failed to load ${varName}`);
    });

    // Fires when the worker module itself fails to load or parse — without this
    // the promise would hang forever on a bad deploy.
    worker.addEventListener("error", (event) => {
      fail(event.message || `The ${varName} loader worker failed to start`);
    });
    worker.addEventListener("messageerror", () => {
      fail(`The ${varName} loader sent a message that could not be deserialized`);
    });

    armStallTimer();
    worker.postMessage({zarrUrl, varName, geo});
  });

  promise.terminate = () => {
    if (!settled) finish();
  };
  return promise;
}
