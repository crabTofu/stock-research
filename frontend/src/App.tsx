import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { refresh, useSector, useSectors, useStatus } from "./lib/api";
import { SupplyChain } from "./views/SupplyChain";
import { Company } from "./views/Company";
import { Research } from "./views/Research";

type Route = { view: "chain" | "company" | "research"; ticker?: string };

// hash routing: #/chain, #/company/NVDA, #/research — shareable, back button works
function parse(): Route {
  const [, view, ticker] = window.location.hash.replace(/^#/, "").split("/");
  if (view === "company") return { view, ticker: ticker?.toUpperCase() };
  if (view === "research") return { view };
  return { view: "chain" };
}

function useRoute(): [Route, (r: Route) => void] {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const f = () => { setR(parse()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  const go = (n: Route) => { window.location.hash = n.view === "company" ? `/company/${n.ticker ?? ""}` : `/${n.view}`; };
  return [r, go];
}

export default function App() {
  const [route, go] = useRoute();
  const { data: sectors } = useSectors();
  const [sectorId, setSectorId] = useState("ai");
  const [lastTicker, setLastTicker] = useState("NVDA");
  useEffect(() => { if (route.ticker) setLastTicker(route.ticker); }, [route.ticker]);
  const open = (t: string) => go({ view: "company", ticker: t });

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <svg width="14" height="14" viewBox="0 0 16 16"><path d="M2 12l4-4 3 3 5-6" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          Stock Research
        </div>
        {sectors && sectors.length > 1 && (
          <select value={sectorId} onChange={(e) => setSectorId(e.target.value)}>
            {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <nav className="tabs" role="tablist">
          <button className="tab" role="tab" aria-selected={route.view === "chain"} onClick={() => go({ view: "chain" })}>Supply chain</button>
          <button className="tab" role="tab" aria-selected={route.view === "company"} onClick={() => go({ view: "company", ticker: lastTicker })}>Company</button>
          <button className="tab" role="tab" aria-selected={route.view === "research"} onClick={() => go({ view: "research" })}>Research</button>
        </nav>
        <div className="grow" />
        <Search sectorId={sectorId} onPick={open} />
        <DataStatus />
      </header>
      <main className="main">
        {route.view === "chain" && <SupplyChain sectorId={sectorId} onOpen={open} />}
        {route.view === "company" && <Company key={route.ticker} ticker={route.ticker ?? lastTicker} sectorId={sectorId} onOpen={open} />}
        {route.view === "research" && <Research sectorId={sectorId} onOpen={open} />}
      </main>
    </>
  );
}

function Search({ sectorId, onPick }: { sectorId: string; onPick: (t: string) => void }) {
  const { data } = useSector(sectorId);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const all = useMemo(() => Object.values(data?.companies ?? {}), [data]);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return all.slice(0, 12);
    return all.filter((c) => c.ticker.toLowerCase().startsWith(s) || c.name?.toLowerCase().includes(s)).slice(0, 12);
  }, [q, all]);

  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "/" && document.activeElement?.tagName !== "INPUT") { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);

  const pick = (t: string) => { onPick(t); setQ(""); setOpen(false); ref.current?.blur(); };
  return (
    <div className="search">
      <input
        ref={ref} type="search" placeholder="Search company  ( / )" value={q}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setQ(e.target.value); setActive(0); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { setActive((a) => Math.min(hits.length - 1, a + 1)); e.preventDefault(); }
          if (e.key === "ArrowUp") { setActive((a) => Math.max(0, a - 1)); e.preventDefault(); }
          if (e.key === "Enter" && hits[active]) pick(hits[active].ticker);
          if (e.key === "Escape") ref.current?.blur();
        }}
      />
      {open && hits.length > 0 && (
        <div className="menu card">
          {hits.map((c, i) => (
            <div key={c.ticker} className="opt" data-active={i === active} onMouseDown={() => pick(c.ticker)}>
              <b style={{ width: 48 }}>{c.ticker}</b><span className="small ink2" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DataStatus() {
  const { data } = useStatus();
  const qc = useQueryClient();
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && data && !data.sync.running) qc.invalidateQueries();
    wasRunning.current = !!data?.sync.running;
  }, [data, qc]);
  if (!data) return null;
  const s = data.sync;
  return (
    <div className="row small muted" title={`${data.price_rows.toLocaleString()} price rows · ${data.financial_rows.toLocaleString()} financial rows stored locally`}>
      {s.running ? (
        <span>Syncing {s.done}/{s.total}…</span>
      ) : (
        <>
          <span>Data to {data.latest_price_date ?? "—"}</span>
          <button className="btn tiny" onClick={async () => { await refresh(); qc.invalidateQueries({ queryKey: ["status"] }); }}>Sync</button>
        </>
      )}
    </div>
  );
}
