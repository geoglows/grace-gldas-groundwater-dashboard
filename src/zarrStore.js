import {open} from "zarrita";

// CloudFront/S3 answers 403 (not 404) for keys that do not exist because the
// origin access policy only grants GetObject, not ListBucket. Zarr never
// writes chunks that are entirely fill_value (e.g. all-ocean cells), so those
// responses mean "missing chunk" and must resolve to undefined exactly like a
// 404; zarrita then fills that part of the read window with the array fill
// value. zarrita's own FetchStore throws instead, which breaks any read whose
// window touches a fully-empty chunk.
//
// In browsers there is a second wrinkle: CloudFront only attaches CORS
// headers to 2xx responses, so an error response is CORS-blocked and fetch
// rejects with the same TypeError a dead network produces — the 403 status is
// never observable. On TypeError we probe the URL again with mode "no-cors":
// an opaque response proves the server answered, so the original failure was
// an error status hidden by CORS and the chunk is treated as missing; if the
// probe also fails the error is a real network problem and is rethrown for
// the caller to retry.
//
// A throttling response (S3 "503 Slow Down") is also CORS-hidden and would
// masquerade as a missing chunk. Callers that persist what they read (the
// global-view loader caches into IndexedDB) pass confirmOpaqueErrors: true so
// the first classification of each key is rethrown as retryable (marked
// err.opaqueError) and only a second, later look accepts the chunk as
// missing; transient throttling recovers in between.
export function createTolerantStore(url, {confirmOpaqueErrors = false} = {}) {
  const opaqueSeen = new Set();
  return {
    async get(key, options = {}) {
      const target = `${url}${key}`;
      let response;
      try {
        response = await fetch(target, options);
      } catch (err) {
        let reachable = false;
        try {
          await fetch(target, {mode: "no-cors", cache: "no-store"});
          reachable = true;
        } catch {
          // server genuinely unreachable
        }
        if (!reachable) throw err;
        if (confirmOpaqueErrors && !opaqueSeen.has(key)) {
          opaqueSeen.add(key);
          err.opaqueError = true;
          throw err;
        }
        return undefined;
      }
      if (response.status === 404 || response.status === 403) return undefined;
      if (!response.ok) throw new Error(`Unexpected response status ${response.status} fetching ${target}`);
      return new Uint8Array(await response.arrayBuffer());
    }
  };
}

export const openZarrArray = (zarrUrl, name, storeOptions) => open.v3(createTolerantStore(`${zarrUrl}/${name}`, storeOptions));
