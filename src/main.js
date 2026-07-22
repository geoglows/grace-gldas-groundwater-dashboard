// Auth initializes first: registers the onAuthStateChange listener and
// captures the recovery-URL snapshot before the top-level awaits below.
import { bootstrapAuth } from "@geoglows/geoglows-auth/bootstrap";
import "@geoglows/geoglows-auth/core/sign-in.css";

bootstrapAuth({
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabasePublishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  portalUrl: import.meta.env.VITE_PORTAL_URL,
});

import "@arcgis/core/assets/esri/themes/light/main.css";
import "./style.css";

import "@arcgis/map-components/components/arcgis-map";
import "@arcgis/map-components/components/arcgis-zoom";
import "@arcgis/map-components/components/arcgis-layer-list";
import "@arcgis/map-components/components/arcgis-locate";
import "@arcgis/map-components/components/arcgis-scale-bar";
import "@arcgis/map-components/components/arcgis-expand";
import "@arcgis/map-components/components/arcgis-basemap-gallery";
import "@arcgis/map-components/components/arcgis-sketch";
import "@arcgis/map-components/components/arcgis-time-slider";
import GeoJSONLayer from "@arcgis/core/layers/GeoJSONLayer.js";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import Graphic from "@arcgis/core/Graphic.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import * as intersectionOperator from "@arcgis/core/geometry/operators/intersectionOperator.js";
import * as shapePreservingProjectOperator from "@arcgis/core/geometry/operators/shapePreservingProjectOperator.js";
import * as geodeticAreaOperator from "@arcgis/core/geometry/operators/geodeticAreaOperator.js";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";

import {get} from "zarrita";

import {cellPolygonFromCenter} from "./cells.js";
import {AQUIFERS_URL, PORTAL_URL, ZARR_URL} from "./config.js";
import {clearCacheDB, getOrFetchCoords} from "./db.js";
import {loadGlobalVariable} from "./globalFramesClient.js";
import {createGlobalRenderer} from "./globalLayer.js";
import {hydrateIcons} from "./icons.js";
import {parseGeoJSONFile} from "./polygonUploads.js";
import {renderTimeseriesChart} from "./timeseriesChart.js";
import {openZarrArray} from "./zarrStore.js";

hydrateIcons();  // heroicons

// The portal link is the one URL in the markup that is a navigation target
// rather than an asset, so Vite does not rewrite it for the base path. Patched
// here (synchronously, before any await) from the configured portal URL.
document.querySelector(".back-to-portal")?.setAttribute("href", PORTAL_URL);

// The mapped variables. All live in the same zarr store with identical
// shape/chunking/fill handling, so every read and render path is parameterized
// by variable name; the dropdown docked under the map legend switches which
// one drives the map and chart. Variables are loaded lazily, so listing one
// here before its arrays land in the store is fine — it shows a "not
// available yet" notice when selected and starts working once the data exists.
const VARIABLES = {
  GWSa: {short: "GWS", longName: "Groundwater Storage Anomaly"},
  TWSa: {short: "TWS", longName: "Total Water Storage Anomaly"},
  SMa: {short: "SM", longName: "Soil Moisture Anomaly"},
  SWEa: {short: "SWE", longName: "Snow Water Equivalent Anomaly"},
};

// Configuration state
const displayConfig = {
  variable: "GWSa",          // which anomaly is displayed (see VARIABLES)
  showBorders: false,
  borderWidth: 0.5,
  colorPalette: "default",
  dynamicColorScale: false,  // toggle for dynamic vs fixed color scale
  maxValue: 30,              // dynamic max (calculated from data when enabled)
  fixedMaxValue: 30,         // fixed max (always 30)
  opacity: 1                 // anomaly layer opacity (regional feature layer + global raster)
};

// Color palettes - use normalized positions (-1 to 1) that get scaled to actual data range
const colorPalettes = {
  default: [
    {position: -1, color: "#ff004e"},
    {position: 0, color: "#ffffff"},
    {position: 1, color: "#1c6eec"}
  ],
  viridis: [
    {position: -1, color: "#440154"},
    {position: 0, color: "#21918c"},
    {position: 1, color: "#fde725"}
  ],
  cividis: [
    {position: -1, color: "#00204d"},
    {position: 0, color: "#7c7b78"},
    {position: 1, color: "#ffea46"}
  ],
  "brown-teal": [
    {position: -1, color: "#8c510a"},
    {position: 0, color: "#f5f5f5"},
    {position: 1, color: "#01665e"}
  ],
  "purple-green": [
    {position: -1, color: "#762a83"},
    {position: 0, color: "#f7f7f7"},
    {position: 1, color: "#1b7837"}
  ],
  "rainbow": [
    {position: -1, color: "#d73027"},
    {position: -0.33, color: "#fee08b"},
    {position: 0.33, color: "#a6d96a"},
    {position: 1, color: "#1a6698"}
  ]
};

// Generate color stops scaled to max value (dynamic or fixed based on toggle)
const generateStops = () => {
  const palette = colorPalettes[displayConfig.colorPalette];
  const maxVal = displayConfig.dynamicColorScale ? displayConfig.maxValue : displayConfig.fixedMaxValue;
  return palette.map(({position, color}) => {
    const value = Math.round(position * maxVal);
    const label = value === 0 ? "0" : `${value} cm`;
    return {value, color, label};
  });
};

// Which variables are downloaded eagerly at startup, each in its own worker.
// The rest load on first selection. GWSa and TWSa are the two the toggle is
// actually used for, so paying for both up front makes switching instant.
const PREFETCH_VARIABLES = ["GWSa", "TWSa"];

// Map elements
const arcgisMap = document.querySelector("arcgis-map");
const sketchTool = document.getElementById("sketch-tool");
const timeSlider = document.getElementById("time-slider");
const timeseriesPlotDiv = document.getElementById("timeseries-plot");
const appInstructions = timeseriesPlotDiv.innerHTML

