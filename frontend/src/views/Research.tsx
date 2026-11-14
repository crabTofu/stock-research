import { useEffect, useMemo, useState } from "react";
import { useFactors, useResearch, useSector, type Factor, type ResearchParams, type ResearchResult } from "../lib/api";
import { deltaClass, factor, isNum, num, pct, shortDate } from "../lib/format";
import { BarChart, Legend, LineChart, Scatter } from "../components/charts";

const HORIZONS = [[1, "1M"], [3, "1Q"], [6, "2Q"], [12, "1Y"]] as const;
const LOOKBACKS = [1, 2, 3, 5, 8];

const COLORS = { in: "var(--s1)", out: "var(--s2)", universe: "var(--s3)", bench: "var(--ink-3)" };

function quantile(xs: number[], q: number) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function strength(r: number | null) {
  if (!isNum(r)) return "n/a";
  const a = Math.abs(r);
  const dir = r > 0 ? "positive" : "negative";
  if (a < 0.1) return "no meaningful";
  if (a < 0.3) return `a weak ${dir}`;
  if (a < 0.5) return `a moderate ${dir}`;
  return `a strong ${dir}`;
}

export function Research({ sectorId, onOpen }: { sectorId: string; onOpen: (t: string) => void }) {
  const { data: catalog } = useFactors();
  const { data: sector } = useSector(sectorId);
  const [p, setP] = useState<ResearchParams>({
    x: "ocf_margin", y: "fwd_excess", sector: sectorId, tiers: [], benchmark: "QQQ",
    horizon_months: 3, lookback_years: 3, cohort: "quantile", quantile: 0.5, threshold: null, op: ">",
    higher_is_better: true, winsorize: true,
  });
  // threshold is typed in display units (% for percentage factors)
  const [thrText, setThrText] = useState("");
  useEffect(() => { setP((o) => ({ ...o, sector: sectorId, tiers: [] })); }, [sectorId]);
  useEffect(() => { if (sector) setP((o) => ({ ...o, benchmark: o.benchmark || sector.default_benchmark })); }, [sector]);

  const xf = catalog?.factors.find((f) => f.id === p.x);
  const yf = catalog?.factors.find((f) => f.id === p.y) ?? catalog?.targets.find((f) => f.id === p.y);

  // debounce so typing a threshold doesn't fire a run per keystroke
  const [debounced, setDebounced] = useState(p);
  useEffect(() => { const id = setTimeout(() => setDebounced(p), 250); return () => clearTimeout(id); }, [p]);
  const { data: res, error, isFetching } = useResearch(catalog ? debounced : null);

  const set = <K extends keyof ResearchParams>(k: K, v: ResearchParams[K]) => setP((o) => ({ ...o, [k]: v }));
  const groups = useMemo(() => {
    const g: Record<string, Factor[]> = {};
    catalog?.factors.forEach((f) => (g[f.group] ??= []).push(f));
    return g;
  }, [catalog]);

  return (
    <div className="grid">
      <div className="card card-pad">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <h2 style={{ fontSize: 16 }}>Factor research</h2>
            <div className="small muted">Does a company characteristic, observed when it was public, tell you anything about what happened next?</div>
          </div>
          {isFetching && <span className="small muted">running…</span>}
          {res && !isFetching && <span className="tiny muted">{res.elapsed_ms} ms</span>}
        </div>
        <div className="controls">
          <label className="field">Variable (X)
            <select value={p.x} onChange={(e) => set("x", e.target.value)}>
              {Object.entries(groups).map(([g, fs]) => (
                <optgroup key={g} label={g}>{fs.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</optgroup>
              ))}
            </select>
          </label>
          <label className="field">Compared with (Y)
            <select value={p.y} onChange={(e) => set("y", e.target.value)}>
              <optgroup label="Outcome">{catalog?.targets.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</optgroup>
              {Object.entries(groups).map(([g, fs]) => (
                <optgroup key={g} label={g}>{fs.filter((f) => f.id !== p.x).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</optgroup>
              ))}
            </select>
          </label>
          <label className="field">Benchmark
            <select value={p.benchmark} onChange={(e) => set("benchmark", e.target.value)}>
              {(catalog?.benchmarks ?? ["SPY"]).map((b) => <option key={b}>{b}</option>)}
            </select>
          </label>
          <div className="field">Holding period
            <div className="seg">{HORIZONS.map(([h, l]) => <button key={h} aria-pressed={p.horizon_months === h} onClick={() => set("horizon_months", h)}>{l}</button>)}</div>
          </div>
          <div className="field">Look back
            <div className="seg">{LOOKBACKS.map((y) => <button key={y} aria-pressed={p.lookback_years === y} onClick={() => set("lookback_years", y)}>{y}Y</button>)}</div>
          </div>
          <div className="field" style={p.y.startsWith("fwd") ? undefined : { display: "none" }}>Screen
            <div className="row">
              <select value={p.cohort === "threshold" ? "threshold" : p.higher_is_better ? "top" : "bottom"} onChange={(e) => {
                const v = e.target.value;
                setP((o) => ({ ...o, cohort: v === "threshold" ? "threshold" : "quantile", higher_is_better: v !== "bottom" }));
              }}>
                <option value="top">Top</option>
                <option value="bottom">Bottom</option>
                <option value="threshold">X is</option>
              </select>
              {p.cohort === "quantile" ? (
                <select value={p.quantile} onChange={(e) => set("quantile", +e.target.value)}>
                  {[0.2, 0.25, 0.33, 0.5].map((q) => <option key={q} value={q}>{Math.round(q * 100)}%</option>)}
                </select>
              ) : (
                <>
                  <select value={p.op} onChange={(e) => set("op", e.target.value)}>{[">", ">=", "<", "<="].map((o) => <option key={o}>{o}</option>)}</select>
                  <input type="number" style={{ width: 80 }} value={thrText} placeholder={xf?.unit === "pct" ? "e.g. 20" : "e.g. 1.5"}
                    onChange={(e) => {
                      setThrText(e.target.value);
                      const n = parseFloat(e.target.value);
                      set("threshold", Number.isFinite(n) ? (xf?.unit === "pct" ? n / 100 : n) : null);
                    }} />
                  <span className="small muted">{xf?.unit === "pct" ? "%" : "×"}</span>
                </>
              )}
            </div>
          </div>
        </div>
        {sector && (
          <div className="row wrap" style={{ marginTop: 12, gap: 6 }}>
            <span className="small muted" style={{ marginRight: 4 }}>Universe:</span>
            <button className="chip" aria-pressed={p.tiers.length === 0} onClick={() => set("tiers", [])}>All {sector.name}</button>
            {sector.tiers.map((t) => (
              <button key={t.id} className="chip" aria-pressed={p.tiers.includes(t.id)}
                onClick={() => set("tiers", p.tiers.includes(t.id) ? p.tiers.filter((x) => x !== t.id) : [...p.tiers, t.id])}>
                {t.name} <span className="muted">{t.tickers.length}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <div className="error">{String((error as Error).message)}</div>}
      {!res ? (!error && <div className="skeleton" style={{ height: 400 }} />) : (
        <Results res={res} p={debounced} xf={xf} yf={yf} onOpen={onOpen} />
      )}
    </div>
  );
}

function Results({ res, p, xf, yf, onOpen }: { res: ResearchResult; p: ResearchParams; xf?: Factor; yf?: Factor; onOpen: (t: string) => void }) {
  const xFmt = (v: number) => factor(v, res.x.unit);
  const yFmt = (v: number) => factor(v, res.y.unit, res.y.id.startsWith("fwd"));
  const c = res.cohort;
  const hz = HORIZONS.find(([h]) => h === p.horizon_months)?.[1] ?? `${p.horizon_months}M`;
  const screenLabel = p.cohort === "threshold" && isNum(p.threshold)
    ? `companies with ${(xf?.label ?? p.x).toLowerCase()} ${p.op} ${factor(p.threshold, res.x.unit)}`
    : `the ${p.higher_is_better ? "top" : "bottom"} ${Math.round(p.quantile * 100)}% by ${xf?.label?.toLowerCase() ?? p.x}`;

  // which companies pass the screen today
  const cur = res.current.filter((r) => isNum(r.x)) as { ticker: string; x: number }[];
  const passNow = useMemo(() => {
    const xs = cur.map((r) => r.x);
    if (p.cohort === "threshold" && isNum(p.threshold)) {
      const t = p.threshold;
      const f = { ">": (v: number) => v > t, ">=": (v: number) => v >= t, "<": (v: number) => v < t, "<=": (v: number) => v <= t }[p.op] ?? ((v: number) => v > t);
      return new Set(cur.filter((r) => f(r.x)).map((r) => r.ticker));
    }
    const cut = quantile(xs, p.higher_is_better ? 1 - p.quantile : p.quantile);
    return new Set(cur.filter((r) => (p.higher_is_better ? r.x >= cut : r.x <= cut)).map((r) => r.ticker));
  }, [res, p]);

  const dates = [...new Set(res.observations.map((o) => o.date))].sort();
  const recency = (d: string) => (dates.length > 1 ? dates.indexOf(d) / (dates.length - 1) : 1);

  return (
    <>
      <div className="card card-pad">
        <div className="verdict">
          {c ? (
            <>
              Over the last <b>{c.summary.periods} {hz} periods</b>, an equal-weight basket of <b>{screenLabel}</b> beat{" "}
              <b>{p.benchmark}</b> in <b>{pct(c.summary.hit_vs_bench, 0, false)}</b> of periods, averaging{" "}
              <b className={deltaClass(c.summary.avg_excess_in)}>{pct(c.summary.avg_excess_in)}</b> vs the benchmark per period, compared with{" "}
              <b className={deltaClass(c.summary.avg_excess_out)}>{pct(c.summary.avg_excess_out)}</b> for the rest. It outperformed the rest in{" "}
              <b>{pct(c.summary.hit_vs_out, 0, false)}</b> of periods. Across {res.stats.n} company-periods, {xf?.label?.toLowerCase()} has{" "}
              <b>{strength(res.stats.spearman)}</b> rank correlation with next-{hz} {res.y.id === "fwd_excess" ? "excess " : ""}return (ρ = {num(res.stats.spearman, 2)}).
            </>
          ) : (
            <>
              Across {res.stats.n} company-periods, <b>{xf?.label}</b> and <b>{yf?.label}</b> show <b>{strength(res.stats.spearman)}</b> rank correlation
              (ρ = {num(res.stats.spearman, 2)}). Today ({res.latest?.date}) across {res.latest?.stats.n} companies: ρ = {num(res.latest?.stats.spearman, 2)}.
            </>
          )}
        </div>
        <div className="kpis" style={{ marginTop: 16 }}>
          <Stat label="Rank correlation (ρ)" value={num(res.stats.spearman, 2)} sub={`Pearson ${num(res.stats.pearson, 2)} · n = ${res.stats.n}`} />
          <Stat label="Significance" value={isNum(res.stats.p) ? (res.stats.p < 0.05 ? "p < 0.05" : `p ≈ ${res.stats.p.toFixed(2)}`) : "—"} sub={`t = ${num(res.stats.t, 2)} (approx.)`} />
          <Stat label="Mean period IC" value={num(res.ic_summary.mean, 2)} sub={`positive in ${pct(res.ic_summary.positive_share, 0, false)} of ${res.ic_summary.periods}`} />
          {c && <>
            <Stat label="Screen hit rate vs bench" value={pct(c.summary.hit_vs_bench, 0, false)} sub={`rest: ${pct(c.summary.out_hit_vs_bench, 0, false)}`} />
            <Stat label="Avg spread / period" value={pct(c.summary.avg_spread)} sub="screen minus rest" cls={deltaClass(c.summary.avg_spread)} />
            <Stat label="Annualised (screen)" value={pct(c.summary.cagr.in)} sub={`${p.benchmark}: ${pct(c.summary.cagr.bench)}`} cls={deltaClass(c.summary.cagr.in)} />
          </>}
        </div>
      </div>

      {c && (
        <div className="layout-2">
          <div className="card card-pad">
            <div className="card-title">Growth of $1, rebalanced every {hz}</div>
            <Legend items={[
              { label: "Passes screen", color: COLORS.in }, { label: "Rest", color: COLORS.out },
              { label: "Whole universe", color: COLORS.universe }, { label: p.benchmark, color: COLORS.bench, dash: true },
            ]} />
            <LineChart
              x={c.curve.map((r) => r.date)} xFormat={shortDate} yFormat={(v) => `$${v.toFixed(2)}`} baseline={1}
              series={[
                { id: "in", label: "Passes screen", color: COLORS.in, values: c.curve.map((r) => r.in) },
                { id: "out", label: "Rest", color: COLORS.out, values: c.curve.map((r) => r.out) },
                { id: "uni", label: "Whole universe", color: COLORS.universe, values: c.curve.map((r) => r.universe) },
                { id: "b", label: p.benchmark, color: COLORS.bench, values: c.curve.map((r) => r.bench), dash: true },
              ]}
            />
          </div>
          <div className="card card-pad">
            <div className="card-title">Return in each {hz} period</div>
            <Legend items={[{ label: "Passes screen", color: COLORS.in }, { label: "Rest", color: COLORS.out }, { label: p.benchmark, color: COLORS.bench }]} />
            <BarChart
              categories={c.rows.map((r) => r.start)} xFormat={shortDate} yFormat={(v) => pct(v, 0)}
              series={[
                { id: "in", label: "Passes screen", color: COLORS.in, values: c.rows.map((r) => r.in) },
                { id: "out", label: "Rest", color: COLORS.out, values: c.rows.map((r) => r.out) },
                { id: "b", label: p.benchmark, color: COLORS.bench, values: c.rows.map((r) => r.bench) },
              ]}
              height={262}
            />
          </div>
        </div>
      )}

      <div className="layout-3-1">
        <div className="card card-pad">
          <div className="card-title">
            {c ? `${res.x.label} vs next-${hz} ${res.y.label.toLowerCase()}` : res.latest ? `${res.x.label} vs ${res.y.label} — today` : ""}
            <span className="tiny muted">{c ? "each dot = one company in one period; darker = more recent" : "click a dot to open the company"}</span>
          </div>
          {c ? (
            <Scatter
              points={res.observations.map((o) => ({ key: `${o.ticker}${o.date}`, x: o.x, y: o.y, label: o.ticker, sub: shortDate(o.date), emphasis: recency(o.date) }))}
              xFormat={xFmt} yFormat={yFmt} fit={res.stats} xLabel={res.x.label} yLabel={res.y.label}
              onClick={(pt) => onOpen(pt.label)}
            />
          ) : (
            <Scatter
              points={(res.latest?.points ?? []).map((o) => ({ key: o.ticker, x: o.x, y: o.y, label: o.ticker }))}
              xFormat={xFmt} yFormat={yFmt} fit={res.latest?.stats} xLabel={res.x.label} yLabel={res.y.label} showLabels
              onClick={(pt) => onOpen(pt.label)}
            />
          )}
          <div className="tiny muted" style={{ marginTop: 6 }}>Dashed line: least-squares fit{p.winsorize ? " (values winsorised at 2/98 pct)" : ""}. Axes clipped to the 1st–99th percentile.</div>
        </div>
        <div className="card card-pad">
          <div className="card-title">Today's ranking by {res.x.label.toLowerCase()}</div>
          <div className="table-wrap" style={{ maxHeight: 420 }}>
            <table className="data">
              <thead><tr><th>Company</th><th>{res.x.label.split(" (")[0]}</th><th>Screen</th></tr></thead>
              <tbody>
                {res.current.map((r) => (
                  <tr key={r.ticker} style={{ cursor: "pointer" }} onClick={() => onOpen(r.ticker)}>
                    <td><b>{r.ticker}</b></td>
                    <td>{factor(r.x, res.x.unit)}</td>
                    <td>{passNow.has(r.ticker) ? <span style={{ color: "var(--pos-ink)", fontWeight: 600 }}>✓ passes</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="layout-2">
        <div className="card card-pad">
          <div className="card-title">Information coefficient per period <span className="tiny muted">rank correlation of X with the outcome, period by period</span></div>
          <BarChart
            categories={res.ic.map((r) => r.date)} xFormat={shortDate} yFormat={(v) => v.toFixed(2)} height={200}
            series={[{ id: "ic", label: "Rank IC", color: "var(--s1)", values: res.ic.map((r) => r.ic) }]}
          />
        </div>
        <div className="callout">
          <b>How to read this.</b> At each rebalance date, every company's X is the value that was public at the time
          (statements are assumed released 45 days after quarter end, 75 after year end — no look-ahead). The outcome is the
          return over the next {hz}{res.y.id === "fwd_excess" ? ` minus ${p.benchmark}'s` : ""}. Periods don't overlap, so they are
          independent samples, but with {res.universe.length} companies and {res.periods.length} periods the sample is small: treat
          p-values as indicative and look for consistency (hit rate, IC sign) rather than one big number.
          <br /><br />
          <b>Data depth.</b> Yahoo provides ~5 quarters and 4 fiscal years of statements; older periods fall back to annual figures and
          coverage thins before that. Price-based factors have the full 10 years.
          Companies with X data: {Object.values(res.coverage).filter((v) => v > 0).length}/{res.universe.length}.
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, sub, cls = "" }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className={`value tnum ${cls}`}>{value}</span>
      {sub && <span className="sub tnum">{sub}</span>}
    </div>
  );
}
