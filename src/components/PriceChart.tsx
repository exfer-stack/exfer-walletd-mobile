// Candlestick price chart (TradingView's open-source lightweight-charts).
// Pan/zoom by drag is enabled by default. Themed for both dark and light.

import { useEffect, useRef } from "react";
import { createChart, ColorType, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../lib/market";

export function PriceChart({
  candles,
  theme,
  height = 200,
  timeVisible = false,
}: {
  candles: Candle[];
  theme: "dark" | "light";
  height?: number;
  timeVisible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  // (Re)create the chart on theme / sizing changes.
  useEffect(() => {
    if (!ref.current) return;
    const dark = theme === "dark";
    const grid = dark ? "rgba(255,255,255,0.05)" : "rgba(17,24,39,0.06)";
    const border = dark ? "rgba(255,255,255,0.09)" : "rgba(17,24,39,0.10)";
    const text = dark ? "#8b929c" : "#565d67";
    const up = dark ? "#34d399" : "#16a34a";
    const down = dark ? "#f87171" : "#dc2626";

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: text, fontFamily: "inherit", fontSize: 11 },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: border, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: border, timeVisible, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { mode: 0 },
      handleScroll: true,
      handleScale: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false,
      priceFormat: { type: "price", precision: 6, minMove: 0.000001 },
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [theme, height, timeVisible]);

  // Push data whenever it changes.
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;
    seriesRef.current.setData(
      candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}