// The Chart.js instance currently occupying the timeseries panel, or null. Held
// at module scope because the panel is torn down from several unrelated places
// (entering the global view, resetting, a failed variable load); replacing its
// innerHTML without destroying the chart would orphan a live Chart.js instance
// along with its resize observer.
let activeChart = null;
const clearTimeseriesPanel = (html = "") => {
  activeChart?.destroy();
  activeChart = null;
  timeseriesPlotDiv.innerHTML = html;
};
// Settings modal
const settingsModal = document.getElementById("settings-modal");
const borderToggle = document.getElementById("border-toggle");
const borderWidthSlider = document.getElementById("border-width");
const borderWidthValue = document.getElementById("border-width-value");
const dynamicScaleToggle = document.getElementById("dynamic-scale-toggle");
// Sync initial state from the checkboxes (which render `checked`); otherwise the
displayConfig.dynamicColorScale = dynamicScaleToggle.checked;
displayConfig.showBorders = borderToggle.checked;

const openArray = (name) => openZarrArray(ZARR_URL, name);

// ---- Lazily-loaded shared inputs -------------------------------------------
// NOTHING in this module may sit at the top level behind `await`. A module with
// a top-level await runs its whole body only after that await settles, so a
// slow or failing network call would prevent the rest of the file — including
// the arcgisViewReadyChange listener that wires up every button and starts the
// initial load — from ever executing. That produced exactly the "map and
// stylesheets render but the progress bar never appears and nothing recovers"
// state: the app was structurally unable to reach its own bootstrap code.
// Instead each shared input is a memoized promise that clears itself on
// failure, so pressing the globe button retries it.

let coordsPromise = null;
const ensureCoords = () => {
  coordsPromise ??= getOrFetchCoords({zarrUrl: ZARR_URL}).catch((err) => {
    coordsPromise = null;
    geoPromise = null;
    throw err;
  });
  return coordsPromise;
};

// Grid origin derived from the coordinate arrays; needed by the renderer to
// georeference the raster and by the workers to pick preview time steps.
let geoPromise = null;
const ensureGeo = () => {
  geoPromise ??= ensureCoords().then(({lat, lon}) => {
    const cellSize = lat.data[1] - lat.data[0];
    return {cellSize, lat0: lat.data[0], lon0: lon.data[0], latEdgeMin: lat.data[0] - cellSize / 2};
  });
  return geoPromise;
};

// The shared time axis. `timeDates` is null until ensureTimeDates() resolves;
// every caller that indexes it awaits that first.
let timeDates = null;
let timeDatesPromise = null;
const ensureTimeDates = () => {
  timeDatesPromise ??= (async () => {
    const timeNode = await openArray("time");
    const timeIntegers = await get(timeNode, [null]);
    timeDates = Array.from(timeIntegers.data).map((t) => {
      const baseDate = new Date(Date.UTC(2000, 0, 1)); // time units: days since 2000-01-01
      baseDate.setUTCDate(baseDate.getUTCDate() + Number(t));
      return baseDate;
    });
    return timeDates;
  })().catch((err) => {
    timeDatesPromise = null; // allow the globe button to retry
    throw err;
  });
  return timeDatesPromise;
};

// Variable nodes are opened lazily and memoized: a variable listed in the
// dropdown before its arrays exist in the store only errors when displayed.
// A missing <var>_unc array is tolerated (unc: null -> no uncertainty band).
const varNodePromises = {};
const getVarNodes = (varName) => {
  varNodePromises[varName] ??= Promise.all([
    openArray(varName),
    openArray(`${varName}_unc`).catch(() => null),
  ])
    .then(([value, unc]) => ({value, unc}))
    .catch((err) => {
      delete varNodePromises[varName]; // allow retry once the array exists
      throw err;
    });
  return varNodePromises[varName];
};

// value arrays are int16 with a sentinel fill for missing months -> NaN
const maskFill = (node, {data, shape, stride}) => {
  const fill = node.attrs?._FillValue ?? -9999;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] === fill ? NaN : data[i];
  return {data: out, shape, stride};
};
const boundaryLayer = new GeoJSONLayer({
  title: "Aquifer Boundaries",
  url: AQUIFERS_URL,
  outFields: ["*"],
  definitionExpression: "1=1", // start with none selected
  renderer: {
    type: "simple",
    symbol: {
      type: "simple-fill",
      color: [255, 255, 255, 0],
      outline: {color: [0, 0, 0, 1], width: 2}
    }
  },
  popupTemplate: {
    title: "{n}",
    // overwriteActions: true,
    dockEnabled: false,
    dockOptions: {
      buttonEnabled: false,
      breakpoint: false
    },
    attributes: {
      id: {fieldName: "id"},
    },
    actions: [],
    content: () => {
      const div = document.createElement("div");
      div.innerHTML = `<div role="button" style="border: 1px solid black; padding: 8px; margin-top: 8px; text-align: center; font-weight: bold; background-color: #0079c1; color: white; cursor: pointer;">Analyze This Aquifer</div>`
      div.onclick = () => {
        analyzeGlobalAquifer({aquiferId: arcgisMap.view.popup.selectedFeature.attributes.id});
        arcgisMap.view.popup.close();
      }
      return div;
    }
  }
});

const analyzeGlobalAquifer = async ({aquiferId}) => {
  // Load boundary layer + zoom
  await boundaryLayer.load();

  // Before adding to map (or after, either works)
  boundaryLayer.definitionExpression = `id='${aquiferId}'`;
  await boundaryLayer.refresh?.();
  const boundaryExtent = await boundaryLayer.queryExtent()
  const zoomPromise = arcgisMap.view.goTo(boundaryExtent.extent);

  // ---- Get the actual boundary polygon geometry ----
  const q = boundaryLayer.createQuery();
  q.where = `id='${aquiferId}'`;
  q.returnGeometry = true;
  q.outFields = [];

  const fs = await boundaryLayer.queryFeatures(q);
  if (!fs.features.length) throw new Error("No features found");
  const boundaryGeom = fs.features[0].geometry;

  await main({polygon: boundaryGeom, zoomPromise});
}

const analyzeDrawnPolygon = async ({polygon}) => {
  if (polygon.spatialReference.wkid !== 4326) {
    await shapePreservingProjectOperator.load()
    polygon = shapePreservingProjectOperator.execute(polygon, SpatialReference.WGS84);
  }
  boundaryLayer.visible = false;
  const zoomPromise = arcgisMap.view.goTo(polygon.extent);
  await main({polygon, zoomPromise});
}

