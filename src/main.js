import "./style.css";
import "./modal.css"

import "@arcgis/core/assets/esri/themes/light/main.css";
import "@arcgis/map-components/components/arcgis-map";
import "@arcgis/map-components/components/arcgis-zoom";
import "@arcgis/map-components/components/arcgis-layer-list";
import "@arcgis/map-components/components/arcgis-locate";
import "@arcgis/map-components/components/arcgis-scale-bar";
import "@arcgis/map-components/components/arcgis-expand";
import "@arcgis/map-components/components/arcgis-basemap-gallery";
import "@arcgis/map-components/components/arcgis-legend";
import "@arcgis/map-components/components/arcgis-sketch";
import "@arcgis/map-components/components/arcgis-time-slider";
import GeoJSONLayer from "@arcgis/core/layers/GeoJSONLayer.js";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import Graphic from "@arcgis/core/Graphic.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import * as intersectionOperator from "@arcgis/core/geometry/operators/intersectionOperator.js";
import * as shapePreservingProjectOperator from "@arcgis/core/geometry/operators/shapePreservingProjectOperator.js";
import * as geometryEngine from "@arcgis/core/geometry/geometryEngine.js";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils.js";

import {FetchStore, get, open} from "zarrita";

import Plotly from "plotly.js/lib/core";
import Scatter from "plotly.js/lib/scatter";

import {cellPolygonFromCenter} from "./cells.js";
import {getOrFetchCoords} from "./db.js";
import {createLinePlot, createUncertaintyBand} from "./helpers.js";
import {parseGeoJSONFile} from "./polygonUploads.js";

Plotly.register([Scatter]);

// Configuration state
const displayConfig = {
  showBorders: false,
  borderWidth: 0.5,
  colorPalette: "default",
  dynamicColorScale: false,  // toggle for dynamic vs fixed color scale
  maxValue: 30,              // dynamic max (calculated from data when enabled)
  fixedMaxValue: 30          // fixed max (always 30)
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

// No trailing slash: reads build `${zarrUrl}/${name}`, and a trailing slash
// would produce a `//` that S3/CloudFront rejects (403 on the doubled key).
// The CloudFront distribution must return CORS headers (Access-Control-Allow-
// Origin) for this cross-origin fetch to work in the browser.
const zarrUrl = "https://d3hbj0z0f67zhd.cloudfront.net/ggst/grace-gldas-water-balance.zarr";
// Map elements
const arcgisMap = document.querySelector("arcgis-map");
const arcgisLayerList = document.querySelector("arcgis-layer-list");
const sketchTool = document.querySelector("arcgis-sketch");
const timeSlider = document.querySelector("arcgis-time-slider");
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

const openArray = (name) => open.v3(new FetchStore(`${zarrUrl}/${name}`));

const coordsPromise = getOrFetchCoords({zarrUrl});
const [gwsaNode, gwsaUncNode, timeNode] = await Promise.all([openArray("GWSa"), openArray("GWSa_unc"), openArray("time")]);
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

const main = async ({polygon, zoomPromise}) => {
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
  intersectionOperator.accelerateGeometry(polygon);
  const intersectingCells = [];
  for (const y of filteredLats) {
    for (const x of filteredLons) {
      const cell = cellPolygonFromCenter({xCenter: x, yCenter: y, halfWidth: HALF});
      const cellArea = geometryEngine.geodesicArea(cell);
      const intersectsGeom = intersectionOperator.execute(polygon, cell);
      const intersectArea = intersectsGeom ? geometryEngine.geodesicArea(intersectsGeom) : 0;
      const frac = intersectArea / cellArea;
      intersectingCells.push({lon: x, lat: y, frac, cell, intersects: !!intersectsGeom, overlapArea: intersectArea});
    }
  }

  // ---- Resolve zarr reads and compute averages
  gwsaValues = await gwsaValues;
  gwsaUncValues = await gwsaUncValues;

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
    visible: true
  });

  // Remove existing anomaly layer if present and add new one
  const possiblyExistingLayer = arcgisMap.map.layers.find(l => l.title === "GRACE Anomalies");
  if (possiblyExistingLayer) arcgisMap.map.layers.remove(possiblyExistingLayer);
  await zoomPromise;
  arcgisMap.map.layers.add(gwsaLayer, 0);

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
  timeSlider.mode = "instant";
  timeSlider.fullTimeExtent = {
    start: sliderDates[0],
    end: sliderDates[sliderDates.length - 1]
  };
  timeSlider.stops = {dates: sliderDates};
  timeSlider.timeExtent = {
    start: sliderDates[0],
    end: sliderDates[0]
  };
  timeSlider.labelsVisible = true;

  reactiveUtils.watch(
    () => timeSlider.widget.timeExtent,
    (te) => {
      const current = te?.start;
      if (!current) return;
      const idx = timeDates.findIndex((d) => d.getTime() === current.getTime());
      if (idx >= 0) updateMapToTimeStep(idx);
    }
  );

  // initial draw
  updateMapToTimeStep(firstValidStep);
}

