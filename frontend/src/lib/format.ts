export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function pct(v: number | null | undefined, digits = 1, signed = true): string {
  if (!isNum(v)) return "—";
  const s = (v * 100).toFixed(digits);
  return `${signed && v > 0 ? "+" : ""}${s}%`;
}

export function money(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(digits)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(digits)}K`;
  return `${sign}$${a.toFixed(2)}`;
}

export function big(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}K`;
  return `${sign}${a.toFixed(2)}`;
}

export function num(v: number | null | undefined, digits = 1, suffix = ""): string {
  if (!isNum(v)) return "—";
  return `${v.toFixed(digits)}${suffix}`;
}

export function price(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  return v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(2);
}

/** Format a factor value according to its unit. */
export function factor(v: number | null | undefined, unit: string, signed = false): string {
  if (!isNum(v)) return "—";
  return unit === "pct" ? pct(v, 1, signed) : `${v.toFixed(2)}×`;
}

export function shortDate(iso: string): string {
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

export function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Diverging fill: blue arm for gains, red arm for losses, neutral at zero.
 *  `cap` is the |return| that maps to full intensity. */
export function divergingFill(v: number | null | undefined, cap: number): string {
  if (!isNum(v)) return "var(--surface-2)";
  const t = Math.min(1, Math.abs(v) / cap);
  const mix = Math.round(8 + t * 52);
  return `color-mix(in oklab, var(${v >= 0 ? "--up" : "--down"}) ${mix}%, var(--surface-1))`;
}

export const deltaClass = (v: number | null | undefined) => (!isNum(v) ? "" : v > 0 ? "pos" : v < 0 ? "neg" : "");
