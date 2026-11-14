/* Small dependency-free SVG chart kit: line, grouped bar, scatter, sparkline.
   Thin marks, recessive axes, a hover layer on every chart, single y-axis only. */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isNum } from "../lib/format";

// ------------------------------------------------------------------ utilities

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceStep(span: number, count: number) {
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n >= 5 ? 10 : n >= 2 ? 5 : n >= 1 ? 2 : 1) * mag;
}

export function niceDomain(vals: number[], includeZero = true, count = 5): { lo: number; hi: number; ticks: number[] } {
  let lo = Math.min(...vals, includeZero ? 0 : Infinity);
  let hi = Math.max(...vals, includeZero ? 0 : -Infinity);
  if (!isFinite(lo) || !isFinite(hi)) return { lo: 0, hi: 1, ticks: [0, 1] };
  if (lo === hi) { lo -= 1; hi += 1; }
  const step = niceStep(hi - lo, count);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(12));
  return { lo, hi, ticks };
}

const lin = (d0: number, d1: number, r0: number, r1: number) => (v: number) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

export type TipState = { x: number; y: number; content: ReactNode } | null;

export function Tooltip({ tip }: { tip: TipState }) {
  if (!tip) return null;
  const left = Math.min(tip.x + 14, window.innerWidth - 240);
  const top = Math.min(tip.y + 14, window.innerHeight - 160);
  return <div className="tip" style={{ left, top }}>{tip.content}</div>;
}

