import Extent from "@arcgis/core/geometry/Extent.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import MediaLayer from "@arcgis/core/layers/MediaLayer.js";
import ExtentAndRotationGeoreference from "@arcgis/core/layers/support/ExtentAndRotationGeoreference.js";
import ImageElement from "@arcgis/core/layers/support/ImageElement.js";

// Draws one time step of the global grid into an ImageData and shows it on a
// MediaLayer. This is raster rendering: a FeatureLayer + applyEdits would need
// 54,000 polygon edits per animation frame, while this path costs a few
// milliseconds per frame regardless of cell count.
//
// The image is pre-warped to Web Mercator on the CPU (a per-output-row lookup
// into the source latitude rows) and georeferenced with a Mercator extent, so
// it registers exactly with the basemap instead of relying on the MediaLayer's
// four-corner warp, which is linear and would misplace mid-latitudes.
const EARTH_RADIUS = 6378137;
const MAX_MERCATOR_LAT = 85.05112878;
const CANVAS_WIDTH = 1440;
const CANVAS_HEIGHT = 1024;
const LUT_SIZE = 1024;

const mercatorY = (latDeg) => EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));
const mercatorX = (lonDeg) => (EARTH_RADIUS * lonDeg * Math.PI) / 180;
const inverseMercatorLat = (y) => ((2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * 180) / Math.PI;

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
];

// Opaque black cell-boundary line, packed endianness-safe like the LUT entries.
const BORDER_PACKED = (() => {
  const rgba = new Uint8ClampedArray([0, 0, 0, 255]);
  return new Uint32Array(rgba.buffer)[0];
})();

// Continuous color lookup table interpolated between the renderer stops, so
// the raster matches the colors the FeatureLayer's visualVariables produce.
// Entries are packed pixels (endianness-safe via the Uint8/Uint32 view pair).
const buildLut = (stops) => {
  const sorted = [...stops].sort((a, b) => a.value - b.value);
  const min = sorted[0].value;
  const max = sorted[sorted.length - 1].value;
  const colors = sorted.map((s) => hexToRgb(s.color));
  const table = new Uint32Array(LUT_SIZE);
  const rgba = new Uint8ClampedArray(4);
  const packed = new Uint32Array(rgba.buffer);
  let seg = 0;
  for (let i = 0; i < LUT_SIZE; i++) {
    const v = min + (i / (LUT_SIZE - 1)) * (max - min);
    while (seg < sorted.length - 2 && v > sorted[seg + 1].value) seg++;
    const span = sorted[seg + 1].value - sorted[seg].value;
    const f = span > 0 ? Math.min(1, Math.max(0, (v - sorted[seg].value) / span)) : 0;
    rgba[0] = colors[seg][0] + f * (colors[seg + 1][0] - colors[seg][0]);
    rgba[1] = colors[seg][1] + f * (colors[seg + 1][1] - colors[seg][1]);
    rgba[2] = colors[seg][2] + f * (colors[seg + 1][2] - colors[seg][2]);
    rgba[3] = 255;
    table[i] = packed[0];
  }
  return {table, min, max};
};