// ---- Whole-world animated view ----
// Every spatial chunk of the zarr holds the full time series, so a global
// frame costs the same as all frames: the whole downsampled vis copy (a few
// MB compressed; ocean chunks are never stored) is fetched once, cached in
// IndexedDB, and rendered as a Mercator-warped raster (globalLayer.js)
// instead of thousands of per-frame polygon edits. No time series chart is
// shown in this mode.
// Captured once here: view.ui.add() later moves these nodes into the
// arcgis-map shadow DOM where document.getElementById can't see them.
const globalProgressDiv = document.getElementById("global-progress");
const globalProgressLabel = document.getElementById("global-progress-label");
const globalProgressFill = document.getElementById("global-progress-fill");
// Shared color-ramp legend, used by both the regional and global views.
const mapLegendDiv = document.getElementById("map-legend");
const mapLegendTitle = document.getElementById("map-legend-title");
const mapLegendBar = document.getElementById("map-legend-bar");
const mapLegendMin = document.getElementById("map-legend-min");
const mapLegendMax = document.getElementById("map-legend-max");
// GWSa/TWSa dropdown, docked under the legend; switches both views' data.
const variableSelectPanel = document.getElementById("variable-select-panel");
const variableSelect = document.getElementById("variable-select");
displayConfig.variable = variableSelect.value; // sync from the markup's `selected` option

const globalView = {
  active: false,
  runSeq: 0,       // bumped on every enter/exit so stale async runs abandon
  renderer: null,
  // Which variable's COMPLETE frame series the renderer grid holds. A partial
  // preview paint sets this back to null, because the grid then holds a single
  // frame rather than the full time series and must be replaced before the
  // time slider can drive it.
  gridVar: null,
  geo: null,       // {cellSize, lat0, lon0, latEdgeMin}, set once coords resolve
  // per-variable loads: varName -> {dataPromise, data: {frames, nT, nLat, nLon},
  // stats: {validTimeIndices, suggestedMax}}; each variable is downloaded in its
  // own worker, independently of the others and of whichever one is displayed
  byVar: {}
};

// The regional (aquifer scale) and global buttons form a mutually-exclusive
// group: whichever mode is active shows its button pressed. exitGlobalView()
// and analyzeGlobalView() are the single choke points for the two modes, so the
// indicator is flipped from there. aria-pressed is the only state carrier —
// the .icon-btn[aria-pressed="true"] rule in style.css styles the pressed button.
const regionalViewButton = document.querySelector("#refresh-layers");
const globalViewButton = document.querySelector("#global-view-button");
const setActiveViewButton = (mode) => {
  const regionalActive = mode === "regional";
  regionalViewButton.setAttribute("aria-pressed", String(regionalActive));
  globalViewButton.setAttribute("aria-pressed", String(!regionalActive));
};
setActiveViewButton("global"); // whole-world animation is the initial view

// Route time-slider changes to whichever view is active (regional applyEdits
// or global raster). A single watcher instead of one per analysis run.
let timeStepHandler = null;
// Set by a completed regional analysis: re-renders the map layer + chart from
// the already-fetched data when the GWSa/TWSa toggle flips. Null while no
// regional analysis is showing (the toggle then only updates displayConfig).
let regionalVariableHandler = null;
// Bumped whenever any analysis (regional or global) starts or the app resets,
// so an in-flight regional run abandons before mutating shared UI state.
let analysisRunSeq = 0;
let sliderWatcherInstalled = false;
const ensureSliderWatcher = () => {
  if (sliderWatcherInstalled) return;
  sliderWatcherInstalled = true;
  reactiveUtils.watch(
    () => timeSlider.widget.timeExtent,
    (te) => {
      const current = te?.start;
      if (!current) return;
      const idx = timeDates.findIndex((d) => d.getTime() === current.getTime());
      if (idx >= 0) timeStepHandler?.(idx);
    }
  );
};

// keepCurrent preserves the slider position across a GWSa/TWSa toggle (the
// whole point of toggling is comparing the two at the same month); it falls
// back to the first date when the current one isn't in the new stop list.
const configureTimeSlider = (dates, {keepCurrent = false} = {}) => {
  const current = timeSlider.timeExtent?.start;
  timeSlider.mode = "instant";
  timeSlider.fullTimeExtent = {start: dates[0], end: dates[dates.length - 1]};
  timeSlider.stops = {dates};
  const start = keepCurrent && current && dates.some((d) => d.getTime() === current.getTime()) ? current : dates[0];
  timeSlider.timeExtent = {start, end: start};
  timeSlider.labelsVisible = true;
};

const updateGlobalProgress = (fraction) => {
  globalProgressLabel.textContent = `Loading global data… ${Math.round(fraction * 100)}%`;
  globalProgressFill.style.width = `${Math.round(fraction * 100)}%`;
};

// Both views share this small color-ramp legend, built from the current stops.
// (MediaLayer rasters never appeared in the ArcGIS legend widget, and that
// widget has been removed, so this is the only legend in the app.)
const updateMapLegend = () => {
  const stops = generateStops();
  const min = stops[0].value;
  const max = stops[stops.length - 1].value;
  const gradient = stops.map((s) => `${s.color} ${(((s.value - min) / (max - min)) * 100).toFixed(1)}%`).join(", ");
  mapLegendTitle.textContent = `${VARIABLES[displayConfig.variable].longName} (cm)`;
  mapLegendBar.style.background = `linear-gradient(to right, ${gradient})`;
  mapLegendMin.textContent = `${min} cm`;
  mapLegendMax.textContent = `${max} cm`;
};

const setGlobalGrid = (varName) => {
  const entry = globalView.byVar[varName];
  const {latEdgeMin, cellSize} = globalView.geo;
  globalView.renderer.setGrid({...entry.data, latEdgeMin, cellSize});
  globalView.gridVar = varName;
};

// Shown in the chart area when a selected variable can't be loaded — most
// likely one listed in the dropdown ahead of its arrays landing in the store.
const showVariableUnavailable = (varName) => {
  clearTimeseriesPanel(`<div class="flex h-full w-full items-center justify-center px-8 text-center text-2xl font-bold text-neutral-700">${VARIABLES[varName].longName} (${varName}) could not be loaded. It may not be available yet &mdash; choose another layer from the dropdown.</div>`);
};

