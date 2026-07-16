import {get} from "zarrita";

import {idbGet, idbPut} from "./db.js";

// The zarr stores are chunked [fullTime, y, x] so any global read must touch
// every spatial chunk. Chunks are fetched individually through a small worker
// pool so we can report progress, paint the map as regions arrive, and retry
// transient failures. Values are packed into one time-major Float32Array
// (frame t is the contiguous slice [t*nLat*nLon, (t+1)*nLat*nLon)) which is
// what the per-frame colorizer wants, then cached in IndexedDB so repeat
// visits skip the network entirely.
const FETCH_POOL_SIZE = 6;
const FETCH_RETRIES = 6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function loadGlobalFrames({node, varName, zarrUrl, onProgress}) {
  const [nT, nLat, nLon] = node.shape;
  // GWSa/TWSa are int16 with a sentinel fill for missing months; convert it to
  // NaN as chunks are unpacked so the Float32 frame buffer carries real gaps,
  // not the raw integer sentinel. (The _unc/coord arrays are float, NaN-filled.)
  const fill = node.attrs?._FillValue ?? -32768;
  // "nan" marks the buffer as fill-masked; bumping it invalidates any pre-mask
  // cache that still has the raw int16 sentinel baked in.
  const cacheKey = `global|${zarrUrl}|${varName}|f32nan|${nT}x${nLat}x${nLon}`;

  try {
    const cached = await idbGet(cacheKey);
    if (cached?.buffer) {
      onProgress?.(1);
      return {frames: new Float32Array(cached.buffer), nT, nLat, nLon, fromCache: true};
    }
  } catch (err) {
    console.warn("Global frame cache unavailable, fetching from network", err);
  }

  // Missing (all-ocean) chunks are never written, so start from all-NaN
  const frames = new Float32Array(nT * nLat * nLon).fill(NaN);
  const frameSize = nLat * nLon;

  const [, chunkY, chunkX] = node.chunks;
  const tasks = [];
  for (let y0 = 0; y0 < nLat; y0 += chunkY) {
    for (let x0 = 0; x0 < nLon; x0 += chunkX) {
      tasks.push([y0, Math.min(y0 + chunkY, nLat), x0, Math.min(x0 + chunkX, nLon)]);
    }
  }

  const totalTasks = tasks.length;
  let nextTask = 0;
  let done = 0;
  let dataChunks = 0;
  // S3 answers "503 Slow Down" if the request burst gets too hot, and one
  // request's retry doesn't help while the other workers keep up the pressure.
  // Any failure pauses the whole pool (exponential, jittered) and requeues the
  // chunk; a chunk only fails the load after several such rounds. The one
  // exception is a first-look opaque CORS error (see zarrStore.js): the chunk
  // is probably just missing, so it goes back in the queue for its second,
  // confirming look without pausing anyone.
  let pausedUntil = 0;
  // set when any chunk exhausts its retries: the other workers stop pulling
  // tasks and stop reporting progress so the caller's failure UI stays put
  let failed = false;
  // handed to onProgress so callers can paint the partially-filled world
  const partial = {frames, nT, nLat, nLon};
  const worker = async () => {
    while (!failed && nextTask < tasks.length) {
      const cooldown = pausedUntil - Date.now();
      if (cooldown > 0) {
        await sleep(cooldown);
        continue;
      }
      const task = tasks[nextTask++];
      // an opaque-error requeue must not retry immediately (a transient
      // throttle would just fail again and be misread as a missing chunk)
      const notReady = (task.notBefore ?? 0) - Date.now();
      if (notReady > 0) {
        tasks.push(task);
        await sleep(Math.min(notReady, 250));
        continue;
      }
      const [y0, y1, x0, x1] = task;
      let window;
      try {
        window = await get(node, [null, {start: y0, stop: y1}, {start: x0, stop: x1}]);
      } catch (err) {
        if (err?.opaqueError) {
          task.notBefore = Date.now() + 1500;
          tasks.push(task);
          continue;
        }
        task.attempts = (task.attempts ?? 0) + 1;
        if (task.attempts >= FETCH_RETRIES) {
          failed = true;
          throw err;
        }
        pausedUntil = Math.max(pausedUntil, Date.now() + 400 * 2 ** task.attempts + Math.random() * 300);
        tasks.push(task);
        continue;
      }
      const {data, shape, stride} = window;
      const [wT, wH, wW] = shape;
      const [sT, sY, sX] = stride;
      let chunkHasData = false;
      for (let t = 0; t < wT; t++) {
        const tOffset = t * sT;
        const outT = t * frameSize;
        for (let iy = 0; iy < wH; iy++) {
          const srcRow = tOffset + iy * sY;
          const outRow = outT + (y0 + iy) * nLon + x0;
          for (let ix = 0; ix < wW; ix++) {
            const raw = data[srcRow + ix * sX];
            const v = raw === fill ? NaN : raw; // int16 sentinel -> NaN gap
            if (v === v) chunkHasData = true;
            frames[outRow + ix] = v;
          }
        }
      }
      if (chunkHasData) dataChunks++;
      if (failed) continue;
      done++;
      onProgress?.(done / totalTasks, partial);
    }
  };
  await Promise.all(Array.from({length: FETCH_POOL_SIZE}, worker));
  // Land covers a bit under half the chunk grid; a clearly lower ratio in
  // this log means chunks were misclassified as missing (e.g. sustained
  // throttling hiding real chunks behind CORS errors) and the load should be
  // retried after a reset.
  console.info(`Global ${varName} load complete: ${dataChunks}/${totalTasks} chunks contained data`);

  if (dataChunks >= totalTasks * 0.2) {
    try {
      await idbPut({key: cacheKey, buffer: frames.buffer, shape: [nT, nLat, nLon], fetchedAt: Date.now()});
    } catch (err) {
      console.warn("Could not cache global frames in IndexedDB", err);
    }
  } else {
    // implausibly empty world: likely transient fetch degradation, so show it
    // this session but don't make it permanent
    console.warn("Not caching global frames: too few chunks contained data");
  }

  return {frames, nT, nLat, nLon, fromCache: false};
}

// One pass over the data: which time steps have any data at all (GRACE has
// missing months, a pre-launch GLDAS-only period, and the GRACE/GRACE-FO gap)
// and a robust color-scale bound. The |value| distribution has an enormous
// tail (p98 is ~130 cm and the max ~1500 cm from ice-sheet-margin cells while
// the median is ~5 cm), so fit the ramp to the 95th percentile and let the
// extremes saturate.
export function computeFrameStats({frames, nT, nLat, nLon}) {
  const frameSize = nLat * nLon;
  const validTimeIndices = [];
  const samples = [];
  for (let t = 0; t < nT; t++) {
    const base = t * frameSize;
    let hasData = false;
    for (let i = 0; i < frameSize; i++) {
      const v = frames[base + i];
      if (v === v) {
        hasData = true;
        if ((i & 7) === 0) samples.push(Math.abs(v));
      }
    }
    if (hasData) validTimeIndices.push(t);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples.length ? samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] : 0;
  return {validTimeIndices, suggestedMax: Math.ceil(p95) || 30};
}
