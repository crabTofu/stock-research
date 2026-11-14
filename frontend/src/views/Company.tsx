import { useState } from "react";
import { useCompany, useFinancials, useNews, usePrices, useSector, refresh } from "../lib/api";
import { ago, big, deltaClass, divergingFill, isNum, money, num, pct, price, shortDate } from "../lib/format";
import { BarChart, Legend, LineChart } from "../components/charts";
import { PriceChart } from "../components/PriceChart";
import { useQueryClient } from "@tanstack/react-query";

const RANGES = ["1m", "3m", "6m", "ytd", "1y", "3y", "5y", "max"];

export function Company({ ticker, sectorId, onOpen }: { ticker: string; sectorId: string; onOpen: (t: string) => void }) {
  const { data, isLoading, error } = useCompany(ticker);
  if (!ticker) return <div className="empty">Pick a company from the value chain or the search box.</div>;
  if (isLoading) return <div className="skeleton" style={{ height: 600 }} />;
  if (error || !data) return <div className="error">{String(error)}</div>;

  const s = data.snapshot;
  const p = data.profile;
  const chain = data.supply_chain[0];
  return (
    <div className="grid">
      <div className="card card-pad">
        <div className="co-head">
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="row" style={{ gap: 10 }}>
              <h1 style={{ fontSize: 22 }}>{ticker}</h1>
              <span className="ink2" style={{ fontSize: 16 }}>{p.longName ?? s.name}</span>
            </div>
            <div className="small muted" style={{ marginTop: 4 }}>
              {[p.sector, p.industry, p.country, p.exchange].filter(Boolean).join(" · ")}
              {p.website && <> · <a href={p.website} target="_blank" rel="noreferrer">website</a></>}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="co-price tnum">{price(s.price)} <span className="small muted">{p.currency ?? "USD"}</span></div>
            <div className={`tnum ${deltaClass(s.chg_1d)}`} style={{ fontWeight: 600 }}>{pct(s.chg_1d, 2)} today <span className="muted small">· as of {s.as_of}</span></div>
          </div>
        </div>
        <div className="kpis" style={{ marginTop: 18 }}>
          <Kpi label="Market cap" value={money(s.market_cap)} />
          <Kpi label="P/E · forward" value={`${num(p.trailingPE)} · ${num(p.forwardPE)}`} />
          <Kpi label="P/S · EV/EBITDA" value={`${num(p.priceToSalesTrailing12Months)} · ${num(p.enterpriseToEbitda)}`} />
          <Kpi label="Revenue (TTM)" value={money(p.totalRevenue)} sub={`${pct(p.revenueGrowth)} YoY`} />
          <Kpi label="Gross · op margin" value={`${pct(p.grossMargins, 0, false)} · ${pct(p.operatingMargins, 0, false)}`} />
          <Kpi label="Op cash flow" value={money(p.operatingCashflow)} sub={`FCF ${money(p.freeCashflow)}`} />
          <Kpi label="Net cash" value={money(isNum(p.totalCash) && isNum(p.totalDebt) ? p.totalCash - p.totalDebt : null)} />
          <Kpi label="52W range" value={`${price(s.low_52w)} – ${price(s.high_52w)}`} sub={isNum(s.high_52w) && isNum(s.price) ? `${pct(s.price / s.high_52w - 1)} from high` : ""} />
          <Kpi label="Beta" value={num(p.beta, 2)} />
          <Kpi label="Analysts" value={p.recommendationKey ? String(p.recommendationKey).replace("_", " ") : "—"} sub={p.targetMeanPrice ? `target ${price(p.targetMeanPrice)}` : ""} />
        </div>
      </div>

      <div className="layout-3-1">
        <PricePanel ticker={ticker} benchmark={chain?.default_benchmark ?? "SPY"} />
        <div className="grid" style={{ alignContent: "start" }}>
          <Returns s={s} />
          {chain && <ChainPanel chain={chain} sectorId={sectorId} onOpen={onOpen} />}
        </div>
      </div>

      <FinancialsPanel ticker={ticker} />

      <div className="layout-3-1">
        <NewsPanel ticker={ticker} />
        <div className="card card-pad">
          <div className="card-title">About</div>
          <div className="small ink2" style={{ lineHeight: 1.6, maxHeight: 420, overflow: "auto" }}>{p.longBusinessSummary ?? "—"}</div>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="value tnum" style={{ fontSize: 16 }}>{value}</span>
      {sub ? <span className="sub tnum">{sub}</span> : null}
    </div>
  );
}