// Paint a partial world sent up by a still-downloading worker. The message
// carries a single frame (~216 KB) rather than the whole series, so the grid is
// installed with nT: 1 and gridVar is cleared — the full series replaces it when
// the load finishes.
const drawGlobalPreview = (varName, {frame, nLat, nLon}) => {
  if (!globalView.active || displayConfig.variable !== varName || !globalView.renderer) return;
  const {latEdgeMin, cellSize} = globalView.geo;
  globalView.renderer.setStops(generateStops());
  globalView.renderer.setGrid({frames: frame, nT: 1, nLat, nLon, latEdgeMin, cellSize});
  globalView.gridVar = null;
  globalView.renderer.drawFrame(0);
};

// Each variable gets its own worker, started on first request and memoized.
// Loads are fully independent: a variable keeps downloading (and caching) if the
// user toggles away mid-load, it just stops painting previews and driving the
// progress bar, both of which follow whichever variable is currently displayed.
const ensureGlobalData = (varName) => {
  const entry = (globalView.byVar[varName] ??= {});
  if (!entry.dataPromise) {
    entry.dataPromise = (async () => {
      globalView.geo = await ensureGeo();
      const {frames, nT, nLat, nLon, fromCache, stats} = await loadGlobalVariable({
        varName,
        geo: globalView.geo,
        onProgress: (fraction) => {
          if (!globalView.active || displayConfig.variable !== varName) return;
          updateGlobalProgress(fraction);
        },
        onPreview: (preview) => drawGlobalPreview(varName, preview),
      });
      entry.data = {frames, nT, nLat, nLon, fromCache};
      entry.stats = stats;
      console.info(`Global ${varName} ready (${fromCache ? "from cache" : "from network"}): ${stats.validTimeIndices.length}/${nT} months with data, dynamic color scale ±${stats.suggestedMax} cm`);
    })().catch((err) => {
      entry.dataPromise = null; // allow retry after a failure
      throw err;
    });
  }
  return entry.dataPromise;
};

// Kick off every prefetched variable at once, before and independently of the
// map being ready to display any of them. Failures are logged rather than
// surfaced here; the variable the user is actually looking at reports its own
// failure through analyzeGlobalView's error path.
const prefetchGlobalVariables = () => {
  for (const varName of PREFETCH_VARIABLES) {
    ensureGlobalData(varName).catch((err) => {
      console.warn(`Background load of global ${varName} failed`, err);
    });
  }
};

// keepView: a GWSa/TWSa toggle inside the global view keeps the user's camera
// and slider position; entering global view from anywhere else flies home to
// the whole world and rewinds to the first populated month.
const analyzeGlobalView = async ({keepView = false} = {}) => {
  const runId = ++globalView.runSeq;
  analysisRunSeq++; // abandon any in-flight regional analysis
  globalView.active = true;
  const varName = displayConfig.variable;
  setActiveViewButton("global");

  // ---- clear any regional analysis state
  regionalVariableHandler = null;
  sketchTool.layer.removeAll();
  // The whole-world raster covers the map; the aquifer outlines would only
  // clutter it, so hide them here (exitGlobalView restores them).
  boundaryLayer.visible = false;
  boundaryLayer.definitionExpression = "1=1";
  const possiblyExistingLayer = arcgisMap.map.layers.find((l) => l.title === "GRACE Anomalies");
  if (possiblyExistingLayer) arcgisMap.map.layers.remove(possiblyExistingLayer);
  timeSlider.widget?.stop();
  clearTimeseriesPanel();
  timeseriesPlotDiv.classList.add("hidden");

  const zoomPromise = keepView ? Promise.resolve() : arcgisMap.view.goTo({center: [0, 20], zoom: 4}).catch(() => {
  });

  if (!globalView.renderer) globalView.renderer = createGlobalRenderer({title: "GRACE Anomalies (Global)"});
  if (!arcgisMap.map.layers.includes(globalView.renderer.layer)) {
    arcgisMap.map.layers.add(globalView.renderer.layer, 0);
  }

  // Show the progress bar BEFORE awaiting anything, so the very first paint of
  // the app already tells the user something is downloading.
  if (!globalView.byVar[varName]?.data) {
    globalProgressDiv.classList.remove("hidden");
    updateGlobalProgress(0);
  }
  try {
    // The time axis is a separate small read that the slider needs; awaiting it
    // here (rather than at module scope) keeps a failure recoverable.
    await ensureTimeDates();
    if (globalView.runSeq !== runId || !globalView.active) return;
    await ensureGlobalData(varName);
  } catch (err) {
    console.error(`Failed to load the global ${varName} dataset`, err);
    if (globalView.runSeq === runId && globalView.active) {
      globalProgressLabel.textContent = `Failed to load ${VARIABLES[varName].longName}. It may not be available yet — choose another layer or press the globe to retry.`;
      globalProgressFill.style.width = "0%";
      // don't leave another variable's raster on screen looking like this one
      if (globalView.gridVar !== varName) {
        globalView.renderer.clear();
        globalView.gridVar = null;
        mapLegendDiv.classList.add("hidden");
      }
    }
    return;
  }
  if (globalView.runSeq !== runId || !globalView.active) return;
  globalProgressDiv.classList.add("hidden");

  const {stats} = globalView.byVar[varName];
  // Fit the color scale to the 95th percentile of |values| across the whole
  // dataset; a plain max would let a few extreme cells wash out the ramp.
  displayConfig.maxValue = stats.suggestedMax;
  setGlobalGrid(varName);
  globalView.renderer.setStops(generateStops());
  globalView.renderer.setBorders({show: displayConfig.showBorders, width: displayConfig.borderWidth});
  globalView.renderer.layer.opacity = displayConfig.opacity;
  updateMapLegend();
  mapLegendDiv.classList.remove("hidden");

  const validDates = stats.validTimeIndices.map((t) => timeDates[t]);
  timeStepHandler = (idx) => globalView.renderer.drawFrame(idx);
  ensureSliderWatcher();
  configureTimeSlider(validDates.length ? validDates : timeDates, {keepCurrent: keepView});
  timeSlider.playRate = 250;
  timeSlider.loop = true; // loop when the user presses play
  const start = timeSlider.timeExtent?.start;
  const startIdx = start ? timeDates.findIndex((d) => d.getTime() === start.getTime()) : -1;
  globalView.renderer.drawFrame(startIdx >= 0 ? startIdx : (stats.validTimeIndices[0] ?? 0));

  await zoomPromise;
  // Leave the animation paused on the first frame; the user starts it with the
  // time slider's play button when ready.
};

