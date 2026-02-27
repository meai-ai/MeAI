/**
 * Calculator skill — safe math evaluation, unit conversion, and currency exchange.
 * No eval() used — implements a recursive descent parser for safety.
 */

import * as https from 'https';

// ── Safe math parser ────────────────────────────────────────────────────────

/**
 * Tokenize and evaluate a math expression safely.
 * Supports: +, -, *, /, %, ^, (), sqrt(), abs(), round(), floor(), ceil()
 */
function evaluate(expr: string): number {
  const tokens = tokenize(expr);
  let pos = 0;

  function peek(): string | null {
    return pos < tokens.length ? tokens[pos] : null;
  }

  function consume(): string {
    return tokens[pos++];
  }

  function expect(token: string): void {
    if (consume() !== token) throw new Error(`Expected ${token}`);
  }

  // expression = term (('+' | '-') term)*
  function parseExpression(): number {
    let result = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const right = parseTerm();
      result = op === '+' ? result + right : result - right;
    }
    return result;
  }

  // term = power (('*' | '/' | '%') power)*
  function parseTerm(): number {
    let result = parsePower();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = consume();
      const right = parsePower();
      if (op === '*') result *= right;
      else if (op === '/') {
        if (right === 0) throw new Error('Division by zero');
        result /= right;
      }
      else result %= right;
    }
    return result;
  }

  // power = unary ('^' unary)*
  function parsePower(): number {
    let result = parseUnary();
    while (peek() === '^') {
      consume();
      const right = parseUnary();
      result = Math.pow(result, right);
    }
    return result;
  }

  // unary = '-' unary | primary
  function parseUnary(): number {
    if (peek() === '-') {
      consume();
      return -parseUnary();
    }
    return parsePrimary();
  }

  // primary = number | '(' expression ')' | function '(' expression ')'
  function parsePrimary(): number {
    const t = peek();

    if (t === '(') {
      consume();
      const result = parseExpression();
      expect(')');
      return result;
    }

    // Functions
    const funcs: Record<string, (n: number) => number> = {
      sqrt: Math.sqrt,
      abs: Math.abs,
      round: Math.round,
      floor: Math.floor,
      ceil: Math.ceil,
      sin: Math.sin,
      cos: Math.cos,
      tan: Math.tan,
      log: Math.log10,
      ln: Math.log,
    };

    if (t && funcs[t]) {
      consume();
      expect('(');
      const arg = parseExpression();
      expect(')');
      return funcs[t](arg);
    }

    // Constants
    if (t === 'pi') { consume(); return Math.PI; }
    if (t === 'e') { consume(); return Math.E; }

    // Number
    if (t && /^[\d.]/.test(t)) {
      consume();
      const num = parseFloat(t);
      if (isNaN(num)) throw new Error(`Invalid number: ${t}`);
      return num;
    }

    throw new Error(`Unexpected token: ${t}`);
  }

  const result = parseExpression();
  if (pos < tokens.length) throw new Error(`Unexpected token: ${tokens[pos]}`);
  return result;
}

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const s = expr.replace(/\s+/g, '').toLowerCase();

  while (i < s.length) {
    // Number (including decimals)
    if (/[\d.]/.test(s[i])) {
      let num = '';
      while (i < s.length && /[\d.]/.test(s[i])) {
        num += s[i++];
      }
      tokens.push(num);
      continue;
    }

    // Operators and parens
    if ('+-*/%^()'.includes(s[i])) {
      tokens.push(s[i++]);
      continue;
    }

    // Function names and constants
    if (/[a-z]/.test(s[i])) {
      let name = '';
      while (i < s.length && /[a-z]/.test(s[i])) {
        name += s[i++];
      }
      tokens.push(name);
      continue;
    }

    throw new Error(`Unexpected character: ${s[i]}`);
  }

  return tokens;
}

// ── Unit conversion ─────────────────────────────────────────────────────────

