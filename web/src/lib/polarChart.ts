/** Draws a small line plot with a faint zero-line (Cl/Cd/Cm all have
 * physically meaningful signs) and an emphasized marker at the trim point,
 * if one is known and falls within the plotted alpha range. Pure canvas
 * drawing, no React -- kept separate from the component so the chart logic
 * is trivially testable/reusable outside a component's render cycle. */
export function drawPolarSeries(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  xs: number[],
  ys: number[],
  opts: { color: string; trimAlphaDeg?: number },
) {
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (xs.length < 2) return;

  const padL = 4;
  const padR = 4;
  const padT = 6;
  const padB = 6;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const xMin = xs[0];
  const xMax = xs[xs.length - 1];
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (yMax - yMin < 1e-9) {
    yMin -= 0.5;
    yMax += 0.5;
  }
  const ySpan = yMax - yMin;
  yMin -= ySpan * 0.1;
  yMax += ySpan * 0.1;

  const toX = (x: number) => padL + ((x - xMin) / (xMax - xMin)) * plotW;
  const toY = (y: number) => padT + plotH - ((y - yMin) / (yMax - yMin)) * plotH;

  if (yMin < 0 && yMax > 0) {
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const zy = toY(0);
    ctx.moveTo(padL, zy);
    ctx.lineTo(padL + plotW, zy);
    ctx.stroke();
  }

  ctx.strokeStyle = opts.color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  xs.forEach((x, i) => {
    const px = toX(x);
    const py = toY(ys[i]);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  if (opts.trimAlphaDeg !== undefined && opts.trimAlphaDeg >= xMin && opts.trimAlphaDeg <= xMax) {
    let i = 0;
    while (i < xs.length - 1 && xs[i + 1] < opts.trimAlphaDeg) i++;
    const x0 = xs[i], x1 = xs[Math.min(i + 1, xs.length - 1)];
    const y0 = ys[i], y1 = ys[Math.min(i + 1, xs.length - 1)];
    const t = x1 > x0 ? (opts.trimAlphaDeg - x0) / (x1 - x0) : 0;
    const y = y0 + (y1 - y0) * t;
    ctx.fillStyle = "#ffe0a0";
    ctx.beginPath();
    ctx.arc(toX(opts.trimAlphaDeg), toY(y), 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
