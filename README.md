# Stock Research

A self-hosted stock picker. It has three views:

- **Supply chain**: every company in a sector, laid out by value-chain stage (upstream → downstream). Each company is coloured by its return over a period you pick and sized by market cap. Lines show supplier → customer links.
- **Company**: price chart (compare vs. benchmark), key multiples, quarterly/annual statements with charts, latest news, and the company's suppliers, customers and peers.
- **Research**: test whether a characteristic (OCF margin, P/S, momentum…) has historically said anything about forward returns vs. a benchmark across your universe, or how two metrics relate to each other.

The PoC ships with an **AI** sector of 38 companies across 8 stages, plus SPY/QQQ/SMH as benchmarks.

## Quick start

```bash
make setup      # venv + npm install
make ingest     # ~15s: 10y daily prices, statements, profiles -> data/market.db
make serve      # builds the UI and serves everything on http://localhost:8000
```

For development, run `make dev-api` and `make dev-ui` in two terminals, then open http://localhost:5173.

## Architecture

```
config/sectors/*.yaml      sector = ordered tiers of tickers + supplier→customer edges
backend/app/
  providers/               data-source adapters (Yahoo today; add EDGAR/FMP/Polygon here)
  ingest.py                incremental sync, TTL-based freshness, CLI
  db.py                    SQLite (WAL) schema + writers
  metrics.py               read models: price panel, snapshots, statements, point-in-time fundamentals
  research.py              factor registry + backtest/correlation engine
  main.py                  FastAPI routes; also serves frontend/dist
frontend/src/
  views/                   SupplyChain, Company, Research
  components/charts.tsx    small SVG chart kit (line, bar, scatter, sparkline) with hover tooltips
  components/PriceChart    TradingView lightweight-charts (canvas) for price history
```

### Data and storage

- **Source.** Yahoo Finance through `yfinance`. It is free and broad, but unofficial and rate-limited, so the app treats it as a sync source, not something to call on every page load.
- **Local first.** Everything lands in `data/market.db` (SQLite in WAL mode). Pages are served from the DB. A dataset is fetched only when it is missing or older than its TTL: prices 6h, fundamentals 7d, profile 1d, news 30m. Override these with env vars (`TTL_PRICES`, …).
- **Incremental prices.** Each sync fetches from the last stored date with a 10-day overlap. If the overlap no longer matches what's stored (a split or dividend changed the adjusted history), that ticker's full history is re-pulled.
- **Long-format financials.** Statements are stored as `(ticker, freq, period_end, statement, item, value)`, so new line items or providers need no schema change.
- **Cache invalidation.** Every ingest bumps `meta.data_version`. In-process caches (price panel, snapshots, statements) key on it, so they refresh themselves even when the CLI ingests in another process.
- On startup the server syncs anything stale in a background thread (`SYNC_ON_STARTUP=0` disables this). The **Sync** button in the header does the same on demand.

### Performance notes

- `WITHOUT ROWID` tables clustered on `(ticker, date)`: a ticker's history is one contiguous range scan.
- One SQLite connection per thread; reads never block on the ingest writer (WAL).
- Sector snapshot: ~100 ms cold, ~3 ms warm. Research runs: 15–130 ms over 38 tickers × 10 years.
- GZip on responses. Price series are sent as columnar arrays (≈3× smaller than an array of objects).
- Frontend: React Query dedupes and caches requests, research params are debounced, the chart library sits in its own chunk, and price history renders on canvas.

### Adding things

- **A company:** add its ticker to a tier in `config/sectors/ai.yaml`, plus any edges. Files are re-read on change. Run `make ingest` or click Sync.
- **A sector:** drop `config/sectors/<id>.yaml` with the same shape. A sector picker appears in the header once there's more than one. A ticker can sit in several sectors; its data is stored once.
- **A data provider:** implement the `Provider` protocol in `backend/app/providers/base.py` and return it from `get_provider()`.
- **A research factor:** add an entry to `FACTORS` in `research.py`. Fundamental factors are computed in `metrics._period_metrics`; price factors in `research._price_factor`.

## Research methodology

1. Rebalance dates step back from the latest price every *holding period* (1M / 1Q / 2Q / 1Y), so periods never overlap.
2. At each date, a company's X is what was **public then**. Statements are assumed available 45 days after quarter end (75 after fiscal year end). Flow ratios use trailing-12-month sums once four quarters exist.
3. The outcome is the forward return over the holding period, minus the benchmark's.
4. The output includes:
   - pooled Spearman/Pearson correlation
   - per-period rank IC (information coefficient)
   - a cohort test: an equal-weight basket passing the screen (top/bottom N%, or a threshold) vs. the rest vs. the benchmark, with hit rate and growth of $1.

**Known limits.**
- Yahoo keeps about 5 quarters and 4 fiscal years of statements, so fundamental factors thin out beyond about 4 years. Price-based factors cover the full 10 years.
- Historical market cap is today's cap scaled by price (ignores buybacks).
- The universe is today's list, so there is survivorship bias.
- p-values use a normal approximation.

**Next step for deeper fundamentals.** Add an SEC EDGAR `companyfacts` provider. It is free and has 10+ years of quarterly XBRL data for US filers.