const exitGlobalView = () => {
  globalView.runSeq++;
  globalView.active = false;
  setActiveViewButton("regional");
  timeStepHandler = null;
  timeSlider.widget?.stop();
  timeSlider.playRate = 1000;
  timeSlider.loop = false;
  if (globalView.renderer) {
    globalView.renderer.clear();
    arcgisMap.map.layers.remove(globalView.renderer.layer);
  }
  // Undo the global-view state changes; callers (main/resetLayers) re-show the
  // shared legend when a regional layer takes over.
  boundaryLayer.visible = true;
  globalProgressDiv.classList.add("hidden");
  mapLegendDiv.classList.add("hidden");
  timeseriesPlotDiv.classList.remove("hidden");
};

const main = async ({polygon, zoomPromise}) => {
  exitGlobalView();
  const runId = ++analysisRunSeq;
  regionalVariableHandler = null; // reinstalled once this run's data is ready
  await ensureTimeDates();
  const {lat, lon} = await ensureCoords();
  await arcgisMap.map.when();
  await arcgisMap.view.when();
  const cellSize = lat.data[1] - lat.data[0]; // ~0.25
  const HALF = cellSize / 2;

  // ---- Identify cells in the bounding box of the polygon to read zarr values for and start the async reads which we can wait for later
  const filteredLats = lat.data.filter((y) => y >= polygon.extent.ymin - 2 * cellSize && y <= polygon.extent.ymax + 2 * cellSize);
  const filteredLons = lon.data.filter((x) => x >= polygon.extent.xmin - 2 * cellSize && x <= polygon.extent.xmax + 2 * cellSize);
  const yStart = lat.data.indexOf(filteredLats[0]);
  const yStop = lat.data.indexOf(filteredLats[filteredLats.length - 1]) + 1;
  const xStart = lon.data.indexOf(filteredLons[0]);
  const xStop = lon.data.indexOf(filteredLons[filteredLons.length - 1]) + 1;
  // Reads are lazy per variable: the displayed one starts downloading now
  // (overlapping the geometry work below); the others are fetched only when
  // first selected, then memoized so toggling back is instant.
  const readWindow = [null, {start: yStart, stop: yStop}, {start: xStart, stop: xStop}];
  const varReads = {};
  const startVarRead = (varName) => {
    varReads[varName] ??= getVarNodes(varName)
      .then((nodes) => Promise.all([
        get(nodes.value, readWindow).then((raw) => maskFill(nodes.value, raw)), // int16 sentinel -> NaN
        nodes.unc ? get(nodes.unc, readWindow) : null,                          // float, already NaN-filled
      ]))
      .catch((err) => {
        delete varReads[varName]; // allow retry (e.g. once the array is added)
        throw err;
      });
    return varReads[varName];
  };
  startVarRead(displayConfig.variable);

  // ---- Find the overlapping areas of the cells with the polygon ----
  if (!geodeticAreaOperator.isLoaded()) await geodeticAreaOperator.load();
  intersectionOperator.accelerateGeometry(polygon);
  const intersectingCells = [];
  for (const y of filteredLats) {
    for (const x of filteredLons) {
      const cell = cellPolygonFromCenter({xCenter: x, yCenter: y, halfWidth: HALF});
      const cellArea = geodeticAreaOperator.execute(cell);
      const intersectsGeom = intersectionOperator.execute(polygon, cell);
      const intersectArea = intersectsGeom ? geodeticAreaOperator.execute(intersectsGeom) : 0;
      const frac = intersectArea / cellArea;
      intersectingCells.push({lon: x, lat: y, frac, cell, intersects: !!intersectsGeom, overlapArea: intersectArea});
    }
  }

  // Get indices of cells that pass the display threshold (frac >= 0.35)
  const displayThreshold = 0.35;
  const validCellIndices = intersectingCells
    .map((cell, idx) => (cell.intersects && cell.frac >= displayThreshold) ? idx : -1)
    .filter(idx => idx !== -1);

  // Calculate max absolute value only for displayed cells
  const findMaxAbsForValidCells = (data, shape, stride, validIndices) => {
    const [T, , nLon] = shape;
    const [sT, sY, sX] = stride;
    let max = 0;
    for (let t = 0; t < T; t++) {
      const tOffset = t * sT;
      for (const idx of validIndices) {
        // validIndices are row-major positions in the window: idx = y * nLon + x
        const v = data[tOffset + Math.floor(idx / nLon) * sY + (idx % nLon) * sX];
        if (!Number.isNaN(v) && Math.abs(v) > max) {
          max = Math.abs(v);
        }
      }
    }
    return max;
  };

  const weightedMeanTimeSeries = (data, shape, stride, cells, indices) => {
    const [T, , nLon] = shape;
    const [sT, sY, sX] = stride;
    const result = new Float64Array(T);
    for (let t = 0; t < T; t++) {
      const tOffset = t * sT;
      let weightedSum = 0;
      let weightTotal = 0;
      for (const idx of indices) {
        const v = data[tOffset + Math.floor(idx / nLon) * sY + (idx % nLon) * sX];
        if (Number.isNaN(v)) continue;
        const w = cells[idx].overlapArea;
        weightedSum += v * w;
        weightTotal += w;
      }
      result[t] = weightTotal > 0 ? weightedSum / weightTotal : NaN;
    }
    return result;
  };
  // ---- Per-variable derived data, computed once that variable's read resolves
  const varData = {};
  const loadVarData = async (varName) => {
    if (varData[varName]) return varData[varName];
    const [values, unc] = await startVarRead(varName);
    const meanSeries = weightedMeanTimeSeries(values.data, values.shape, values.stride, intersectingCells, validCellIndices);
    // Time steps where the selection actually has data. GRACE has missing months
    // plus the GRACE/GRACE-FO gap; the slider only stops on populated dates.
    const validTimeIndices = [];
    for (let t = 0; t < timeDates.length; t++) {
      if (Number.isFinite(meanSeries[t])) validTimeIndices.push(t);
    }
    const validTimeDates = validTimeIndices.map((t) => timeDates[t]);
    varData[varName] = {
      values,
      meanSeries,
      uncMeanSeries: unc ? weightedMeanTimeSeries(unc.data, unc.shape, unc.stride, intersectingCells, validCellIndices) : null,
      // Color scale bound for this variable's displayed cells
      maxValue: Math.ceil(findMaxAbsForValidCells(values.data, values.shape, values.stride, validCellIndices)) || 30,
      firstValidStep: validTimeIndices.length ? validTimeIndices[0] : 0,
      sliderDates: validTimeDates.length ? validTimeDates : timeDates,
    };
    return varData[varName];
  };

  // Generate the timeseries plot for the displayed variable (re-run on toggle)
  const plotTimeseries = () => {
    const varName = displayConfig.variable;
    const {short, longName} = VARIABLES[varName];
    const d = varData[varName];
    activeChart?.destroy();
    activeChart = renderTimeseriesChart({
      container: timeseriesPlotDiv,
      dates: timeDates,
      values: d.meanSeries,
      uncertainty: d.uncMeanSeries, // null when the store has no <var>_unc array
      name: short,
      longName,
      fileStem: `grace_${varName.toLowerCase()}`,
    });
  };

  // ---- Create the cell source; `anomaly` carries whichever variable is displayed ----
  const cellSource = intersectingCells
    .map(({lon, lat, frac, cell, intersects}, idx) => {
      if (!intersects || frac < displayThreshold) return null;
      return new Graphic({
        geometry: cell,
        attributes: {
          oid: idx,
          idx,
          lon,
          lat,
          frac,
          anomaly: 0
        }
      });
    })
    .filter(Boolean);

  const cellFields = [
    {name: "oid", type: "oid"},
    {name: "idx", type: "integer"},
    {name: "lon", type: "double"},
    {name: "lat", type: "double"},
    {name: "frac", type: "double"},
    {name: "anomaly", type: "double"}
  ];

  // Create renderer for a given field using current display config
  const createRenderer = (field) => {
    return {
      type: "simple",
      symbol: {
        type: "simple-fill",
        outline: displayConfig.showBorders
          ? {color: [0, 0, 0, 1], width: displayConfig.borderWidth}
          : {color: [0, 0, 0, 0], width: 0}
      },
      visualVariables: [{
        type: "color",
        field,
        stops: generateStops(),
        legendOptions: {
          title: "Liquid Water Equivalent (cm)",
          showLegend: true  // show the color ramp
        }
      }]
    };
  };

  const anomalyLayer = new FeatureLayer({
    title: "GRACE Anomalies",
    source: cellSource,
    objectIdField: "oid",
    fields: cellFields,
    geometryType: "polygon",
    spatialReference: SpatialReference.WGS84,
    renderer: createRenderer("anomaly"),
    opacity: displayConfig.opacity,
    visible: true
  });

  // Remove existing anomaly layer if present and add new one
  const possiblyExistingLayer = arcgisMap.map.layers.find(l => l.title === "GRACE Anomalies");
  if (possiblyExistingLayer) arcgisMap.map.layers.remove(possiblyExistingLayer);
  await zoomPromise;
  if (runId !== analysisRunSeq) return; // a newer analysis or reset took over
  arcgisMap.map.layers.add(anomalyLayer, 0);

  // ---- precompute lookup from feature idx -> oid ----
  const oids = cellSource.map(g => g.attributes.oid);
  const idxs = cellSource.map(g => g.attributes.idx);

  // ---- make updates serial so slider scrubbing doesn't overlap edits ----
  let editsInFlight = Promise.resolve();

  const updateMapToTimeStep = (timeStep) => {
    editsInFlight = editsInFlight.then(async () => {
      const {values} = varData[displayConfig.variable] ?? {};
      if (!values) return; // displayed variable failed to load
      const nLon = values.shape[2];
      const nLat = values.shape[1];
      const base = timeStep * nLat * nLon;

      // Build update array with the displayed variable's value for each cell
      const updateFeatures = new Array(cellSource.length);
      for (let i = 0; i < cellSource.length; i++) {
        const idx = idxs[i];
        updateFeatures[i] = new Graphic({
          attributes: {
            oid: oids[i],
            anomaly: values.data[base + idx]
          }
        });
      }

      await anomalyLayer.applyEdits({updateFeatures});

      activeChart?.setMarker(timeDates[timeStep]);
    }).catch(console.error);
  };

  // update the timeSlider web component — stops only on dates that have data
  timeStepHandler = updateMapToTimeStep;
  ensureSliderWatcher();

  // Render the displayed variable: load (or reuse) its window, then restyle
  // the layer, chart, legend, and slider. Used for both the initial draw and
  // the dropdown toggle; keepSlider preserves the slider position across a
  // toggle so the two variables can be compared at the same month.
  const renderVariable = async ({keepSlider}) => {
    const varName = displayConfig.variable;
    if (!varData[varName]) {
      clearTimeseriesPanel(`<div class="flex h-full w-full items-center justify-center px-8 text-center text-2xl font-bold text-neutral-700">Loading ${VARIABLES[varName].longName}&hellip;</div>`);
    }
    let d;
    try {
      d = await loadVarData(varName);
    } catch (err) {
      console.error(`Failed to load ${varName} for this region`, err);
      if (runId !== analysisRunSeq || displayConfig.variable !== varName) return;
      anomalyLayer.visible = false;
      mapLegendDiv.classList.add("hidden");
      showVariableUnavailable(varName);
      return;
    }
    if (runId !== analysisRunSeq || displayConfig.variable !== varName) return; // stale toggle or analysis
    displayConfig.maxValue = d.maxValue;
    anomalyLayer.renderer = createRenderer("anomaly");
    anomalyLayer.visible = true;
    updateMapLegend();
    mapLegendDiv.classList.remove("hidden");
    plotTimeseries();
    configureTimeSlider(d.sliderDates, {keepCurrent: keepSlider});
    const start = timeSlider.timeExtent?.start;
    const idx = start ? timeDates.findIndex((dd) => dd.getTime() === start.getTime()) : -1;
    updateMapToTimeStep(idx >= 0 ? idx : d.firstValidStep);
  };

  regionalVariableHandler = () => renderVariable({keepSlider: true});

  // initial draw
  await renderVariable({keepSlider: false});
}