export function createGlobalRenderer({title}) {
  const layer = new MediaLayer({title, source: []});

  let grid = null;         // {frames, nT, nLat, nLon}
  let rowOffsets = null;   // canvas row -> source row offset (row * nLon), or -1 outside the grid
  let pxPerCell = 0;       // horizontal pixels per grid cell
  let extent = null;       // mercator extent of the rendered image
  let lut = null;
  let borders = {show: false, width: 1}; // grid cell boundaries, mirrors the regional layer's outline
  let currentT = 0;
  let element = null;
  const imageData = new ImageData(CANVAS_WIDTH, CANVAS_HEIGHT);
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");

  // grid rows run south -> north; canvas rows run top (north) -> bottom
  const setGrid = ({frames, nT, nLat, nLon, latEdgeMin, cellSize}) => {
    grid = {frames, nT, nLat, nLon};
    pxPerCell = Math.floor(CANVAS_WIDTH / nLon);
    const latEdgeMax = latEdgeMin + nLat * cellSize;
    const yTop = mercatorY(Math.min(latEdgeMax, MAX_MERCATOR_LAT));
    const yBottom = mercatorY(Math.max(latEdgeMin, -MAX_MERCATOR_LAT));
    rowOffsets = new Int32Array(CANVAS_HEIGHT);
    for (let j = 0; j < CANVAS_HEIGHT; j++) {
      const y = yTop - ((j + 0.5) / CANVAS_HEIGHT) * (yTop - yBottom);
      const row = Math.floor((inverseMercatorLat(y) - latEdgeMin) / cellSize);
      rowOffsets[j] = row >= 0 && row < nLat ? row * nLon : -1;
    }
    extent = new Extent({
      xmin: mercatorX(-180),
      xmax: mercatorX(180),
      ymin: yBottom,
      ymax: yTop,
      spatialReference: SpatialReference.WebMercator
    });
  };

  const setStops = (stops) => {
    lut = buildLut(stops);
  };

  const setBorders = (config) => {
    borders = {...borders, ...config};
  };

  const colorize = (t, imageData) => {
    const {frames, nLat, nLon} = grid;
    const px = new Uint32Array(imageData.data.buffer);
    const frameBase = t * nLat * nLon;
    const {table, min, max} = lut;
    const invScale = max > min ? (LUT_SIZE - 1) / (max - min) : 0;
    // Draw cell boundaries only when cells are wide enough for a line to read.
    // Each data cell gets its left edge (vertical line, `bw` px) and top edge
    // (horizontal line, `bw` canvas rows); boundaries are drawn only on cells
    // that actually hold data so the grid doesn't bleed over transparent ocean.
    const drawBorders = borders.show && pxPerCell >= 3;
    const bw = drawBorders ? Math.max(1, Math.min(pxPerCell - 1, Math.round(borders.width))) : 0;
    let prevOffset = -1;
    let sinceTop = 0;
    for (let j = 0; j < CANVAS_HEIGHT; j++) {
      let o = j * CANVAS_WIDTH;
      const srcOffset = rowOffsets[j];
      if (srcOffset < 0) {
        px.fill(0, o, o + CANVAS_WIDTH);
        prevOffset = -1;
        continue;
      }
      // canvas rows within `bw` of a data-row change are the cell's top edge
      sinceTop = srcOffset === prevOffset ? sinceTop + 1 : 0;
      prevOffset = srcOffset;
      const topEdge = drawBorders && sinceTop < bw;
      const rowBase = frameBase + srcOffset;
      for (let c = 0; c < nLon; c++) {
        const v = frames[rowBase + c];
        if (v === v) {
          let q = ((v - min) * invScale) | 0;
          if (q < 0) q = 0;
          else if (q >= LUT_SIZE) q = LUT_SIZE - 1;
          px.fill(table[q], o, o + pxPerCell);
          if (drawBorders) {
            px.fill(BORDER_PACKED, o, o + bw);                 // left edge
            if (topEdge) px.fill(BORDER_PACKED, o, o + pxPerCell); // top edge
          }
        } else {
          px.fill(0, o, o + pxPerCell); // transparent for NaN (oceans, missing months)
        }
        o += pxPerCell;
      }
      // clear the remainder when the width isn't an exact multiple of nLon
      const rowEnd = (j + 1) * CANVAS_WIDTH;
      if (o < rowEnd) px.fill(0, o, rowEnd);
    }
  };

  // The 2D engine uploads a canvas texture exactly ONCE per ImageElement
  // (views/2d/engine/webgl/Overlay.js only re-uploads HTMLVideoElement and
  // animated GIF/APNG content), and reassigning element.image after load is a
  // silent no-op. Assigning a NEW object to the public `animationOptions`
  // property fires an Overlay watch that disposes the cached texture and
  // requests a render; the next render frame then re-creates the texture from
  // the canvas's current pixels in the same frame (no flicker). Verified
  // against the shipped 4.34.8 code — re-verify on SDK upgrades. If it ever
  // breaks (symptom: animation frozen on its first frame), fall back to
  // creating a fresh ImageElement per frame, adding it with opacity 0,
  // flipping opacities once loaded, then removing the old element (the
  // pattern Esri's Wayback/imagery-explorer apps use).
  const present = () => {
    ctx.putImageData(imageData, 0, 0);
    if (!element) {
      element = new ImageElement({
        image: canvas,
        georeference: new ExtentAndRotationGeoreference({extent})
      });
      layer.source.elements.add(element);
    } else {
      element.animationOptions = {...element.animationOptions};
    }
  };

  const drawFrame = (t) => {
    if (!grid || !lut) return;
    currentT = Math.max(0, Math.min(t, grid.nT - 1));
    colorize(currentT, imageData);
    present();
  };

  const redraw = () => drawFrame(currentT);

  const clear = () => {
    layer.source.elements.removeAll();
    element = null;
  };

  return {layer, setGrid, setStops, setBorders, drawFrame, redraw, clear};
}