function PricePanel({ ticker, benchmark }: { ticker: string; benchmark: string }) {
  const [range, setRange] = useState("1y");
  const [mode, setMode] = useState<"area" | "candles" | "compare">("area");
  const { data, isFetching } = usePrices(ticker, range, mode === "compare" ? benchmark : undefined);
  return (
    <div className="card card-pad">
      <div className="row wrap" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <div className="card-title" style={{ margin: 0 }}>Price {isFetching && <span className="tiny muted">loading…</span>}</div>
        <div className="row wrap">
          <div className="seg">
            {(["area", "candles", "compare"] as const).map((m) => (
              <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "compare" ? `vs ${benchmark}` : m}</button>
            ))}
          </div>
          <div className="seg">
            {RANGES.map((r) => <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{r.toUpperCase()}</button>)}
          </div>
        </div>
      </div>
      {mode === "compare" && <Legend items={[{ label: ticker, color: "var(--up)" }, { label: benchmark, color: "var(--s2)", dash: true }]} />}
      {data ? <PriceChart data={data} mode={mode} /> : <div className="skeleton" style={{ height: 360 }} />}
    </div>
  );
}

function Returns({ s }: { s: any }) {
  const rows = [["1D", s.chg_1d], ["1W", s.chg_1w], ["1M", s.chg_1m], ["3M", s.chg_3m], ["YTD", s.chg_ytd], ["1Y", s.chg_1y], ["3Y", s.chg_3y]];
  return (
    <div className="card card-pad">
      <div className="card-title">Performance</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ background: divergingFill(v, 0.5), borderRadius: 8, padding: "8px 6px", textAlign: "center" }}>
            <div className="tiny ink2">{k}</div>
            <div className="tnum" style={{ fontWeight: 600 }}>{pct(v, 1)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChainPanel({ chain, sectorId, onOpen }: { chain: any; sectorId: string; onOpen: (t: string) => void }) {
  const { data } = useSector(sectorId);
  const chip = (t: string) => {
    const s = data?.companies[t];
    return (
      <button key={t} className="chip" onClick={() => onOpen(t)} style={{ background: divergingFill(s?.chg_1m, 0.2) }} title={s?.name}>
        <b>{t}</b><span className="tnum">{pct(s?.chg_1m, 0)}</span>
      </button>
    );
  };
  return (
    <div className="card card-pad">
      <div className="card-title">Position in {chain.sector_name} chain</div>
      <div className="small ink2" style={{ marginBottom: 10 }}>Stage: <b>{chain.tier_name}</b> <span className="muted">(chips show 1M return)</span></div>
      <Group label="Suppliers ↑" items={chain.suppliers} render={chip} />
      <Group label="Customers ↓" items={chain.customers} render={chip} />
      <Group label="Peers" items={chain.peers} render={chip} />
    </div>
  );
}

function Group({ label, items, render }: { label: string; items: string[]; render: (t: string) => React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="tiny muted" style={{ marginBottom: 4 }}>{label}</div>
      <div className="row wrap" style={{ gap: 6 }}>{items.length ? items.map(render) : <span className="tiny muted">none mapped</span>}</div>
    </div>
  );
}

function FinancialsPanel({ ticker }: { ticker: string }) {
  const [freq, setFreq] = useState<"Q" | "A">("Q");
  const [st, setSt] = useState("income");
  const [all, setAll] = useState(false);
  const { data, isLoading } = useFinancials(ticker, freq);
  const k = data?.key;
  const periods: string[] = k?.periods ?? [];
  const label = (d: string) => (freq === "A" ? d.slice(0, 4) : shortDate(d));
  const rows = (data?.statements[st] ?? []).filter((r) => all || r.key);

  return (
    <div className="card card-pad">
      <div className="row wrap" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div className="card-title" style={{ margin: 0 }}>Financials</div>
        <div className="seg">
          <button aria-pressed={freq === "Q"} onClick={() => setFreq("Q")}>Quarterly</button>
          <button aria-pressed={freq === "A"} onClick={() => setFreq("A")}>Annual</button>
        </div>
      </div>
      {isLoading || !k ? <div className="skeleton" style={{ height: 240 }} /> : periods.length === 0 ? <div className="empty">No statements for this ticker.</div> : (
        <>
          <div className="layout-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", display: "grid" }}>
            <div>
              <div className="small ink2" style={{ marginBottom: 4 }}>Revenue</div>
              <BarChart categories={periods} xFormat={label} yFormat={(v) => money(v, 0)}
                series={[{ id: "rev", label: "Revenue", color: "var(--s1)", values: k.revenue }]} height={200} />
            </div>
            <div>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
                <span className="small ink2">Cash generation</span>
                <Legend items={[{ label: "Operating CF", color: "var(--s1)" }, { label: "Free CF", color: "var(--s3)" }]} />
              </div>
              <BarChart categories={periods} xFormat={label} yFormat={(v) => money(v, 0)}
                series={[
                  { id: "ocf", label: "Operating CF", color: "var(--s1)", values: k.ocf },
                  { id: "fcf", label: "Free CF", color: "var(--s3)", values: k.fcf },
                ]} height={200} />
            </div>
            <div>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
                <span className="small ink2">Margins</span>
                <Legend items={[{ label: "Gross", color: "var(--s1)" }, { label: "Operating", color: "var(--s2)" }, { label: "Net", color: "var(--s3)" }]} />
              </div>
              <LineChart x={periods} xFormat={label} yFormat={(v) => pct(v, 0, false)} height={200}
                series={[
                  { id: "gm", label: "Gross", color: "var(--s1)", values: k.gross_margin },
                  { id: "om", label: "Operating", color: "var(--s2)", values: k.operating_margin },
                  { id: "nm", label: "Net", color: "var(--s3)", values: k.net_margin },
                ]} />
            </div>
          </div>

          <div className="row wrap" style={{ justifyContent: "space-between", margin: "18px 0 8px" }}>
            <div className="seg">
              {[["income", "Income statement"], ["balance", "Balance sheet"], ["cashflow", "Cash flow"]].map(([id, l]) => (
                <button key={id} aria-pressed={st === id} onClick={() => setSt(id)}>{l}</button>
              ))}
            </div>
            <label className="row small muted" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all line items
            </label>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{freq === "Q" ? "Quarter ending" : "Fiscal year ending"}</th>{data!.periods.map((p) => <th key={p}>{p}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.item} className={r.key ? "key" : ""}>
                    <td>{r.item}</td>
                    {r.values.map((v, i) => (
                      <td key={i} className={isNum(v) && v < 0 ? "neg" : ""}>
                        {r.item.includes("EPS") ? num(v, 2) : big(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function NewsPanel({ ticker }: { ticker: string }) {
  const { data, isLoading } = useNews(ticker);
  const qc = useQueryClient();
  return (
    <div className="card card-pad">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="card-title">Latest news</div>
        <button className="btn small" onClick={async () => { await refresh([ticker], true); setTimeout(() => qc.invalidateQueries(), 2500); }}>
          Refresh {ticker} data
        </button>
      </div>
      {isLoading ? <div className="skeleton" style={{ height: 200 }} /> : !data?.length ? <div className="empty">No recent headlines.</div> : (
        <div>
          {data.map((n) => (
            <a key={n.id} href={n.link} target="_blank" rel="noreferrer" className="news-item" style={{ textDecoration: "none" }}>
              <div>
                <div className="t">{n.title}</div>
                {n.summary && <div className="s">{n.summary}</div>}
                <div className="tiny muted" style={{ marginTop: 4 }}>{n.publisher} · {n.published ? ago(n.published) : ""}</div>
              </div>
              {n.thumbnail ? <img src={n.thumbnail} alt="" loading="lazy" /> : <div />}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