const resetLayers = () => {
  exitGlobalView();
  analysisRunSeq++; // abandon any in-flight regional analysis
  regionalVariableHandler = null;
  sketchTool.layer.removeAll();
  boundaryLayer.visible = true;
  boundaryLayer.definitionExpression = "1=1"; // reset to none selected
  arcgisMap.view.goTo(boundaryLayer.fullExtent);
  timeSlider.widget?.stop();
  clearTimeseriesPanel(appInstructions);
  const possiblyExistingLayer = arcgisMap.map.layers.find(l => l.title === "GRACE Anomalies");
  if (possiblyExistingLayer) arcgisMap.map.layers.remove(possiblyExistingLayer);
}

// Build a custom set of zoom levels (LODs) at half-step increments. The default
// Web Mercator scheme halves the scale every level, so the jump from the most
// zoomed-out level to one step in is a jarring 2x. These LODs change scale by a
// factor of √2 per level (half a traditional zoom level) for gentler steps.
// Note: because each level is now a half-step, a given scale sits at twice the
// LOD number it used to (e.g. old zoom 2 → new zoom 4).
const BASE_SCALE = 591657527.591555;        // Web Mercator level-0 scale
const BASE_RESOLUTION = 156543.03392800014; // ...and its resolution (m/px)
const HALF_STEP = Math.SQRT2;               // per-level scale/resolution factor
const halfZoomLODs = Array.from({length: 47}, (_, i) => ({
  level: i,
  scale: BASE_SCALE / Math.pow(HALF_STEP, i),
  resolution: BASE_RESOLUTION / Math.pow(HALF_STEP, i),
}));