const CONVERSIONS: Record<string, Record<string, number>> = {
  // Length (base: meters)
  km: { m: 1000 }, m: { m: 1 }, cm: { m: 0.01 }, mm: { m: 0.001 },
  mi: { m: 1609.344 }, mile: { m: 1609.344 }, miles: { m: 1609.344 },
  yd: { m: 0.9144 }, ft: { m: 0.3048 }, feet: { m: 0.3048 }, 'in': { m: 0.0254 }, inch: { m: 0.0254 }, inches: { m: 0.0254 },

  // Weight (base: kg)
  kg: { kg: 1 }, g: { kg: 0.001 }, mg: { kg: 0.000001 },
  lb: { kg: 0.453592 }, lbs: { kg: 0.453592 }, oz: { kg: 0.0283495 },

  // Volume (base: liters)
  l: { l: 1 }, ml: { l: 0.001 }, gal: { l: 3.78541 }, gallon: { l: 3.78541 },
  qt: { l: 0.946353 }, pt: { l: 0.473176 }, cup: { l: 0.236588 },
  tbsp: { l: 0.0147868 }, tsp: { l: 0.00492892 },
  floz: { l: 0.0295735 },

  // Speed (base: m/s)
  'km/h': { 'ms': 0.277778 }, 'mph': { 'ms': 0.44704 }, 'kmh': { 'ms': 0.277778 },
};

// Temperature handled separately
function convertTemperature(value: number, from: string, to: string): number | null {
  const f = from.toLowerCase().replace('°', '');
  const t = to.toLowerCase().replace('°', '');

  if (f === t) return value;
  if (f === 'c' && t === 'f') return (value * 9 / 5) + 32;
  if (f === 'f' && t === 'c') return (value - 32) * 5 / 9;
  if (f === 'c' && t === 'k') return value + 273.15;
  if (f === 'k' && t === 'c') return value - 273.15;
  if (f === 'f' && t === 'k') return (value - 32) * 5 / 9 + 273.15;
  if (f === 'k' && t === 'f') return (value - 273.15) * 9 / 5 + 32;
  return null;
}

function convertUnit(value: number, from: string, to: string): number | null {
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();

  // Temperature
  if (['c', 'f', 'k', '°c', '°f', '°k'].includes(fromLower)) {
    return convertTemperature(value, fromLower, toLower);
  }

  const fromConv = CONVERSIONS[fromLower];
  const toConv = CONVERSIONS[toLower];

  if (!fromConv || !toConv) return null;

  // Find common base
  const fromBase = Object.keys(fromConv)[0];
  const toBase = Object.keys(toConv)[0];

  if (fromBase !== toBase) return null;

  const baseValue = value * fromConv[fromBase];
  return baseValue / toConv[toBase];
}

// ── Currency (free API) ─────────────────────────────────────────────────────

