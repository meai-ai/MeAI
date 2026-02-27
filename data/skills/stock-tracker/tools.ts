/**
 * Stock tracker skill — check stock prices via Yahoo Finance.
 * No API key required.
 */

import * as https from 'https';
import { URL } from 'url';

// ── HTTP helper ─────────────────────────────────────────────────────────────

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MeAI/1.0)',
        Accept: 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      // Handle redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location).then(resolve, reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── Yahoo Finance quote ─────────────────────────────────────────────────────

interface StockQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  currency: string;
  marketState: string;
  previousClose: number;
  open: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  marketCap?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
}

async function getQuote(symbol: string): Promise<StockQuote> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=true`;

  const raw = await httpGet(url);
  const data = JSON.parse(raw);

  const result = data?.chart?.result?.[0];
  if (!result) {
    throw new Error(`No data found for symbol: ${symbol}`);
  }

  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const previousClose = meta.chartPreviousClose || meta.previousClose;
  const change = price - previousClose;
  const changePercent = previousClose ? (change / previousClose) * 100 : 0;

  return {
    symbol: meta.symbol,
    name: meta.shortName || meta.longName || meta.symbol,
    price,
    change: Math.round(change * 100) / 100,
    changePercent: Math.round(changePercent * 100) / 100,
    currency: meta.currency || 'USD',
    marketState: meta.marketState || 'UNKNOWN',
    previousClose,
    open: meta.regularMarketOpen || 0,
    dayHigh: meta.regularMarketDayHigh || 0,
    dayLow: meta.regularMarketDayLow || 0,
    volume: meta.regularMarketVolume || 0,
    marketCap: meta.marketCap,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
  };
}

// ── Tool exports ────────────────────────────────────────────────────────────

export function getTools(_config?: any): any[] {
  return [
    {
      name: 'stock_quote',
      description:
        'Get current stock price and market data for one or more symbols. ' +
        'Supports stocks (META, AAPL), ETFs (SPY, QQQ), indices (^GSPC, ^DJI), ' +
        'and crypto (BTC-USD, ETH-USD). ' +
        'Use when the user asks about stock prices, market performance, or portfolio checks.',
      inputSchema: {
        type: 'object',
        properties: {
          symbols: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Stock ticker symbols (e.g. ["META", "AAPL", "SPY"]). ' +
              'For indices use ^ prefix: ^GSPC (S&P 500), ^DJI (Dow). ' +
              'For crypto append -USD: BTC-USD.',
          },
        },
        required: ['symbols'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const symbols = input.symbols as string[];

          if (!symbols || symbols.length === 0) {
            return JSON.stringify({ success: false, error: 'Provide at least one symbol.' });
          }

          if (symbols.length > 10) {
            return JSON.stringify({ success: false, error: 'Maximum 10 symbols per request.' });
          }

          // Fetch all quotes in parallel
          const promises = symbols.map(async (sym) => {
            try {
              return await getQuote(sym.toUpperCase());
            } catch (err: any) {
              return { symbol: sym.toUpperCase(), error: err.message } as any;
            }
          });

          const quotes = await Promise.all(promises);

          return JSON.stringify({
            success: true,
            count: quotes.length,
            quotes: quotes.map(q => {
              if (q.error) return { symbol: q.symbol, error: q.error };
              return {
                symbol: q.symbol,
                name: q.name,
                price: q.price,
                change: q.change,
                change_percent: `${q.changePercent > 0 ? '+' : ''}${q.changePercent}%`,
                currency: q.currency,
                market_state: q.marketState,
                day_range: `${q.dayLow} - ${q.dayHigh}`,
                volume: q.volume,
                previous_close: q.previousClose,
                fifty_two_week: q.fiftyTwoWeekHigh
                  ? `${q.fiftyTwoWeekLow} - ${q.fiftyTwoWeekHigh}`
                  : null,
              };
            }),
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },
  ];
}
