import {
  Chart,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  TimeScale,
  Title,
  Tooltip,
} from "chart.js";
import "chartjs-adapter-date-fns";

// Explicit registration instead of chart.js/auto: this chart is one line plus a
// filled uncertainty band, so pulling in every controller (bar, pie, radar,
// scatter…) would be dead weight in the bundle.
Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Filler, Title, Tooltip, Legend);

// Vertical rule marking the month the map is currently showing. This is the
// replacement for the Plotly shape that used to be pushed with relayout(); as a
// plugin it draws straight onto the canvas with no data-structure churn, so
// scrubbing the time slider costs one repaint instead of a chart rebuild.
const timeMarkerPlugin = {
  id: "timeMarker",
  afterDatasetsDraw(chart) {
    const at = chart.$timeMarker;
    if (at == null) return;
    const x = chart.scales.x.getPixelForValue(at);
    if (!Number.isFinite(x)) return;
    const {top, bottom, left, right} = chart.chartArea;
    if (x < left || x > right) return;
    const {ctx} = chart;
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ef4444";
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};
Chart.register(timeMarkerPlugin);

const LINE_COLOR = "#1c6eec";
const BAND_COLOR = "rgba(28,110,236,0.25)";

const toCsv = ({dates, values, uncertainty, name}) => {
  const header = uncertainty ? ["Date", name, `${name}_upper`, `${name}_lower`] : ["Date", name];
  const rows = [header.join(",")];
  for (let i = 0; i < dates.length; i++) {
    const center = values[i];
    if (!Number.isFinite(center)) continue; // missing GRACE months stay out of the file
    const cells = [dates[i].toISOString().split("T")[0], center];
    if (uncertainty) {
      const unc = uncertainty[i];
      const hasBand = Number.isFinite(unc);
      cells.push(hasBand ? center + unc : "", hasBand ? center - unc : "");
    }
    rows.push(cells.join(","));
  }
  return rows.join("\n");
};

const downloadCsv = (csv, filename) => {
  const blob = new Blob([csv], {type: "text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

/**
 * Render the area-mean time series into `container`, replacing whatever it held.
 *
 * Returns {setMarker(date), destroy()}. NaN samples (missing GRACE months and
 * the GRACE/GRACE-FO gap) are dropped rather than plotted, so the line bridges
 * gaps with a straight segment — the same behavior the Plotly version had.
 */
export function renderTimeseriesChart({container, dates, values, uncertainty, name, longName, fileStem}) {
  const line = [];
  const upper = [];
  const lower = [];
  for (let i = 0; i < dates.length; i++) {
    const y = values[i];
    if (!Number.isFinite(y)) continue;
    line.push({x: dates[i], y});
    const unc = uncertainty?.[i];
    if (Number.isFinite(unc)) {
      upper.push({x: dates[i], y: y + unc});
      lower.push({x: dates[i], y: y - unc});
    }
  }
  const hasBand = upper.length > 0;

  container.replaceChildren();
  const wrapper = document.createElement("div");
  wrapper.className = "ts-chart";
  const canvasBox = document.createElement("div");
  canvasBox.className = "ts-chart-canvas";
  const canvas = document.createElement("canvas");
  canvasBox.append(canvas);

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.className = "ts-download";
  downloadButton.textContent = "Download CSV";
  downloadButton.title = `Download the plotted ${longName} time series as CSV`;
  downloadButton.addEventListener("click", () =>
    downloadCsv(toCsv({dates, values, uncertainty, name}), `${fileStem}_data.csv`),
  );

  wrapper.append(canvasBox, downloadButton);
  container.append(wrapper);

  const datasets = [];
  if (hasBand) {
    // Band drawn as an upper series filled down to the lower series. Chart.js
    // draws datasets in reverse `order`, so the band's higher order puts it
    // behind the line rather than painting over it.
    datasets.push(
      {
        label: `${name} Uncertainty`,
        data: upper,
        borderWidth: 0,
        pointRadius: 0,
        backgroundColor: BAND_COLOR,
        fill: {target: 1},
        order: 1,
      },
      {
        label: `${name} Uncertainty Lower`,
        data: lower,
        borderWidth: 0,
        pointRadius: 0,
        fill: false,
        order: 1,
      },
    );
  }
  datasets.push({
    label: name,
    data: line,
    borderColor: LINE_COLOR,
    borderWidth: 2,
    pointRadius: 0,
    pointHitRadius: 8,
    fill: false,
    order: 0,
  });

  const chart = new Chart(canvas, {
    type: "line",
    data: {datasets},
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false, // the slider redraws this constantly; tweening just smears
      parsing: false, // data is already {x, y} with Date x values
      normalized: true,
      interaction: {mode: "nearest", axis: "x", intersect: false},
      scales: {
        x: {
          type: "time",
          time: {unit: "year", tooltipFormat: "MMM yyyy"},
          title: {display: true, text: "Time", color: "#333", font: {size: 12}},
          ticks: {color: "#333", maxRotation: 0, autoSkip: true},
          grid: {color: "rgba(0,0,0,0.06)"},
        },
        y: {
          title: {display: true, text: "Liquid Water Equivalent (cm)", color: "#333", font: {size: 12}},
          ticks: {color: "#333"},
          grid: {color: "rgba(0,0,0,0.06)"},
        },
      },
      plugins: {
        title: {
          display: true,
          text: `${longName} Time Series${hasBand ? " and Uncertainty" : ""}`,
          color: "#333",
          font: {size: 14, weight: "bold"},
        },
        legend: {display: false},
        tooltip: {
          // Only the line carries a meaningful reading; the two band series
          // would otherwise add two noise rows to every tooltip.
          filter: (item) => item.datasetIndex === datasets.length - 1,
          callbacks: {
            label: (item) => `${name}: ${item.parsed.y.toFixed(2)} cm`,
          },
        },
      },
    },
  });

  return {
    setMarker(date) {
      chart.$timeMarker = date ?? null;
      chart.update("none");
    },
    destroy() {
      chart.destroy();
    },
  };
}
