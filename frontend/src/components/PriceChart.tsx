import { useEffect, useRef } from "react";
import {
  AreaSeries, CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, PriceScaleMode,
  type IChartApi, type UTCTimestamp,
} from "lightweight-charts";
import type { PriceData } from "../lib/api";
import { useTheme } from "../lib/theme";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const ts = (d: string) => (Date.parse(d + "T00:00:00Z") / 1000) as UTCTimestamp;

/** TradingView lightweight-charts: canvas rendering, smooth with 10y of daily bars. */
export function PriceChart({ data, mode, height = 360 }: { data: PriceData; mode: "area" | "candles" | "compare"; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const theme = useTheme(); // colours are read from CSS vars, so redraw when it flips

  useEffect(() => {
    if (!el.current) return;
    const ink3 = css("--ink-3"), grid = css("--grid"), up = css("--up"), down = css("--down"), s2 = css("--s2");
    const chart = createChart(el.current, {
      height,
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: ink3, fontFamily: css("--font"), attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: grid } },
      rightPriceScale: { borderVisible: false, mode: mode === "compare" ? PriceScaleMode.Percentage : PriceScaleMode.Normal },
      timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { horzLine: { labelBackgroundColor: css("--ink-2") }, vertLine: { labelBackgroundColor: css("--ink-2") } },
    });
    chartRef.current = chart;

    const n = data.date.length;
    if (mode === "candles") {
      const s = chart.addSeries(CandlestickSeries, {
        upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down,
      });
      s.setData(data.date.map((d, i) => ({ time: ts(d), open: data.open[i], high: data.high[i], low: data.low[i], close: data.close[i] })));
    } else {
      const rising = n > 1 && data.close[n - 1] >= data.close[0];
      const color = mode === "compare" ? up : rising ? up : down;
      const s = chart.addSeries(mode === "compare" ? LineSeries : AreaSeries, mode === "compare"
        ? { color, lineWidth: 2, title: data.ticker }
        : { lineColor: color, lineWidth: 2, topColor: color + "33", bottomColor: color + "00" } as any);
      s.setData(data.date.map((d, i) => ({ time: ts(d), value: data.close[i] })));
      if (mode === "compare" && data.benchmark) {
        const b = chart.addSeries(LineSeries, { color: s2, lineWidth: 2, lineStyle: 2, title: data.benchmark.ticker });
        b.setData(data.benchmark.date.map((d, i) => ({ time: ts(d), value: data.benchmark!.close[i] })));
      }
    }
    if (mode !== "compare") {
      const v = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, color: css("--axis") });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      v.setData(data.date.map((d, i) => ({ time: ts(d), value: data.volume[i] })));
    }
    chart.timeScale().fitContent();
    return () => { chart.remove(); chartRef.current = null; };
  }, [data, mode, height, theme]);

  return <div ref={el} style={{ height, width: "100%" }} />;
}
