/**
 * Todo list skill — personal task management with priorities, categories, and due dates.
 * Stored as a JSON file.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'done';
  priority: 'high' | 'medium' | 'low';
  category: string;
  due_date?: string;          // YYYY-MM-DD
  created_at: number;
  completed_at?: number;
}

interface TodoStore {
  items: TodoItem[];
}

// ── Persistence ─────────────────────────────────────────────────────────────

function getStorePath(config: any): string {
  const statePath = config?.statePath || 'data';
  const dir = join(statePath, 'skills', 'todo-list');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'todos.json');
}

function loadStore(config: any): TodoStore {
  const path = getStorePath(config);
  if (!existsSync(path)) return { items: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { items: [] };
  }
}

function saveStore(config: any, store: TodoStore): void {
  writeFileSync(getStorePath(config), JSON.stringify(store, null, 2));
}

// ── Tool exports ────────────────────────────────────────────────────────────

export function getTools(config?: any): any[] {
  return [
    {
      name: 'todo_add',
      description:
        'Add a new task to the todo list. ' +
        'Use when the user says "I need to...", "add to my todo", "remind me to do...", etc.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Task description',
          },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'Task priority. Default: medium.',
          },
          category: {
            type: 'string',
            description: 'Category/project name (e.g. "work", "home", "kids"). Default: "general".',
          },
          due_date: {
            type: 'string',
            description: 'Optional due date in YYYY-MM-DD format.',
          },
        },
        required: ['text'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const store = loadStore(config);
          const item: TodoItem = {
            id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            text: input.text as string,
            status: 'pending',
            priority: (input.priority as TodoItem['priority']) || 'medium',
            category: (input.category as string) || 'general',
            due_date: input.due_date as string | undefined,
            created_at: Date.now(),
          };

          store.items.push(item);
          saveStore(config, store);

          return JSON.stringify({
            success: true,
            item: {
              id: item.id,
              text: item.text,
              priority: item.priority,
              category: item.category,
              due_date: item.due_date || null,
            },
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'todo_list',
      description:
        'List tasks from the todo list. Can filter by status, category, or priority.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'done', 'all'],
            description: 'Filter by status. Default: pending.',
          },
          category: {
            type: 'string',
            description: 'Filter by category. Omit to show all categories.',
          },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'Filter by priority. Omit to show all priorities.',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const store = loadStore(config);
          const statusFilter = (input.status as string) || 'pending';
          const categoryFilter = input.category as string | undefined;
          const priorityFilter = input.priority as string | undefined;

          let items = store.items;

          if (statusFilter !== 'all') {
            items = items.filter(i => i.status === statusFilter);
          }
          if (categoryFilter) {
            items = items.filter(i => i.category.toLowerCase() === categoryFilter.toLowerCase());
          }
          if (priorityFilter) {
            items = items.filter(i => i.priority === priorityFilter);
          }

          // Sort: high priority first, then by due date, then by creation
          const priorityOrder = { high: 0, medium: 1, low: 2 };
          items.sort((a, b) => {
            const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
            if (pDiff !== 0) return pDiff;
            if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
            if (a.due_date) return -1;
            if (b.due_date) return 1;
            return a.created_at - b.created_at;
          });

          return JSON.stringify({
            success: true,
            count: items.length,
            filters: { status: statusFilter, category: categoryFilter || 'all', priority: priorityFilter || 'all' },
            items: items.map(i => ({
              id: i.id,
              text: i.text,
              priority: i.priority,
              category: i.category,
              due_date: i.due_date || null,
              status: i.status,
            })),
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'todo_complete',
      description:
        'Mark a task as done. Can match by ID or by text (partial match).',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Task ID. Either id or text_match is required.',
          },
          text_match: {
            type: 'string',
            description: 'Partial text to match the task. Used if id is not provided.',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const store = loadStore(config);
          let item: TodoItem | undefined;

          if (input.id) {
            item = store.items.find(i => i.id === input.id);
          } else if (input.text_match) {
            const match = (input.text_match as string).toLowerCase();
            item = store.items.find(i =>
              i.status === 'pending' && i.text.toLowerCase().includes(match),
            );
          } else {
            return JSON.stringify({ success: false, error: 'Provide either id or text_match.' });
          }

          if (!item) {
            return JSON.stringify({ success: false, error: 'Task not found.' });
          }

          item.status = 'done';
          item.completed_at = Date.now();
          saveStore(config, store);

          return JSON.stringify({
            success: true,
            completed: { id: item.id, text: item.text },
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'todo_remove',
      description: 'Permanently remove a task from the list by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Task ID to remove.',
          },
        },
        required: ['id'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const store = loadStore(config);
          const idx = store.items.findIndex(i => i.id === input.id);
          if (idx === -1) {
            return JSON.stringify({ success: false, error: 'Task not found.' });
          }
          const removed = store.items.splice(idx, 1)[0];
          saveStore(config, store);
          return JSON.stringify({ success: true, removed: { id: removed.id, text: removed.text } });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },
  ];
}