async function fetchExchangeRate(from: string, to: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = `https://open.er-api.com/v6/latest/${from.toUpperCase()}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.result === 'success' && json.rates?.[to.toUpperCase()]) {
            resolve(json.rates[to.toUpperCase()]);
          } else {
            reject(new Error(`Cannot find rate for ${from} → ${to}`));
          }
        } catch {
          reject(new Error('Failed to parse exchange rate data'));
        }
      });
    }).on('error', reject);
  });
}

// ── Date math ───────────────────────────────────────────────────────────────

function dateDiff(date1: string, date2: string): { days: number; weeks: number; months: number } {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diffMs = Math.abs(d2.getTime() - d1.getTime());
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return {
    days,
    weeks: Math.floor(days / 7),
    months: Math.round(days / 30.44),
  };
}

// ── Tool exports ────────────────────────────────────────────────────────────

export function getTools(_config?: any): any[] {
  return [
    {
      name: 'calc_evaluate',
      description:
        'Evaluate a math expression safely. ' +
        'Supports: +, -, *, /, %, ^ (power), sqrt(), abs(), round(), floor(), ceil(), sin(), cos(), tan(), log(), ln(). ' +
        'Constants: pi, e. ' +
        'Use for any arithmetic the user needs: tips, splits, percentages, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'Math expression (e.g. "15% * 86", "sqrt(144)", "2^10")',
          },
        },
        required: ['expression'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          let expr = input.expression as string;

          // Handle percentage notation: "15% of 86" → "0.15 * 86"
          expr = expr.replace(/(\d+(?:\.\d+)?)%\s*(?:of\s+)?(\d+(?:\.\d+)?)/gi, (_, pct, num) => {
            return `${parseFloat(pct) / 100} * ${num}`;
          });
          // Standalone percentage: "15%" → "0.15"
          expr = expr.replace(/(\d+(?:\.\d+)?)%/g, (_, pct) => {
            return `${parseFloat(pct) / 100}`;
          });

          const result = evaluate(expr);
          const rounded = Math.round(result * 1e10) / 1e10; // Avoid floating point noise

          return JSON.stringify({
            success: true,
            expression: input.expression,
            result: rounded,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'calc_convert',
      description:
        'Convert between units or currencies. ' +
        'Units: length (km, mi, m, ft, in), weight (kg, lb, oz, g), ' +
        'volume (l, gal, cup, tbsp, tsp), temperature (C, F, K). ' +
        'Currency: any ISO code (USD, CNY, EUR, etc.) — fetches live rates.',
      inputSchema: {
        type: 'object',
        properties: {
          value: {
            type: 'number',
            description: 'The numeric value to convert',
          },
          from: {
            type: 'string',
            description: 'Source unit or currency (e.g. "mi", "kg", "C", "USD")',
          },
          to: {
            type: 'string',
            description: 'Target unit or currency (e.g. "km", "lb", "F", "CNY")',
          },
        },
        required: ['value', 'from', 'to'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const value = input.value as number;
          const from = input.from as string;
          const to = input.to as string;

          // Try unit conversion first
          const unitResult = convertUnit(value, from, to);
          if (unitResult !== null) {
            return JSON.stringify({
              success: true,
              type: 'unit',
              value,
              from,
              to,
              result: Math.round(unitResult * 10000) / 10000,
            });
          }

          // Try currency conversion
          if (from.length === 3 && to.length === 3 && /^[A-Za-z]+$/.test(from) && /^[A-Za-z]+$/.test(to)) {
            const rate = await fetchExchangeRate(from, to);
            const result = value * rate;
            return JSON.stringify({
              success: true,
              type: 'currency',
              value,
              from: from.toUpperCase(),
              to: to.toUpperCase(),
              rate,
              result: Math.round(result * 100) / 100,
            });
          }

          return JSON.stringify({
            success: false,
            error: `Cannot convert from "${from}" to "${to}". Supported: length, weight, volume, temperature, or 3-letter currency codes.`,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'calc_date_diff',
      description:
        'Calculate the number of days between two dates. ' +
        'Use for "how many days until Christmas?", "days between X and Y", etc.',
      inputSchema: {
        type: 'object',
        properties: {
          date1: {
            type: 'string',
            description: 'First date (YYYY-MM-DD). Use "today" for current date.',
          },
          date2: {
            type: 'string',
            description: 'Second date (YYYY-MM-DD). Use "today" for current date.',
          },
        },
        required: ['date1', 'date2'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          let d1 = input.date1 as string;
          let d2 = input.date2 as string;

          if (d1.toLowerCase() === 'today') d1 = new Date().toISOString().slice(0, 10);
          if (d2.toLowerCase() === 'today') d2 = new Date().toISOString().slice(0, 10);

          const result = dateDiff(d1, d2);

          return JSON.stringify({
            success: true,
            date1: d1,
            date2: d2,
            difference: result,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },
  ];
}
