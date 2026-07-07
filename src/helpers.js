export function meanIgnoringNaN(data, shape, stride) {
  const [T, Y, X] = shape;
  const [sT, sY, sX] = stride;

  const result = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    let sum = 0;
    let count = 0;
    const tOffset = t * sT;
    for (let y = 0; y < Y; y++) {
      const yOffset = tOffset + y * sY;
      for (let x = 0; x < X; x++) {
        const v = data[yOffset + x * sX];
        if (!Number.isNaN(v)) {
          sum += v;
          count++;
        }
      }
    }
    result[t] = count > 0 ? sum / count : NaN;
  }
  return result;
}

export function createUncertaintyBand({x, yArray, uncertaintyArray, color, name}) {
  const y = Array.from(yArray);
  const unc = Array.from(uncertaintyArray);

  // Drop NaN samples (missing GRACE months + the GRACE/GRACE-FO gap) and build
  // one continuous polygon over the remaining valid points, so the band bridges
  // gaps with a straight interpolation instead of breaking.
  const xv = [];
  const upper = [];
  const lower = [];
  for (let i = 0; i < y.length; i++) {
    if (!Number.isFinite(y[i]) || !Number.isFinite(unc[i])) continue;
    xv.push(x[i]);
    upper.push(y[i] + unc[i]);
    lower.push(y[i] - unc[i]);
  }

  return {
    x: xv.concat(xv.slice().reverse()),
    y: upper.concat(lower.reverse()),
    fill: "toself",
    fillcolor: color,
    line: {color: "rgba(255,255,255,0)"},
    name: `${name} Uncertainty`,
    showlegend: false,
    legendgroup: name
  }
}

export function createLinePlot({x, y, color, name, uncertainty}) {
  const yv = Array.from(y);
  const uncv = uncertainty ? Array.from(uncertainty) : null;

  // Drop NaN samples so the line draws a straight segment across data gaps
  // rather than breaking. Per-point uncertainty travels with the line (as
  // customdata) so the CSV export can rebuild upper/lower bounds.
  const xf = [];
  const yf = [];
  const cf = uncv ? [] : undefined;
  for (let i = 0; i < yv.length; i++) {
    if (!Number.isFinite(yv[i])) continue;
    xf.push(x[i]);
    yf.push(yv[i]);
    if (cf) cf.push(uncv[i]);
  }

  return {
    x: xf,
    y: yf,
    customdata: cf,
    mode: "lines",
    name,
    line: {color},
    legendgroup: name
  }
}