// Start both prefetched variables downloading right now, in their own workers.
// This deliberately does NOT wait for the map: the zarr download and the ArcGIS
// view initialization are independent, so overlapping them saves several
// seconds, and a map that never becomes ready no longer means data that never
// starts loading.
prefetchGlobalVariables();

// Everything that wires up the UI lives here, and it must run exactly once —
// but it is a race whether the map's view is ready before or after this module
// finishes executing. `arcgisViewReadyChange` is a one-shot event in practice,
// so a listener registered after it already fired would never run and the app
// would sit forever with a rendered map, no progress bar, and no working
// buttons. Guarding with `arcgisMap.ready` and de-duplicating with `booted`
// covers both orderings.
let booted = false;
const bootMapUi = async () => {
  if (booted) return;
  booted = true;
  await arcgisMap.map.when();
  await arcgisMap.view.when()
  arcgisMap.view.constraints = {lods: halfZoomLODs, snapToZoom: true};
  arcgisMap.map.add(boundaryLayer);
  // Preload the boundaries for later regional use; the camera is set by whichever
  // view we start in (global by default), so don't fit to the boundary extent here.
  boundaryLayer.load();

  // dock the overlays inside the map UI, adding them to each corner in stack
  // order: top-right holds the drawing tools, then the load-progress bar, the
  // shared color-ramp legend, and the GWSa/TWSa dropdown beneath it; the
  // compact time slider sits bottom-left.
  arcgisMap.view.ui.add(sketchTool, "top-right");
  arcgisMap.view.ui.add(globalProgressDiv, "top-right");
  arcgisMap.view.ui.add(mapLegendDiv, "top-right");
  arcgisMap.view.ui.add(variableSelectPanel, "top-right");
  arcgisMap.view.ui.add(timeSlider, "bottom-left");

  document
    .querySelector("#global-view-button")
    .addEventListener("click", () => analyzeGlobalView());

  // GWSa/TWSa dropdown: whichever view is active re-renders itself from the
  // newly selected variable.
  variableSelect.addEventListener("change", () => {
    displayConfig.variable = variableSelect.value;
    if (globalView.active) analyzeGlobalView({keepView: true});
    else regionalVariableHandler?.();
    // neither view active (instructions showing): the next analysis picks it up
  });

  // Global whole-world animation is the default view; enter it now that the map
  // is ready so the loading screen shows and the world fills in on first paint.
  analyzeGlobalView();

  sketchTool.availableCreateTools = ["polygon"];
  sketchTool.hideSelectionToolsRectangleSelection = true;
  sketchTool.hideSelectionToolsLassoSelection = true;
  sketchTool.layer.title = "User drawn polygons";
  sketchTool.addEventListener("arcgisCreate", (e) => {
    if (e.detail.state === "start") {
      sketchTool.layer.removeAll();
    }
    if (e.detail.state === "complete") {
      const polygon = e.detail.graphic.geometry;
      analyzeDrawnPolygon({polygon});
    }
  })

  document
    .querySelector("#refresh-layers")
    .addEventListener("click", async () => resetLayers());

  document.querySelector("#settings-button").addEventListener("click", () => {
    settingsModal.classList.toggle("hidden");
  });

  document.getElementById("settings-close").addEventListener("click", () => {
    settingsModal.classList.add("hidden");
  });

  // Clear the IndexedDB cache so the next refresh reloads everything from the
  // network (the true first-visit condition). We only delete the DB; the
  // already-loaded in-memory data keeps this session running until refresh.
  const clearCacheButton = document.getElementById("clear-cache-button");
  const clearCacheStatus = document.getElementById("clear-cache-status");
  clearCacheButton.addEventListener("click", async () => {
    clearCacheButton.disabled = true;
    clearCacheStatus.textContent = "Clearing…";
    try {
      await clearCacheDB();
      clearCacheStatus.textContent = "Cleared. Refresh to reload from the network.";
    } catch (err) {
      console.error("Failed to clear the cache database", err);
      clearCacheStatus.textContent = "Failed to clear cache. See console.";
      clearCacheButton.disabled = false;
    }
  });

  settingsModal.addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") {
      e.target.classList.add("hidden");
    }
  });

  // Restyle whichever anomaly layer is active (global raster or regional cells)
  // from the current display config, and refresh the shared legend.
  const updateAnomalyLayerAppearance = () => {
    // Global raster: restyle from the same stops, opacity, and cell boundaries
    if (globalView.active && globalView.byVar[displayConfig.variable]?.data) {
      globalView.renderer.layer.opacity = displayConfig.opacity;
      globalView.renderer.setStops(generateStops());
      globalView.renderer.setBorders({show: displayConfig.showBorders, width: displayConfig.borderWidth});
      globalView.renderer.redraw();
      updateMapLegend();
      return; // no regional feature layer while the global view is active
    }
    const anomalyLayer = arcgisMap.map.layers.find(l => l.title === "GRACE Anomalies");
    const field = anomalyLayer?.renderer?.visualVariables?.[0]?.field;
    if (!field) return;

    anomalyLayer.opacity = displayConfig.opacity;
    anomalyLayer.renderer = {
      type: "simple",
      symbol: {
        type: "simple-fill",
        outline: displayConfig.showBorders
          ? {color: [0, 0, 0, 1], width: displayConfig.borderWidth}
          : {color: [0, 0, 0, 0], width: 0}
      },
      visualVariables: [{
        type: "color",
        field,
        stops: generateStops()
      }]
    };
    updateMapLegend();
  };

  // Layer opacity slider
  const opacitySlider = document.getElementById("opacity-slider");
  const opacityValue = document.getElementById("opacity-value");
  displayConfig.opacity = parseFloat(opacitySlider.value);
  opacitySlider.addEventListener("input", (e) => {
    displayConfig.opacity = parseFloat(e.target.value);
    opacityValue.textContent = `${Math.round(displayConfig.opacity * 100)}%`;
    updateAnomalyLayerAppearance();
  });

  // Cell boundary toggle
  borderToggle.addEventListener("change", (e) => {
    displayConfig.showBorders = e.target.checked;
    updateAnomalyLayerAppearance();
  });

  // Cell boundary width slider
  borderWidthSlider.addEventListener("input", (e) => {
    displayConfig.borderWidth = parseFloat(e.target.value);
    borderWidthValue.textContent = `${displayConfig.borderWidth}px`;
    updateAnomalyLayerAppearance();
  });

  // Color palette radio buttons
  document.querySelectorAll('input[name="color-palette"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      displayConfig.colorPalette = e.target.value;
      updateAnomalyLayerAppearance();
    });
  });

  // Dynamic color scale toggle
  dynamicScaleToggle.addEventListener("change", (e) => {
    displayConfig.dynamicColorScale = e.target.checked;
    updateAnomalyLayerAppearance();
  });

  // ---- Upload modal ----
  const uploadModal = document.getElementById("upload-modal");
  const uploadDropZone = document.getElementById("upload-drop-zone");
  const uploadFileInput = document.getElementById("upload-file-input");
  const uploadBrowseButton = document.getElementById("upload-browse-button");
  const uploadFileInfo = document.getElementById("upload-file-info");
  const uploadFileName = document.getElementById("upload-file-name");
  const uploadClearFile = document.getElementById("upload-clear-file");
  const uploadError = document.getElementById("upload-error");
  const uploadSubmit = document.getElementById("upload-submit");
  const uploadCancel = document.getElementById("upload-cancel");

  let selectedFile = null;

  const resetUploadModal = () => {
    selectedFile = null;
    uploadFileInput.value = "";
    uploadFileInfo.classList.add("hidden");
    uploadFileName.textContent = "";
    uploadError.classList.add("hidden");
    uploadError.textContent = "";
    uploadSubmit.disabled = true;
    uploadSubmit.textContent = "Analyze";
    uploadDropZone.classList.remove("hidden");
  };

  const showUploadError = (message) => {
    uploadError.textContent = message;
    uploadError.classList.remove("hidden");
  };

  const handleFileSelection = (file) => {
    uploadError.classList.add("hidden");
    uploadError.textContent = "";

    const name = file.name.toLowerCase();
    if (!name.endsWith(".geojson") && !name.endsWith(".json")) {
      showUploadError("Invalid file type. Please upload a .geojson or .json file.");
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      showUploadError("File is too large. Maximum file size is 50 MB.");
      return;
    }

    selectedFile = file;
    uploadFileName.textContent = file.name;
    uploadFileInfo.classList.remove("hidden");
    uploadDropZone.classList.add("hidden");
    uploadSubmit.disabled = false;
  };

  document.getElementById("upload-button").addEventListener("click", () => {
    resetUploadModal();
    uploadModal.classList.toggle("hidden");
  });

  uploadModal.addEventListener("click", (e) => {
    if (e.target.id === "upload-modal") {
      e.target.classList.add("hidden");
    }
  });

  uploadCancel.addEventListener("click", () => {
    uploadModal.classList.add("hidden");
  });

  uploadBrowseButton.addEventListener("click", () => {
    uploadFileInput.click();
  });

  uploadFileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      handleFileSelection(e.target.files[0]);
    }
  });

  uploadClearFile.addEventListener("click", () => {
    resetUploadModal();
  });

  // data-drag (not a class) so the highlight lives in the markup's Tailwind
  // classes as a data-[drag=true]: variant.
  uploadDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadDropZone.dataset.drag = "true";
  });

  uploadDropZone.addEventListener("dragleave", () => {
    delete uploadDropZone.dataset.drag;
  });

  uploadDropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    delete uploadDropZone.dataset.drag;
    if (e.dataTransfer.files.length > 0) {
      handleFileSelection(e.dataTransfer.files[0]);
    }
  });

  uploadSubmit.addEventListener("click", async () => {
    if (!selectedFile) return;

    uploadSubmit.disabled = true;
    uploadSubmit.textContent = "Processing...";
    uploadError.classList.add("hidden");

    try {
      const {polygon} = await parseGeoJSONFile(selectedFile);
      uploadModal.classList.add("hidden");
      sketchTool.layer.removeAll();
      sketchTool.layer.add(new Graphic({
        geometry: polygon,
        symbol: {
          type: "simple-fill",
          color: [255, 255, 255, 0],
          outline: {color: [0, 0, 0, 1], width: 2}
        }
      }));
      await analyzeDrawnPolygon({polygon});
    } catch (err) {
      showUploadError(err.message);
      uploadSubmit.disabled = false;
      uploadSubmit.textContent = "Analyze";
    }
  });
};

arcgisMap.addEventListener("arcgisViewReadyChange", () => {
  if (arcgisMap.ready === false) return; // also fires when a view is torn down
  bootMapUi().catch((err) => console.error("Failed to initialize the map UI", err));
});
// The event may already have fired while this module was still evaluating.
if (arcgisMap.ready) {
  bootMapUi().catch((err) => console.error("Failed to initialize the map UI", err));
}
