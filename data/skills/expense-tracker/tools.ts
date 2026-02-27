/**
 * Expense tracker skill — log, categorize, and summarize personal expenses.
 * JSON-based storage with monthly summaries.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

type Category =
  | 'food' | 'groceries' | 'transport' | 'shopping' | 'entertainment'
  | 'health' | 'kids' | 'home' | 'utilities' | 'subscription' | 'other';

interface Expense {
  id: string;
  amount: number;
  currency: string;
  category: Category;
  description: string;
  date: string;             // YYYY-MM-DD
  created_at: number;
}

interface ExpenseStore {
  expenses: Expense[];
}

// ── Auto-categorization ─────────────────────────────────────────────────────

const CATEGORY_KEYWORDS: Record<Category, string[]> = {
  food: ['lunch', 'dinner', 'breakfast', 'coffee', 'restaurant', 'cafe', 'pizza', 'sushi', 'takeout', 'eat', 'meal', 'brunch'],
  groceries: ['grocery', 'groceries', 'costco', 'whole foods', 'trader joe', 'safeway', 'kroger', 'walmart', 'target', 'supermarket'],
  transport: ['uber', 'lyft', 'gas', 'fuel', 'parking', 'bus', 'metro', 'toll', 'car wash', 'oil change'],
  shopping: ['amazon', 'clothes', 'shoes', 'electronics', 'ikea', 'furniture', 'gift'],
  entertainment: ['movie', 'netflix', 'spotify', 'concert', 'game', 'book', 'museum', 'theater', 'ticket'],
  health: ['doctor', 'pharmacy', 'medicine', 'dental', 'gym', 'vitamins', 'insurance', 'copay'],
  kids: ['school', 'daycare', 'tutor', 'toys', 'camp', 'lesson', 'childcare'],
  home: ['rent', 'mortgage', 'repair', 'cleaning', 'plumber', 'electrician'],
  utilities: ['electric', 'water', 'internet', 'phone', 'utility', 'bill'],
  subscription: ['subscription', 'membership', 'annual', 'monthly plan'],
  other: [],
};

function autoCategory(description: string): Category {
  const lower = description.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      return cat as Category;
    }
  }
  return 'other';
}

// ── Persistence ─────────────────────────────────────────────────────────────

function getStorePath(config: any): string {
  const statePath = config?.statePath || 'data';
  const dir = join(statePath, 'skills', 'expense-tracker');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'expenses.json');
}

function loadStore(config: any): ExpenseStore {
  const path = getStorePath(config);
  if (!existsSync(path)) return { expenses: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { expenses: [] };
  }
}

function saveStore(config: any, store: ExpenseStore): void {
  writeFileSync(getStorePath(config), JSON.stringify(store, null, 2));
}

// ── Tool exports ────────────────────────────────────────────────────────────

export function getTools(config?: any): any[] {
  return [
    {
      name: 'expense_add',
      description:
        'Log a new expense. Auto-categorizes based on description keywords. ' +
        'Use when the user mentions spending money: "spent $45 on groceries", "lunch was $15".',
      inputSchema: {
        type: 'object',
        properties: {
          amount: {
            type: 'number',
            description: 'Amount spent (positive number)',
          },
          description: {
            type: 'string',
            description: 'What was purchased (e.g. "lunch at Chipotle")',
          },
          category: {
            type: 'string',
            enum: ['food', 'groceries', 'transport', 'shopping', 'entertainment', 'health', 'kids', 'home', 'utilities', 'subscription', 'other'],
            description: 'Expense category. Auto-detected from description if omitted.',
          },
          date: {
            type: 'string',
            description: 'Date of expense YYYY-MM-DD. Default: today.',
          },
          currency: {
            type: 'string',
            description: 'Currency code. Default: USD.',
          },
        },
        required: ['amount', 'description'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const store = loadStore(config);
          const amount = input.amount as number;
          const description = input.description as string;
          const date = (input.date as string) || new Date().toISOString().slice(0, 10);
          const currency = (input.currency as string) || 'USD';
          const category = (input.category as Category) || autoCategory(description);

          const expense: Expense = {
            id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            amount,
            currency,
            category,
            description,
            date,
            created_at: Date.now(),
          };

          store.expenses.push(expense);
          saveStore(config, store);

          return JSON.stringify({
            success: true,
            expense: {
              id: expense.id,
              amount: `${currency} ${amount.toFixed(2)}`,
              category,
              description,
              date,
            },
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'expense_summary',
      description:
        'Get a spending summary for a date range, grouped by category. ' +
        'Use for "how much did I spend this month?", "show spending by category", etc.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['today', 'this_week', 'this_month', 'last_month', 'this_year'],
            description: 'Convenience shortcut. Overrides start_date/end_date.',
          },
          start_date: {
            type: 'string',
            description: 'Start date YYYY-MM-DD (inclusive)',
          },
          end_date: {
            type: 'string',
            description: 'End date YYYY-MM-DD (inclusive)',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const store = loadStore(config);
          const now = new Date();
          let startDate: string;
          let endDate: string;

          if (input.period) {
            const y = now.getFullYear();
            const m = now.getMonth();
            const d = now.getDate();

            switch (input.period) {
              case 'today':
                startDate = endDate = now.toISOString().slice(0, 10);
                break;
              case 'this_week': {
                const dayOfWeek = now.getDay();
                const monday = new Date(y, m, d - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
                startDate = monday.toISOString().slice(0, 10);
                endDate = now.toISOString().slice(0, 10);
                break;
              }
              case 'this_month':
                startDate = `${y}-${String(m + 1).padStart(2, '0')}-01`;
                endDate = now.toISOString().slice(0, 10);
                break;
              case 'last_month': {
                const lm = m === 0 ? 11 : m - 1;
                const ly = m === 0 ? y - 1 : y;
                startDate = `${ly}-${String(lm + 1).padStart(2, '0')}-01`;
                const lastDay = new Date(ly, lm + 1, 0).getDate();
                endDate = `${ly}-${String(lm + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
                break;
              }
              case 'this_year':
                startDate = `${y}-01-01`;
                endDate = now.toISOString().slice(0, 10);
                break;
              default:
                startDate = `${y}-${String(m + 1).padStart(2, '0')}-01`;
                endDate = now.toISOString().slice(0, 10);
            }
          } else {
            startDate = (input.start_date as string) || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
            endDate = (input.end_date as string) || now.toISOString().slice(0, 10);
          }

          const filtered = store.expenses.filter(e => e.date >= startDate && e.date <= endDate);

          // Group by category
          const byCategory: Record<string, { total: number; count: number }> = {};
          let grandTotal = 0;

          for (const e of filtered) {
            if (!byCategory[e.category]) byCategory[e.category] = { total: 0, count: 0 };
            byCategory[e.category].total += e.amount;
            byCategory[e.category].count += 1;
            grandTotal += e.amount;
          }

          // Sort categories by total descending
          const sortedCategories = Object.entries(byCategory)
            .sort((a, b) => b[1].total - a[1].total)
            .map(([cat, data]) => ({
              category: cat,
              total: Math.round(data.total * 100) / 100,
              count: data.count,
              percentage: grandTotal > 0 ? Math.round((data.total / grandTotal) * 100) : 0,
            }));

          return JSON.stringify({
            success: true,
            range: { start: startDate, end: endDate },
            total_expenses: filtered.length,
            grand_total: Math.round(grandTotal * 100) / 100,
            by_category: sortedCategories,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'expense_list',
      description:
        'List individual expense entries. Use to review recent spending details.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max entries to return. Default: 20.',
          },
          category: {
            type: 'string',
            description: 'Filter by category.',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const store = loadStore(config);
          const limit = (input.limit as number) || 20;
          const category = input.category as string | undefined;

          let expenses = store.expenses.slice().reverse(); // Most recent first

          if (category) {
            expenses = expenses.filter(e => e.category === category);
          }

          expenses = expenses.slice(0, limit);

          return JSON.stringify({
            success: true,
            count: expenses.length,
            expenses: expenses.map(e => ({
              id: e.id,
              amount: `${e.currency} ${e.amount.toFixed(2)}`,
              category: e.category,
              description: e.description,
              date: e.date,
            })),
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'expense_delete',
      description: 'Delete an expense entry by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Expense ID to delete' },
        },
        required: ['id'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const store = loadStore(config);
          const idx = store.expenses.findIndex(e => e.id === input.id);
          if (idx === -1) {
            return JSON.stringify({ success: false, error: 'Expense not found.' });
          }
          const removed = store.expenses.splice(idx, 1)[0];
          saveStore(config, store);
          return JSON.stringify({
            success: true,
            deleted: { id: removed.id, amount: removed.amount, description: removed.description },
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },
  ];
}
