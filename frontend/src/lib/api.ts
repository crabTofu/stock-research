import { useQuery, keepPreviousData } from "@tanstack/react-query";

export type Snapshot = {
  ticker: string;
  name: string;
  industry?: string | null;
  market_cap?: number | null;
  pe?: number | null;
  fwd_pe?: number | null;
  ps?: number | null;
  ev_ebitda?: number | null;
  gross_margin?: number | null;
  operating_margin?: number | null;
  revenue_growth?: number | null;
  fcf?: number | null;
  ocf?: number | null;
  revenue?: number | null;
  price?: number | null;
  as_of?: string | null;
  chg_1d?: number | null;
  chg_1w?: number | null;
  chg_1m?: number | null;
  chg_3m?: number | null;
  chg_ytd?: number | null;
  chg_1y?: number | null;
  chg_3y?: number | null;
  high_52w?: number | null;
  low_52w?: number | null;
  spark?: number[];
};

export type Tier = { id: string; name: string; description: string; tickers: string[] };

export type SectorDetail = {
  id: string;
  name: string;
  description: string;
  benchmarks: string[];
  default_benchmark: string;
  tiers: Tier[];
  edges: [string, string][];
  companies: Record<string, Snapshot>;
  benchmark_snapshot: Record<string, Snapshot>;
};

export type SectorSummary = { id: string; name: string; description: string; n_companies: number };

export type CompanyDetail = {
  ticker: string;
  profile: Record<string, any>;
  snapshot: Snapshot;
  supply_chain: {
    sector: string;
    sector_name: string;
    tier: string;
    tier_name: string;
    suppliers: string[];
    customers: string[];
    peers: string[];
    default_benchmark: string;
  }[];
};

export type PriceData = {
  ticker: string;
  date: string[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  benchmark?: { ticker: string; date: string[]; close: number[] };
};

export type StatementRow = { item: string; key: boolean; values: (number | null)[] };
export type Financials = {
  ticker: string;
  freq: "Q" | "A";
  periods: string[];
  statements: Record<string, StatementRow[]>;
  key: Record<string, any>;
};

export type NewsItem = {
  id: string;
  published: string;
  title: string;
  publisher: string;
  link: string;
  summary?: string;
  thumbnail?: string;
};

export type Factor = { id: string; label: string; group: string; unit: "pct" | "x"; kind?: string };
export type FactorCatalog = { factors: Factor[]; targets: Factor[]; benchmarks: string[] };

export type ResearchParams = {
  x: string;
  y: string;
  sector: string | null;
  tiers: string[];
  benchmark: string;
  horizon_months: number;
  lookback_years: number;
  cohort: "quantile" | "threshold";
  quantile: number;
  threshold: number | null;
  op: string;
  higher_is_better: boolean;
  winsorize: boolean;
};

export type Stats = {
  n: number;
  pearson: number | null;
  spearman: number | null;
  t: number | null;
  p: number | null;
  slope: number | null;
  intercept: number | null;
};

export type CohortRow = {
  start: string;
  end: string;
  in: number | null;
  out: number | null;
  universe: number | null;
  bench: number | null;
  members: string[];
  n_in: number;
  n_out: number;
};

export type ResearchResult = {
  universe: string[];
  x: Factor;
  y: Factor;
  periods: { start: string; end: string }[];
  coverage: Record<string, number>;
  observations: { date: string; ticker: string; x: number; y: number }[];
  stats: Stats;
  ic: { date: string; ic: number | null; n: number }[];
  ic_summary: { mean: number | null; positive_share: number | null; periods: number };
  current: { ticker: string; x: number | null }[];
  cohort?: {
    rows: CohortRow[];
    curve: { date: string; in: number; out: number; universe: number; bench: number }[];
    summary: {
      periods: number;
      hit_vs_bench: number | null;
      hit_vs_out: number | null;
      out_hit_vs_bench: number | null;
      avg_excess_in: number | null;
      avg_excess_out: number | null;
      avg_spread: number | null;
      total: Record<string, number | null>;
      cagr: Record<string, number | null>;
    };
  };
  latest?: { date: string; points: { ticker: string; x: number; y: number }[]; stats: Stats };
  elapsed_ms: number;
};

export type Status = {
  price_rows: number;
  tickers: number;
  latest_price_date: string | null;
  financial_rows: number;
  oldest_price_sync: number | null;
  sync: { running: boolean; done: number; total: number; errors: any[]; finished_at: number | null };
  recent_errors: { ticker: string; dataset: string; error: string }[];
};

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? r.statusText);
  return r.json();
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? r.statusText);
  return r.json();
}

const MIN = 60_000;

export const useSectors = () => useQuery({ queryKey: ["sectors"], queryFn: () => get<SectorSummary[]>("/api/sectors"), staleTime: 10 * MIN });

export const useSector = (id: string) =>
  useQuery({ queryKey: ["sector", id], queryFn: () => get<SectorDetail>(`/api/sectors/${id}`), staleTime: MIN });

export const useCompany = (t: string) =>
  useQuery({ queryKey: ["company", t], queryFn: () => get<CompanyDetail>(`/api/companies/${t}`), staleTime: MIN, enabled: !!t });

export const usePrices = (t: string, range: string, benchmark?: string) =>
  useQuery({
    queryKey: ["prices", t, range, benchmark ?? ""],
    queryFn: () => get<PriceData>(`/api/companies/${t}/prices?range=${range}${benchmark ? `&benchmark=${benchmark}` : ""}`),
    staleTime: 5 * MIN,
    placeholderData: keepPreviousData,
    enabled: !!t,
  });

export const useFinancials = (t: string, freq: "Q" | "A") =>
  useQuery({
    queryKey: ["financials", t, freq],
    queryFn: () => get<Financials>(`/api/companies/${t}/financials?freq=${freq}`),
    staleTime: 60 * MIN,
    placeholderData: keepPreviousData,
    enabled: !!t,
  });

export const useNews = (t: string) =>
  useQuery({ queryKey: ["news", t], queryFn: () => get<NewsItem[]>(`/api/companies/${t}/news`), staleTime: 15 * MIN, enabled: !!t });

export const useFactors = () =>
  useQuery({ queryKey: ["factors"], queryFn: () => get<FactorCatalog>("/api/research/factors"), staleTime: Infinity });

export const useResearch = (p: ResearchParams | null) =>
  useQuery({
    queryKey: ["research", p],
    queryFn: () => post<ResearchResult>("/api/research/run", p),
    enabled: !!p,
    staleTime: 10 * MIN,
    placeholderData: keepPreviousData,
    retry: false,
  });

export const useStatus = () =>
  useQuery({
    queryKey: ["status"],
    queryFn: () => get<Status>("/api/status"),
    refetchInterval: (q) => (q.state.data?.sync.running ? 2000 : 60_000),
  });

export const refresh = (tickers: string[] = [], force = false) => post("/api/refresh", { tickers, force });
