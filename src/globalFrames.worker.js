// Downloads, decompresses, and packs one variable's whole-world frame buffer.
// One worker instance per variable (see globalFramesClient.js), so GWSa and
// TWSa load fully independently: neither waits on the other, and neither
// blocks the main thread's render loop.
//
// Protocol — the client posts {zarrUrl, varName, geo} exactly once, then this
// worker posts:
//   {type: "progress", fraction}                     repeatedly, 0..1
//   {type: "preview", frame, nLat, nLon}             throttled partial paints
//   {type: "done", buffer, nT, nLat, nLon, stats}    once, buffer transferred
//   {type: "error", message}                         once, terminal
// "done" and "error" are terminal; the client terminates the worker on either.
import {computeFrameStats, loadGlobalFrames, pickPreviewTimeStep} from "./globalData.js";
import {openZarrArray} from "./zarrStore.js";

// Partial paints are cheap (one frame is ~216 KB) but pointless faster than the
// eye can track, and each one costs a copy out of the frame buffer.
const PREVIEW_INTERVAL_MS = 500;

self.addEventListener("message", async (event) => {
  const {zarrUrl, varName, geo} = event.data;
  try {
    // confirmOpaqueErrors: this loader caches what it reads, so a CORS-hidden
    // throttling response must not be mistaken for a permanently missing chunk
    // (see zarrStore.js).
    const node = await openZarrArray(zarrUrl, varName, {confirmOpaqueErrors: true});

    let lastPreviewAt = 0;
    const data = await loadGlobalFrames({
      node,
      varName,
      zarrUrl,
      onProgress: (fraction, partial) => {
        self.postMessage({type: "progress", fraction});
        if (!partial || fraction >= 1) return;
        const now = performance.now();
        if (now - lastPreviewAt < PREVIEW_INTERVAL_MS) return;
        lastPreviewAt = now;
        const t = pickPreviewTimeStep(partial, geo);
        const frameSize = partial.nLat * partial.nLon;
        // A copy, not a subarray view: this worker keeps writing into `frames`
        // while the main thread paints, and the copy's buffer is transferred
        // (no structured-clone cost) since we never look at it again.
        const frame = partial.frames.slice(t * frameSize, (t + 1) * frameSize);
        self.postMessage({type: "preview", frame, nLat: partial.nLat, nLon: partial.nLon}, [frame.buffer]);
      },
    });

    // Full pass over every value; belongs here rather than on the main thread.
    const stats = computeFrameStats(data);

    // loadGlobalFrames has already awaited its IndexedDB write, so detaching
    // the buffer by transferring it is safe.
    self.postMessage(
      {
        type: "done",
        buffer: data.frames.buffer,
        nT: data.nT,
        nLat: data.nLat,
        nLon: data.nLon,
        fromCache: data.fromCache,
        stats,
      },
      [data.frames.buffer],
    );
  } catch (err) {
    self.postMessage({type: "error", message: err?.message ?? String(err)});
  }
});
