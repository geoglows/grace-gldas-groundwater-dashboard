// ---- IndexedDB minimal helpers ----
import {FetchStore, get, open} from "zarrita";

const DB_NAME = "gldas-zarr-cache";
// Bump when the cached grid changes (e.g. 0.25deg -> 0.5deg GRACE) so stale
// lat/lon coords are cleared and refetched to match the current zarr.
const DB_VERSION = 2;
const STORE_NAME = "arrays";

function openCacheDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      // Drop and recreate the store on any version bump to discard stale coords.
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      db.createObjectStore(STORE_NAME, {keyPath: "key"});
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet(key) {
  const db = await openCacheDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function idbPut(record) {
  const db = await openCacheDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(record);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

function packTypedArray(key, zarrUrl, name, zarrResult, typedArray) {
  return {
    key,
    zarrUrl,
    name,
    type: typedArray.constructor.name,  // "Float64Array", etc.
    length: typedArray.length,
    shape: zarrResult.shape ?? null,
    buffer: typedArray.buffer,          // ArrayBuffer (IDB-friendly)
    fetchedAt: Date.now()
  };
}

function unpackTypedArray(record) {
  const {type, buffer, length} = record;

  const Ctor =
    type === "Float64Array" ? Float64Array :
      type === "Float32Array" ? Float32Array :
        type === "Int32Array" ? Int32Array :
          type === "Uint32Array" ? Uint32Array :
            type === "Int16Array" ? Int16Array :
              type === "Uint16Array" ? Uint16Array :
                type === "Int8Array" ? Int8Array :
                  type === "Uint8Array" ? Uint8Array :
                    null;

  if (!Ctor) throw new Error(`Unsupported typed array type in cache: ${type}`);

  // IMPORTANT: length is elements; buffer byteLength may be larger; slice if needed
  const arr = new Ctor(buffer);
  if (arr.length === length) return arr;
  return arr.subarray(0, length);
}

async function getOrFetch1DCoord(zarrUrl, varName) {
  const key = `coord|${zarrUrl}|${varName}`

  // 1) Try cache
  const cached = await idbGet(key);
  if (cached?.buffer) {
    return {
      data: unpackTypedArray(cached),
      shape: cached.shape,
      fromCache: true
    };
  }

  // 2) Fetch from Zarr
  const arr = await open.v3(new FetchStore(`${zarrUrl}/${varName}`));
  const z = await get(arr, [null]); // z.data is a TypedArray in zarrita

  // 3) Store in IDB
  await idbPut(packTypedArray(key, zarrUrl, varName, z, z.data));

  return {data: z.data, shape: z.shape, fromCache: false};
}

async function getOrFetchCoords({zarrUrl}) {
  // lats: [-59.875 to 89.875 by 0.25] should be 600
  // lons: [-179.875 to 179.875 by 0.25] should be 1440
  const [lon, lat] = await Promise.all([
    getOrFetch1DCoord(zarrUrl, "lon"),
    getOrFetch1DCoord(zarrUrl, "lat")
  ]);
  return { lon, lat };
}

export {
  getOrFetchCoords,
}
