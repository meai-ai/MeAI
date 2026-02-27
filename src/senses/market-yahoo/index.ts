/**
 * Yahoo Finance market data sense provider.
 *
 * Extracted from src/world.ts. Uses Yahoo Finance's public API
 * for real-time stock/index price data.
 */

import * as https from "https";
import type { AppConfig } from "../../types.js";
import type { SenseProvider, SenseType, MarketData } from "../types.js";

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MeAI/1.0)",
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

const provider: SenseProvider = {
  id: "market-yahoo",
  type: "market" as SenseType,
  name: "Yahoo Finance Market Data",

  isAvailable(): boolean {
    return true; // No API key needed
  },

  async fetchMarket(tickers: string[]): Promise<MarketData[]> {
    if (tickers.length === 0) return [];

    const symbols = tickers.join(",");
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`;

    try {
      const raw = await httpGet(url);
      const data = JSON.parse(raw);
      const quotes = data?.quoteResponse?.result ?? [];

      return quotes.map((q: any) => ({
        ticker: q.symbol ?? "",
        price: q.regularMarketPrice ?? 0,
        change: q.regularMarketChange ?? 0,
        changePct: q.regularMarketChangePercent ?? 0,
      }));
    } catch (err) {
      console.warn("[senses:market-yahoo] Fetch failed:", err);
      return [];
    }
  },
};

export default provider;