const resetLayers = () => {
  sketchTool.layer.removeAll();
  boundaryLayer.visible = true;
  boundaryLayer.definitionExpression = "1=1"; // reset to none selected
  arcgisMap.view.goTo(boundaryLayer.fullExtent);
  timeSlider.widget.stop();
  timeseriesPlotDiv.innerHTML = appInstructions;
  const possiblyExistingLayer = arcgisMap.map.layers.find(l => l.title === "GRACE Anomalies");
  if (possiblyExistingLayer) arcgisMap.map.layers.remove(possiblyExistingLayer);
}

arcgisMap.addEventListener("arcgisViewReadyChange", async () => {
  await arcgisMap.map.when();
  await arcgisMap.view.when()
  arcgisMap.map.add(boundaryLayer);
  boundaryLayer.load().then(() => arcgisMap.view.goTo(boundaryLayer.fullExtent))

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

  document
    .querySelector("#info-button")
    .addEventListener("click", () => {
      document.getElementById("info-modal").classList.toggle("hidden");
    });

  // Close modal when clicking outside the content
  document.getElementById("info-modal").addEventListener("click", (e) => {
    if (e.target.id === "info-modal") {
      e.target.classList.add("hidden");
    }
  });

  document.querySelector("#settings-button").addEventListener("click", () => {
    settingsModal.classList.toggle("hidden");
  });

  document.getElementById("settings-close").addEventListener("click", () => {
    settingsModal.classList.add("hidden");
  });

  settingsModal.addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") {
      e.target.classList.add("hidden");
    }
  });

  // Function to update the anomaly layer renderer
  const updateAnomalyCellRenderers = () => {
    const anomalyLayer = arcgisMap.map.layers.find(l => l.title === "GRACE Anomalies");
    const field = anomalyLayer?.renderer?.visualVariables?.[0]?.field;
    if (!field) return;

    anomalyLayer.renderer = {
      type: "simple",
      symbol: {
        type: "simple-fill",
        outline: displayConfig.showBorders
          ? {color: [0, 0, 0, 1], width: displayConfig.borderWidth}
          : {color: [0, 0, 0, 0], width: 0}
      },
      legendOptions: {
        showLegend: false  // hide the polygon symbol in legend
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

  // Border toggle
  borderToggle.addEventListener("change", (e) => {
    displayConfig.showBorders = e.target.checked;
    updateAnomalyCellRenderers();
  });

  // Border width slider
  borderWidthSlider.addEventListener("input", (e) => {
    displayConfig.borderWidth = parseFloat(e.target.value);
    borderWidthValue.textContent = `${displayConfig.borderWidth}px`;
    updateAnomalyCellRenderers();
  });

  // Color palette radio buttons
  document.querySelectorAll('input[name="color-palette"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      displayConfig.colorPalette = e.target.value;
      updateAnomalyCellRenderers();
    });
  });

  // Dynamic color scale toggle
  dynamicScaleToggle.addEventListener("change", (e) => {
    displayConfig.dynamicColorScale = e.target.checked;
    updateAnomalyCellRenderers();
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

  uploadDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadDropZone.classList.add("drag-over");
  });

  uploadDropZone.addEventListener("dragleave", () => {
    uploadDropZone.classList.remove("drag-over");
  });

  uploadDropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadDropZone.classList.remove("drag-over");
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
