import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSector, type Snapshot, type SectorDetail } from "../lib/api";
import { deltaClass, divergingFill, isNum, money, pct } from "../lib/format";
import { Sparkline, Tooltip, type TipState } from "../components/charts";

const METRICS = [
  { id: "chg_1d", label: "1D", cap: 0.05 },
  { id: "chg_1w", label: "1W", cap: 0.1 },
  { id: "chg_1m", label: "1M", cap: 0.2 },
  { id: "chg_3m", label: "3M", cap: 0.35 },
  { id: "chg_ytd", label: "YTD", cap: 0.6 },
  { id: "chg_1y", label: "1Y", cap: 0.8 },
] as const;
type MetricId = (typeof METRICS)[number]["id"];

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** All companies reachable upstream and downstream from `t` (transitive). */
function chainOf(t: string, edges: [string, string][]) {
  const up = new Set<string>(), down = new Set<string>();
  const walk = (start: string, dir: "up" | "down", seen: Set<string>) => {
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const [a, b] of edges) {
        const next = dir === "up" ? (b === cur ? a : null) : a === cur ? b : null;
        if (next && !seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
  };
  walk(t, "up", up);
  walk(t, "down", down);
  return { up, down, all: new Set([t, ...up, ...down]) };
}

export function SupplyChain({ sectorId, onOpen }: { sectorId: string; onOpen: (t: string) => void }) {
  const { data, isLoading, error } = useSector(sectorId);
  const [metric, setMetric] = useState<MetricId>("chg_1m");
  const [sizeByCap, setSizeByCap] = useState(true);
  const [focus, setFocus] = useState<string | null>(null);

  if (isLoading) return <div className="skeleton" style={{ height: 560 }} />;
  if (error || !data) return <div className="error">Could not load sector: {String(error)}</div>;

  const cap = METRICS.find((m) => m.id === metric)!.cap;
  return (
    <div className="grid">
      <Header data={data} metric={metric} />
      <div className="card card-pad">
        <div className="row wrap" style={{ justifyContent: "space-between", marginBottom: 14, gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 16 }}>{data.name} value chain</h2>
            <div className="small muted" style={{ maxWidth: 720, marginTop: 2 }}>
              {data.description} Hover a company to trace its suppliers and customers; click to open it.
            </div>
          </div>
          <div className="row wrap" style={{ gap: 12 }}>
            <div className="row small muted">
              Colour by return
              <div className="seg">
                {METRICS.map((m) => (
                  <button key={m.id} aria-pressed={metric === m.id} onClick={() => setMetric(m.id)}>{m.label}</button>
                ))}
              </div>
            </div>
            <label className="row small muted" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={sizeByCap} onChange={(e) => setSizeByCap(e.target.checked)} /> Size by market cap
            </label>
          </div>
        </div>
        <ChainGraph data={data} metric={metric} cap={cap} sizeByCap={sizeByCap} focus={focus} setFocus={setFocus} onOpen={onOpen} />
        <div className="row small muted" style={{ marginTop: 12, gap: 10 }}>
          <span>−{Math.round(cap * 100)}%</span>
          <div className="legend-ramp" />
          <span>+{Math.round(cap * 100)}%</span>
          <span style={{ marginLeft: 12 }}>Lines = supplier → customer (edit in <code>config/sectors/{data.id}.yaml</code>)</span>
        </div>
      </div>
    </div>
  );
}

function Header({ data, metric }: { data: SectorDetail; metric: MetricId }) {
  const label = METRICS.find((m) => m.id === metric)!.label;
  const tiers = data.tiers.map((t) => {
    const vals = t.tickers.map((s) => data.companies[s]?.[metric]).filter(isNum);
    const caps = t.tickers.map((s) => data.companies[s]?.market_cap).filter(isNum);
    return { ...t, med: median(vals), cap: caps.reduce((a, b) => a + b, 0) };
  });
  const maxAbs = Math.max(0.01, ...tiers.map((t) => Math.abs(t.med ?? 0)));
  const [tip, setTip] = useState<TipState>(null);
  return (
    <div className="layout-3-1">
      <div className="card card-pad">
        <div className="card-title">Median {label} return by stage</div>
        <div style={{ display: "grid", gap: 6 }}>
          {tiers.map((t) => {
            const v = t.med ?? 0;
            const w = (Math.abs(v) / maxAbs) * 50;
            return (
              <div
                key={t.id} className="row" style={{ gap: 10 }}
                onMouseMove={(e) => setTip({
                  x: e.clientX, y: e.clientY,
                  content: (<>
                    <div className="tip-title">{t.name}</div>
                    <div className="tip-row"><span>Median {label}</span><b className="tnum">{pct(t.med)}</b></div>
                    <div className="tip-row"><span>Combined mkt cap</span><b className="tnum">{money(t.cap)}</b></div>
                    <div className="tip-row"><span>Companies</span><b>{t.tickers.length}</b></div>
                  </>),
                })}
                onMouseLeave={() => setTip(null)}
              >
                <div className="small" style={{ width: 170, flex: "none", color: "var(--ink-2)" }}>{t.name}</div>
                <div style={{ position: "relative", flex: 1, height: 18 }}>
                  <div style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1.5, background: "var(--axis)" }} />
                  <div style={{
                    position: "absolute", top: 2, height: 14, width: `${w}%`,
                    left: v >= 0 ? "50%" : `${50 - w}%`,
                    background: v >= 0 ? "var(--up)" : "var(--down)",
                    borderRadius: v >= 0 ? "0 4px 4px 0" : "4px 0 0 4px",
                  }} />
                </div>
                <div className={`small tnum ${deltaClass(t.med)}`} style={{ width: 56, textAlign: "right", fontWeight: 600 }}>{pct(t.med)}</div>
              </div>
            );
          })}
        </div>
        <Tooltip tip={tip} />
      </div>
      <div className="card card-pad">
        <div className="card-title">Benchmarks</div>
        <div style={{ display: "grid", gap: 12 }}>
          {data.benchmarks.map((b) => {
            const s = data.benchmark_snapshot[b];
            return (
              <div key={b} className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{b}</div>
                  <div className="tiny muted">{s?.name}</div>
                </div>
                <Sparkline values={s?.spark ?? []} width={90} height={26} />
                <div className={`tnum ${deltaClass(s?.[metric])}`} style={{ fontWeight: 600, width: 64, textAlign: "right" }}>{pct(s?.[metric])}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ChainGraph({
  data, metric, cap, sizeByCap, focus, setFocus, onOpen,
}: {
  data: SectorDetail; metric: MetricId; cap: number; sizeByCap: boolean; focus: string | null;
  setFocus: (t: string | null) => void; onOpen: (t: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [boxes, setBoxes] = useState<Record<string, DOMRect>>({});
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tip, setTip] = useState<TipState>(null);

  const caps = Object.values(data.companies).map((c) => c.market_cap).filter(isNum);
  const maxCap = Math.max(1, ...caps);
  const heightFor = (s?: Snapshot) => {
    if (!sizeByCap || !isNum(s?.market_cap)) return 74;
    return Math.round(64 + 76 * Math.sqrt(s!.market_cap! / maxCap));
  };

  // measure node positions to draw edges; re-measure on resize
  useLayoutEffect(() => {
    const measure = () => {
      const root = wrap.current;
      if (!root) return;
      const r0 = root.getBoundingClientRect();
      const out: Record<string, DOMRect> = {};
      for (const [t, el] of Object.entries(nodeRefs.current)) {
        if (!el) continue;
        const r = el.getBoundingClientRect();
        out[t] = new DOMRect(r.left - r0.left, r.top - r0.top, r.width, r.height);
      }
      setBoxes(out);
      setSize({ w: root.scrollWidth, h: root.scrollHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [data, sizeByCap]);

  const chain = useMemo(() => (focus ? chainOf(focus, data.edges) : null), [focus, data.edges]);

  const tierIndex = useMemo(() => {
    const m: Record<string, number> = {};
    data.tiers.forEach((t, i) => t.tickers.forEach((s) => (m[s] = i)));
    return m;
  }, [data.tiers]);

  return (
    <div className="chain-scroll">
      <div className="chain" ref={wrap} style={{ minWidth: data.tiers.length * 156 }} onMouseLeave={() => setFocus(null)}>
        <svg className="edges" width={size.w} height={size.h}>
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0L8,4L0,8z" fill="var(--ink-2)" />
            </marker>
          </defs>
          {data.edges.map(([a, b]) => {
            const A = boxes[a], B = boxes[b];
            if (!A || !B) return null;
            const forward = tierIndex[b] > tierIndex[a];
            const x1 = forward ? A.right : A.left + A.width / 2;
            const y1 = forward ? A.top + A.height / 2 : A.bottom;
            const x2 = forward ? B.left : B.left + B.width / 2;
            const y2 = forward ? B.top + B.height / 2 : B.top;
            const dx = Math.max(30, (x2 - x1) / 2);
            const d = forward
              ? `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
              : `M${x1},${y1} C${x1 + 40},${y1 + 20} ${x2 + 40},${y2 - 20} ${x2},${y2}`;
            const active = chain && chain.all.has(a) && chain.all.has(b) &&
              (a === focus || b === focus || (chain.up.has(a) && (chain.up.has(b) || b === focus)) || (chain.down.has(b) && (chain.down.has(a) || a === focus)));
            return (
              <path
                key={`${a}-${b}`} d={d} fill="none"
                stroke={active ? "var(--ink-1)" : "var(--ink-3)"}
                strokeOpacity={chain ? (active ? 0.85 : 0.05) : 0.22}
                strokeWidth={active ? 2 : 1.25}
                markerEnd={active ? "url(#arrow)" : undefined}
              />
            );
          })}
        </svg>
        {data.tiers.map((tier) => {
          const vals = tier.tickers.map((t) => data.companies[t]?.[metric]).filter(isNum);
          const med = median(vals);
          return (
            <div className="tier" key={tier.id}>
              <div className="tier-head">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="name">{tier.name}</span>
                  <span className={`small tnum ${deltaClass(med)}`} style={{ fontWeight: 600 }}>{pct(med)}</span>
                </div>
                <div className="desc">{tier.description}</div>
              </div>
              {tier.tickers.map((t) => {
                const s = data.companies[t];
                const v = s?.[metric];
                const dim = chain && !chain.all.has(t);
                return (
                  <div
                    key={t}
                    ref={(el) => { nodeRefs.current[t] = el; }}
                    className={`node ${dim ? "dim" : ""} ${focus === t ? "focus" : ""}`}
                    style={{ background: divergingFill(v, cap), height: heightFor(s) }}
                    onMouseEnter={() => setFocus(t)}
                    onMouseMove={(e) => setTip({
                      x: e.clientX, y: e.clientY,
                      content: <NodeTip s={s} t={t} supp={data.edges.filter(([, b]) => b === t).map(([a]) => a)} cust={data.edges.filter(([a]) => a === t).map(([, b]) => b)} />,
                    })}
                    onMouseLeave={() => setTip(null)}
                    onClick={() => onOpen(t)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && onOpen(t)}
                    aria-label={`${t} ${s?.name ?? ""} ${pct(v)}`}
                  >
                    <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                      <span className="tk">{t}</span>
                      <span className="chg tnum">{pct(v)}</span>
                    </div>
                    <div className="nm">{s?.name ?? "—"}</div>
                    {heightFor(s) > 86 && <Sparkline values={s?.spark ?? []} width={124} height={Math.min(36, heightFor(s) - 70)} color="var(--ink-2)" />}
                    <div className="mc tnum">{money(s?.market_cap, 0)}</div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

function NodeTip({ s, t, supp, cust }: { s?: Snapshot; t: string; supp: string[]; cust: string[] }) {
  return (
    <div style={{ minWidth: 200 }}>
      <div className="tip-title">{t} <span className="muted">· {s?.name}</span></div>
      {(["chg_1d", "chg_1m", "chg_ytd", "chg_1y"] as const).map((k) => (
        <div className="tip-row" key={k}><span>{k.replace("chg_", "").toUpperCase()}</span><b className={`tnum ${deltaClass(s?.[k])}`}>{pct(s?.[k])}</b></div>
      ))}
      <div className="tip-row"><span>Mkt cap</span><b className="tnum">{money(s?.market_cap)}</b></div>
      <div className="tip-row"><span>P/E · Fwd</span><b className="tnum">{s?.pe?.toFixed(1) ?? "—"} · {s?.fwd_pe?.toFixed(1) ?? "—"}</b></div>
      {supp.length > 0 && <div className="tiny muted" style={{ marginTop: 4 }}>Suppliers: {supp.join(", ")}</div>}
      {cust.length > 0 && <div className="tiny muted">Customers: {cust.join(", ")}</div>}
    </div>
  );
}
