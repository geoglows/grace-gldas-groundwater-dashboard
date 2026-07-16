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

import Plotly from "plotly.js/lib/core";
import Scatter from "plotly.js/lib/scatter";

import {cellPolygonFromCenter} from "./cells.js";
import {clearCacheDB, getOrFetchCoords} from "./db.js";
import {computeFrameStats, loadGlobalFrames} from "./globalData.js";
import {createGlobalRenderer} from "./globalLayer.js";
import {createLinePlot, createUncertaintyBand} from "./helpers.js";
import {hydrateIcons} from "./icons.js";
import {parseGeoJSONFile} from "./polygonUploads.js";
import {openZarrArray} from "./zarrStore.js";

Plotly.register([Scatter]);

hydrateIcons();  // heroicons

// Configuration state
const displayConfig = {
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

const zarrUrl = "https://d3hbj0z0f67zhd.cloudfront.net/ggg/grace-gldas-water-balance.zarr";
// Map elements
const arcgisMap = document.querySelector("arcgis-map");
const sketchTool = document.getElementById("sketch-tool");
const timeSlider = document.getElementById("time-slider");
const timeseriesPlotDiv = document.getElementById("timeseries-plot");
const appInstructions = timeseriesPlotDiv.innerHTML
// Settings modal
const settingsModal = document.getElementById("settings-modal");
const borderToggle = document.getElementById("border-toggle");
const borderWidthSlider = document.getElementById("border-width");
const borderWidthValue = document.getElementById("border-width-value");
const dynamicScaleToggle = document.getElementById("dynamic-scale-toggle");
// Sync initial state from the checkboxes (which render `checked`); otherwise the
displayConfig.dynamicColorScale = dynamicScaleToggle.checked;
displayConfig.showBorders = borderToggle.checked;

const openArray = (name) => openZarrArray(zarrUrl, name);

const coordsPromise = getOrFetchCoords({zarrUrl});
const [gwsaNode, gwsaUncNode, timeNode] = await Promise.all([openArray("GWSa"), openArray("GWSa_unc"), openArray("time")]);

const GWSA_FILL = gwsaNode.attrs?._FillValue ?? -9999;
const maskGwsaFill = ({data, shape, stride}) => {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] === GWSA_FILL ? NaN : data[i];
  return {data: out, shape, stride};
};
const timeIntegers = await get(timeNode, [null]);
const timeDates = Array.from(timeIntegers.data).map((t) => {
  const baseDate = new Date(Date.UTC(2000, 0, 1)); // time units: days since 2000-01-01
  baseDate.setUTCDate(baseDate.getUTCDate() + Number(t));
  return baseDate;
});
const boundaryLayer = new GeoJSONLayer({
  title: "Aquifer Boundaries",
  url: new URL("/aquifers.geojson", import.meta.url).href,
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
const mapLegendBar = document.getElementById("map-legend-bar");
const mapLegendMin = document.getElementById("map-legend-min");
const mapLegendMax = document.getElementById("map-legend-max");

const globalView = {
  active: false,
  runSeq: 0,       // bumped on every enter/exit so stale async runs abandon
  renderer: null,
  dataPromise: null,
  data: null,      // {frames, nT, nLat, nLon} from the vis copy
  stats: null      // {validTimeIndices, suggestedMax}
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

const configureTimeSlider = (dates) => {
  timeSlider.mode = "instant";
  timeSlider.fullTimeExtent = {start: dates[0], end: dates[dates.length - 1]};
  timeSlider.stops = {dates};
  timeSlider.timeExtent = {start: dates[0], end: dates[0]};
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
  mapLegendBar.style.background = `linear-gradient(to right, ${gradient})`;
  mapLegendMin.textContent = `${min} cm`;
  mapLegendMax.textContent = `${max} cm`;
};

const setGlobalGrid = () => {
  globalView.renderer.setGrid({...globalView.data, latEdgeMin: globalView.latEdgeMin, cellSize: globalView.cellSize});
};

// While chunks stream in, preview the most recent month that already has data
// at one of a few landmark land cells, so the world visibly fills in.
const pickPreviewTimeStep = ({frames, nT, nLat, nLon}) => {
  const spots = [[40.5, -99.5], [-4.5, -60.5], [25.5, 78.5], [48.5, 10.5]];
  const cells = spots
    .map(([la, lo]) => {
      const row = Math.round((la - globalView.lat0) / globalView.cellSize);
      const col = Math.round((lo - globalView.lon0) / globalView.cellSize);
      return row >= 0 && row < nLat && col >= 0 && col < nLon ? row * nLon + col : -1;
    })
    .filter((i) => i >= 0);
  const frameSize = nLat * nLon;
  for (let t = nT - 1; t >= 0; t--) {
    const base = t * frameSize;
    if (cells.some((c) => frames[base + c] === frames[base + c])) return t;
  }
  return nT - 1;
};

const ensureGlobalData = () => {
  if (!globalView.dataPromise) {
    globalView.dataPromise = (async () => {
      const {lat, lon} = await getOrFetchCoords({zarrUrl});
      globalView.cellSize = lat.data[1] - lat.data[0];
      globalView.lat0 = lat.data[0];
      globalView.lon0 = lon.data[0];
      globalView.latEdgeMin = lat.data[0] - globalView.cellSize / 2;

      let previewReady = false;
      let lastPreviewAt = 0;
      // dedicated node: the global loader wants opaque CORS errors confirmed
      // twice before accepting a chunk as missing (it caches what it reads)
      const globalGwsaNode = await openZarrArray(zarrUrl, "GWSa", {confirmOpaqueErrors: true});
      const data = await loadGlobalFrames({
        gwsaNode: globalGwsaNode,
        zarrUrl,
        onProgress: (fraction, partial) => {
          if (!globalView.active) return;
          updateGlobalProgress(fraction);
          if (!partial || fraction >= 1) return;
          const now = performance.now();
          if (now - lastPreviewAt < 500) return;
          lastPreviewAt = now;
          if (!previewReady) {
            globalView.renderer.setStops(generateStops());
            globalView.renderer.setGrid({...partial, latEdgeMin: globalView.latEdgeMin, cellSize: globalView.cellSize});
            previewReady = true;
          }
          globalView.renderer.drawFrame(pickPreviewTimeStep(partial));
        }
      });
      globalView.stats = computeFrameStats(data);
      globalView.data = data;
      console.info(`Global view ready (${data.fromCache ? "from cache" : "from network"}): ${globalView.stats.validTimeIndices.length}/${data.nT} months with data, dynamic color scale ±${globalView.stats.suggestedMax} cm`);
    })().catch((err) => {
      globalView.dataPromise = null; // allow retry after a failure
      throw err;
    });
  }
  return globalView.dataPromise;
};

const analyzeGlobalView = async () => {
  const runId = ++globalView.runSeq;
  analysisRunSeq++; // abandon any in-flight regional analysis
  globalView.active = true;
  setActiveViewButton("global");

  // ---- clear any regional analysis state
  sketchTool.layer.removeAll();
  // The whole-world raster covers the map; the aquifer outlines would only
  // clutter it, so hide them here (exitGlobalView restores them).
  boundaryLayer.visible = false;
  boundaryLayer.definitionExpression = "1=1";
  const possiblyExistingLayer = arcgisMap.map.layers.find((l) => l.title === "GRACE Anomalies");
  if (possiblyExistingLayer) arcgisMap.map.layers.remove(possiblyExistingLayer);
  timeSlider.widget?.stop();
  timeseriesPlotDiv.innerHTML = "";
  timeseriesPlotDiv.classList.add("hidden");

  const zoomPromise = arcgisMap.view.goTo({center: [0, 20], zoom: 4}).catch(() => {
  });

  if (!globalView.renderer) globalView.renderer = createGlobalRenderer({title: "GRACE Anomalies (Global)"});
  if (!arcgisMap.map.layers.includes(globalView.renderer.layer)) {
    arcgisMap.map.layers.add(globalView.renderer.layer, 0);
  }

  if (!globalView.data) {
    globalProgressDiv.classList.remove("hidden");
    updateGlobalProgress(0);
  }
  try {
    await ensureGlobalData();
  } catch (err) {
    console.error("Failed to load the global dataset", err);
    if (globalView.runSeq === runId && globalView.active) {
      globalProgressLabel.textContent = "Failed to load global data. Press the globe to retry.";
      globalProgressFill.style.width = "0%";
    }
    return;
  }
  if (globalView.runSeq !== runId || !globalView.active) return;
  globalProgressDiv.classList.add("hidden");

  // Fit the color scale to the 95th percentile of |values| across the whole
  // dataset; a plain max would let a few extreme cells wash out the ramp.
  displayConfig.maxValue = globalView.stats.suggestedMax;
  setGlobalGrid();
  globalView.renderer.setStops(generateStops());
  globalView.renderer.setBorders({show: displayConfig.showBorders, width: displayConfig.borderWidth});
  globalView.renderer.layer.opacity = displayConfig.opacity;
  updateMapLegend();
  mapLegendDiv.classList.remove("hidden");

  const validDates = globalView.stats.validTimeIndices.map((t) => timeDates[t]);
  timeStepHandler = (idx) => globalView.renderer.drawFrame(idx);
  ensureSliderWatcher();
  configureTimeSlider(validDates.length ? validDates : timeDates);
  timeSlider.playRate = 250;
  timeSlider.loop = true; // loop when the user presses play
  globalView.renderer.drawFrame(globalView.stats.validTimeIndices[0] ?? 0);

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
  const {lat, lon} = await coordsPromise;
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
  // Fetch values and uncertainties, each parameter from its own dedicated array
  const readWindow = [null, {start: yStart, stop: yStop}, {start: xStart, stop: xStop}];
  let gwsaValues = get(gwsaNode, readWindow);
  let gwsaUncValues = get(gwsaUncNode, readWindow);

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

  // ---- Resolve zarr reads and compute averages
  gwsaValues = maskGwsaFill(await gwsaValues); // int16 sentinel -> NaN
  gwsaUncValues = await gwsaUncValues;         // float16, already NaN-filled
  if (runId !== analysisRunSeq) return; // a newer analysis or reset took over

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
  // Color scale is driven by the mapped variable (GWSa)
  const maxAbs = findMaxAbsForValidCells(gwsaValues.data, gwsaValues.shape, gwsaValues.stride, validCellIndices);
  displayConfig.maxValue = Math.ceil(maxAbs) || 30; // round up, fallback to 30 if no valid cells

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
  const gwsaMeanTimeSeries = weightedMeanTimeSeries(gwsaValues.data, gwsaValues.shape, gwsaValues.stride, intersectingCells, validCellIndices);
  const gwsaUncMeanTimeSeries = weightedMeanTimeSeries(gwsaUncValues.data, gwsaUncValues.shape, gwsaUncValues.stride, intersectingCells, validCellIndices);

  // Time steps where the selection actually has data. GRACE has missing months
  // plus the GRACE/GRACE-FO gap; the slider only stops on populated dates.
  const validTimeIndices = [];
  for (let t = 0; t < timeDates.length; t++) {
    if (Number.isFinite(gwsaMeanTimeSeries[t])) validTimeIndices.push(t);
  }
  const validTimeDates = validTimeIndices.map((t) => timeDates[t]);
  const firstValidStep = validTimeIndices.length ? validTimeIndices[0] : 0;
  const sliderDates = validTimeDates.length ? validTimeDates : timeDates;

  // Generate the timeseries plot
  timeseriesPlotDiv.innerHTML = "";
  Plotly.newPlot(
    timeseriesPlotDiv,
    [
      // GWS uncertainty band and line
      createUncertaintyBand({x: timeDates, yArray: gwsaMeanTimeSeries, uncertaintyArray: gwsaUncMeanTimeSeries, color: "rgba(28,110,236,0.25)", name: "GWS"}),
      createLinePlot({x: timeDates, y: gwsaMeanTimeSeries, color: "#1c6eec", name: "GWS", uncertainty: gwsaUncMeanTimeSeries}),
    ],
    {
      title: {text: "Groundwater Storage Anomaly Time Series and Uncertainty", font: {size: 14, color: "#333"}, y: 0.97, yanchor: "top"},
      xaxis: {title: {text: "Time", font: {size: 12, color: "#333"}}, automargin: true},
      yaxis: {title: {text: "Liquid Water Equivalent (cm)", font: {size: 12, color: "#333"}}, automargin: true},
      showlegend: false,
      dragmode: false,  // disable click-and-drag zoom/pan on the plot area
    },
    {
      responsive: true,
      toImageButtonOptions: {
        format: "png",
        filename: "grace_anomaly_timeseries",
        height: 600,
        width: 1200,
        scale: 2
      },
      modeBarButtonsToAdd: [
        {
          name: "Download CSV",
          icon: Plotly.Icons.disk,
          click: function (gd) {
            // Line traces carry the center value (y) and per-point uncertainty
            // (customdata); upper/lower are derived from those.
            const lineTraces = gd.data.filter(t => t.mode === "lines");

            const dates = lineTraces[0]?.x || [];

            // Build headers: Date, then for each series: value, upper, lower
            const headers = ["Date"];
            lineTraces.forEach(t => {
              headers.push(t.name, `${t.name}_upper`, `${t.name}_lower`);
            });

            // Build rows
            const rows = dates.map((date, i) => {
              const dateStr = new Date(date).toISOString().split("T")[0];
              const values = [dateStr];

              lineTraces.forEach((lineTrace) => {
                const center = lineTrace.y[i];
                const unc = lineTrace.customdata?.[i];
                const centerVal = Number.isFinite(center) ? center : "";
                const hasBand = centerVal !== "" && Number.isFinite(unc);
                const upperVal = hasBand ? center + unc : "";
                const lowerVal = hasBand ? center - unc : "";
                values.push(centerVal, upperVal, lowerVal);
              });

              return values.join(",");
            });

            const csv = [headers.join(","), ...rows].join("\n");
            const blob = new Blob([csv], {type: "text/csv"});
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "grace_anomaly_data.csv";
            a.click();
            URL.revokeObjectURL(url);
          }
        }
      ]
    }
  );

  // ---- Create the cell source for the mapped variable (GWSa) ----
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
          gwsaValue: 0
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
    {name: "gwsaValue", type: "double"}
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

  const gwsaLayer = new FeatureLayer({
    title: "GRACE Anomalies",
    source: cellSource,
    objectIdField: "oid",
    fields: cellFields,
    geometryType: "polygon",
    spatialReference: SpatialReference.WGS84,
    renderer: createRenderer("gwsaValue"),
    opacity: displayConfig.opacity,
    visible: true
  });

  // Remove existing anomaly layer if present and add new one
  const possiblyExistingLayer = arcgisMap.map.layers.find(l => l.title === "GRACE Anomalies");
  if (possiblyExistingLayer) arcgisMap.map.layers.remove(possiblyExistingLayer);
  await zoomPromise;
  if (runId !== analysisRunSeq) return; // a newer analysis or reset took over
  arcgisMap.map.layers.add(gwsaLayer, 0);
  updateMapLegend();
  mapLegendDiv.classList.remove("hidden");

  // ---- precompute lookup from feature idx -> oid ----
  const oids = cellSource.map(g => g.attributes.oid);
  const idxs = cellSource.map(g => g.attributes.idx);

  // ---- make updates serial so slider scrubbing doesn't overlap edits ----
  let editsInFlight = Promise.resolve();

  const updateMapToTimeStep = (timeStep) => {
    editsInFlight = editsInFlight.then(async () => {
      const nLon = gwsaValues.shape[2];
      const nLat = gwsaValues.shape[1];
      const base = timeStep * nLat * nLon;

      // Build update array with the groundwater value for each cell
      const updateFeatures = new Array(cellSource.length);
      for (let i = 0; i < cellSource.length; i++) {
        const idx = idxs[i];
        updateFeatures[i] = new Graphic({
          attributes: {
            oid: oids[i],
            gwsaValue: gwsaValues.data[base + idx]
          }
        });
      }

      await gwsaLayer.applyEdits({updateFeatures});

      Plotly
        .relayout(
          timeseriesPlotDiv,
          {
            shapes: [{
              type: "line",
              x0: timeDates[timeStep],
              x1: timeDates[timeStep],
              y0: 0,
              y1: 1,
              yref: "paper",
              line: {color: "red", width: 2, dash: "dot"}
            }]
          }
        );
    }).catch(console.error);
  };

  // update the timeSlider web component — stops only on dates that have data
  timeStepHandler = updateMapToTimeStep;
  ensureSliderWatcher();
  configureTimeSlider(sliderDates);

  // initial draw
  updateMapToTimeStep(firstValidStep);
}

const resetLayers = () => {
  exitGlobalView();
  analysisRunSeq++; // abandon any in-flight regional analysis
  sketchTool.layer.removeAll();
  boundaryLayer.visible = true;
  boundaryLayer.definitionExpression = "1=1"; // reset to none selected
  arcgisMap.view.goTo(boundaryLayer.fullExtent);
  timeSlider.widget?.stop();
  timeseriesPlotDiv.innerHTML = appInstructions;
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

arcgisMap.addEventListener("arcgisViewReadyChange", async () => {
  await arcgisMap.map.when();
  await arcgisMap.view.when()
  arcgisMap.view.constraints = {lods: halfZoomLODs, snapToZoom: true};
  arcgisMap.map.add(boundaryLayer);
  // Preload the boundaries for later regional use; the camera is set by whichever
  // view we start in (global by default), so don't fit to the boundary extent here.
  boundaryLayer.load();

  // dock the overlays inside the map UI, adding them to each corner in stack
  // order: top-right holds the drawing tools, then the load-progress bar, then
  // the shared color-ramp legend; the compact time slider sits bottom-left.
  arcgisMap.view.ui.add(sketchTool, "top-right");
  arcgisMap.view.ui.add(globalProgressDiv, "top-right");
  arcgisMap.view.ui.add(mapLegendDiv, "top-right");
  arcgisMap.view.ui.add(timeSlider, "bottom-left");

  document
    .querySelector("#global-view-button")
    .addEventListener("click", () => analyzeGlobalView());

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
    if (globalView.active && globalView.data) {
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
});