export function Legend({ items }: { items: { label: string; color: string; dash?: boolean }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}>
          <i className="swatch line" style={{ background: i.dash ? `repeating-linear-gradient(90deg, ${i.color} 0 4px, transparent 4px 6px)` : i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

const M = { top: 10, right: 24, bottom: 26, left: 52 };

// ------------------------------------------------------------------ sparkline

export function Sparkline({ values, width = 120, height = 28, color }: { values: number[]; width?: number; height?: number; color?: string }) {
  if (!values || values.length < 2) return <svg width={width} height={height} />;
  const lo = Math.min(...values), hi = Math.max(...values);
  const x = lin(0, values.length - 1, 1, width - 1);
  const y = lin(lo, hi, height - 2, 2);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const c = color ?? (values[values.length - 1] >= values[0] ? "var(--pos-ink)" : "var(--neg-ink)");
  return (
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }} aria-hidden>
      <path d={d} fill="none" stroke={c} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ------------------------------------------------------------------ line chart

export type LineSeries = { id: string; label: string; color: string; values: (number | null)[]; dash?: boolean };

export function LineChart({
  x, series, height = 240, yFormat, xFormat = (s) => s, baseline,
}: {
  x: string[]; series: LineSeries[]; height?: number; yFormat: (v: number) => string; xFormat?: (s: string) => string; baseline?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [tip, setTip] = useState<TipState>(null);
  const all = series.flatMap((s) => s.values.filter(isNum));
  const dom = niceDomain(baseline !== undefined ? [...all, baseline] : all, false);
  const iw = Math.max(10, width - M.left - M.right);
  const ih = height - M.top - M.bottom;
  const sx = lin(0, Math.max(1, x.length - 1), 0, iw);
  const sy = lin(dom.lo, dom.hi, ih, 0);
  const xTicks = useMemo(() => {
    const n = Math.max(2, Math.min(x.length, Math.floor(iw / 80)));
    const step = Math.max(1, Math.round((x.length - 1) / (n - 1)));
    const out: number[] = [];
    for (let i = 0; i < x.length; i += step) out.push(i);
    return out;
  }, [x.length, iw]);

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (x.length - 1));
    const idx = Math.max(0, Math.min(x.length - 1, i));
    setHover(idx);
    setTip({
      x: e.clientX, y: e.clientY,
      content: (
        <>
          <div className="tip-title">{xFormat(x[idx])}</div>
          {series.map((s) => (
            <div className="tip-row" key={s.id}>
              <span className="row"><i className="swatch line" style={{ background: s.color }} />{s.label}</span>
              <b className="tnum">{isNum(s.values[idx]) ? yFormat(s.values[idx] as number) : "—"}</b>
            </div>
          ))}
        </>
      ),
    });
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      {width > 0 && (
        <svg width={width} height={height} role="img">
          <g transform={`translate(${M.left},${M.top})`}>
            {dom.ticks.map((t) => (
              <g key={t}>
                <line x1={0} x2={iw} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" />
                <text x={-8} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--ink-3)" className="tnum">{yFormat(t)}</text>
              </g>
            ))}
            {baseline !== undefined && <line x1={0} x2={iw} y1={sy(baseline)} y2={sy(baseline)} stroke="var(--axis)" strokeWidth={1.5} />}
            {xTicks.map((i) => (
              <text key={i} x={sx(i)} y={ih + 18} textAnchor="middle" fontSize={11} fill="var(--ink-3)">{xFormat(x[i])}</text>
            ))}
            {series.map((s) => {
              let d = "";
              let pen = false;
              s.values.forEach((v, i) => {
                if (!isNum(v)) { pen = false; return; }
                d += `${pen ? "L" : "M"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`;
                pen = true;
              });
              return <path key={s.id} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash ? "5 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />;
            })}
            {hover !== null && (
              <g>
                <line x1={sx(hover)} x2={sx(hover)} y1={0} y2={ih} stroke="var(--axis)" />
                {series.map((s) => isNum(s.values[hover]) && (
                  <circle key={s.id} cx={sx(hover)} cy={sy(s.values[hover] as number)} r={4} fill={s.color} stroke="var(--surface-1)" strokeWidth={2} />
                ))}
              </g>
            )}
            <rect width={iw} height={ih} fill="transparent" onMouseMove={onMove} onMouseLeave={() => { setHover(null); setTip(null); }} />
          </g>
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

// ------------------------------------------------------------------ grouped bar chart

export type BarSeries = { id: string; label: string; color: string; values: (number | null)[] };

function barPath(x: number, w: number, y0: number, y1: number, r = 4) {
  // rounded on the data end, square at the baseline
  const up = y1 < y0;
  const h = Math.abs(y1 - y0);
  const rr = Math.min(r, w / 2, h);
  if (h < 0.5) return "";
  if (up) {
    return `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 + rr}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 - rr}V${y0}Z`;
}

export function BarChart({
  categories, series, height = 220, yFormat, xFormat = (s) => s,
}: {
  categories: string[]; series: BarSeries[]; height?: number; yFormat: (v: number) => string; xFormat?: (s: string) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState>(null);
  const [hi, setHi] = useState<number | null>(null);
  const all = series.flatMap((s) => s.values.filter(isNum));
  const dom = niceDomain(all.length ? all : [0, 1], true);
  const iw = Math.max(10, width - M.left - M.right);
  const ih = height - M.top - M.bottom;
  const sy = lin(dom.lo, dom.hi, ih, 0);
  const band = iw / Math.max(1, categories.length);
  const inner = band * 0.72;
  const bw = Math.max(2, (inner - (series.length - 1) * 2) / series.length);
  const every = Math.max(1, Math.ceil(categories.length / Math.max(1, Math.floor(iw / 64))));

  return (
    <div ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img">
          <g transform={`translate(${M.left},${M.top})`}>
            {dom.ticks.map((t) => (
              <g key={t}>
                <line x1={0} x2={iw} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" />
                <text x={-8} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--ink-3)" className="tnum">{yFormat(t)}</text>
              </g>
            ))}
            {categories.map((c, ci) => {
              const x0 = ci * band + (band - inner) / 2;
              return (
                <g key={c} opacity={hi === null || hi === ci ? 1 : 0.55}>
                  {series.map((s, si) => {
                    const v = s.values[ci];
                    if (!isNum(v)) return null;
                    return <path key={s.id} d={barPath(x0 + si * (bw + 2), bw, sy(0), sy(v))} fill={s.color} />;
                  })}
                  {ci % every === 0 && (
                    <text x={ci * band + band / 2} y={ih + 18} textAnchor="middle" fontSize={11} fill="var(--ink-3)">{xFormat(c)}</text>
                  )}
                  <rect
                    x={ci * band} width={band} y={0} height={ih} fill="transparent"
                    onMouseMove={(e) => {
                      setHi(ci);
                      setTip({
                        x: e.clientX, y: e.clientY,
                        content: (
                          <>
                            <div className="tip-title">{xFormat(c)}</div>
                            {series.map((s) => (
                              <div className="tip-row" key={s.id}>
                                <span className="row"><i className="swatch" style={{ background: s.color }} />{s.label}</span>
                                <b className="tnum">{isNum(s.values[ci]) ? yFormat(s.values[ci] as number) : "—"}</b>
                              </div>
                            ))}
                          </>
                        ),
                      });
                    }}
                    onMouseLeave={() => { setHi(null); setTip(null); }}
                  />
                </g>
              );
            })}
            <line x1={0} x2={iw} y1={sy(0)} y2={sy(0)} stroke="var(--axis)" strokeWidth={1.5} />
          </g>
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

// ------------------------------------------------------------------ scatter

export type ScatterPoint = { x: number; y: number; label: string; sub?: string; emphasis?: number; key: string };

export function Scatter({
  points, height = 340, xFormat, yFormat, fit, xLabel, yLabel, showLabels = false, onClick,
}: {
  points: ScatterPoint[]; height?: number; xFormat: (v: number) => string; yFormat: (v: number) => string;
  fit?: { slope: number | null; intercept: number | null }; xLabel: string; yLabel: string; showLabels?: boolean;
  onClick?: (p: ScatterPoint) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState>(null);
  const [hov, setHov] = useState<string | null>(null);
  const m = { ...M, bottom: 40, left: 60 };
  // clip axes to the 1st-99th percentile so one outlier doesn't flatten the cloud
  const clip = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b);
    if (s.length < 30) return s;
    return [s[Math.floor(s.length * 0.01)], s[Math.ceil(s.length * 0.99) - 1]];
  };
  const xd = niceDomain(clip(points.map((p) => p.x)), false);
  const yd = niceDomain(clip(points.map((p) => p.y)), true);
  const iw = Math.max(10, width - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const sx = lin(xd.lo, xd.hi, 0, iw);
  const sy = lin(yd.lo, yd.hi, ih, 0);
  const inside = (p: ScatterPoint) => p.x >= xd.lo && p.x <= xd.hi && p.y >= yd.lo && p.y <= yd.hi;

  return (
    <div ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img">
          <g transform={`translate(${m.left},${m.top})`}>
            {yd.ticks.map((t) => (
              <g key={`y${t}`}>
                <line x1={0} x2={iw} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={t === 0 ? 1.5 : 1} />
                <text x={-8} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--ink-3)">{yFormat(t)}</text>
              </g>
            ))}
            {xd.ticks.map((t) => (
              <text key={`x${t}`} x={sx(t)} y={ih + 18} textAnchor="middle" fontSize={11} fill="var(--ink-3)">{xFormat(t)}</text>
            ))}
            <text x={iw / 2} y={ih + 36} textAnchor="middle" fontSize={12} fill="var(--ink-2)">{xLabel} →</text>
            <text transform={`translate(${-48},${ih / 2}) rotate(-90)`} textAnchor="middle" fontSize={12} fill="var(--ink-2)">{yLabel} →</text>
            {fit && isNum(fit.slope) && isNum(fit.intercept) && (
              <line
                x1={0} x2={iw}
                y1={sy(Math.max(yd.lo, Math.min(yd.hi, fit.intercept + fit.slope * xd.lo)))}
                y2={sy(Math.max(yd.lo, Math.min(yd.hi, fit.intercept + fit.slope * xd.hi)))}
                stroke="var(--s2)" strokeWidth={2} strokeDasharray="6 4"
              />
            )}
            {points.filter(inside).map((p) => {
              const active = hov === p.label;
              return (
                <g key={p.key}>
                  <circle
                    cx={sx(p.x)} cy={sy(p.y)} r={active ? 6 : 4.5}
                    fill="var(--s1)" fillOpacity={hov && !active ? 0.15 : 0.25 + 0.6 * (p.emphasis ?? 1)}
                    stroke="var(--surface-1)" strokeWidth={1.5}
                  />
                  {showLabels && (
                    <text x={sx(p.x) + 7} y={sy(p.y)} dy="0.32em" fontSize={11} fill="var(--ink-2)">{p.label}</text>
                  )}
                  <circle
                    cx={sx(p.x)} cy={sy(p.y)} r={10} fill="transparent" style={{ cursor: onClick ? "pointer" : "default" }}
                    onClick={() => onClick?.(p)}
                    onMouseMove={(e) => {
                      setHov(p.label);
                      setTip({
                        x: e.clientX, y: e.clientY,
                        content: (
                          <>
                            <div className="tip-title">{p.label}{p.sub ? <span className="muted"> · {p.sub}</span> : null}</div>
                            <div className="tip-row"><span>{xLabel}</span><b className="tnum">{xFormat(p.x)}</b></div>
                            <div className="tip-row"><span>{yLabel}</span><b className="tnum">{yFormat(p.y)}</b></div>
                          </>
                        ),
                      });
                    }}
                    onMouseLeave={() => { setHov(null); setTip(null); }}
                  />
                </g>
              );
            })}
          </g>
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}
