/**
 * Contacts skill — store and look up contact information.
 * JSON-based storage with search.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

interface Contact {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  birthday?: string;        // YYYY-MM-DD or free text
  address?: string;
  relationship?: string;    // e.g. "friend", "colleague", "family"
  company?: string;
  notes?: string;
  created_at: number;
  updated_at: number;
}

interface ContactStore {
  contacts: Contact[];
}

// ── Persistence ─────────────────────────────────────────────────────────────

function getStorePath(config: any): string {
  const statePath = config?.statePath || 'data';
  const dir = join(statePath, 'skills', 'contacts');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'contacts.json');
}

function loadStore(config: any): ContactStore {
  const path = getStorePath(config);
  if (!existsSync(path)) return { contacts: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { contacts: [] };
  }
}

function saveStore(config: any, store: ContactStore): void {
  writeFileSync(getStorePath(config), JSON.stringify(store, null, 2));
}

// ── Tool exports ────────────────────────────────────────────────────────────

export function getTools(config?: any): any[] {
  return [
    {
      name: 'contact_save',
      description:
        'Save or update a contact. If a contact with the same name exists, it will be updated. ' +
        'Use when the user shares someone\'s info: phone, email, birthday, address, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Contact name (full name)' },
          phone: { type: 'string', description: 'Phone number' },
          email: { type: 'string', description: 'Email address' },
          birthday: { type: 'string', description: 'Birthday (YYYY-MM-DD or free text like "March 15")' },
          address: { type: 'string', description: 'Mailing address' },
          relationship: { type: 'string', description: 'Relationship (friend, colleague, family, etc.)' },
          company: { type: 'string', description: 'Company/organization' },
          notes: { type: 'string', description: 'Any additional notes' },
        },
        required: ['name'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const store = loadStore(config);
          const name = input.name as string;
          const now = Date.now();

          // Check if contact exists (case-insensitive)
          const existing = store.contacts.find(
            c => c.name.toLowerCase() === name.toLowerCase(),
          );

          if (existing) {
            // Update existing — only overwrite fields that are provided
            if (input.phone !== undefined) existing.phone = input.phone as string;
            if (input.email !== undefined) existing.email = input.email as string;
            if (input.birthday !== undefined) existing.birthday = input.birthday as string;
            if (input.address !== undefined) existing.address = input.address as string;
            if (input.relationship !== undefined) existing.relationship = input.relationship as string;
            if (input.company !== undefined) existing.company = input.company as string;
            if (input.notes !== undefined) existing.notes = input.notes as string;
            existing.updated_at = now;
            saveStore(config, store);

            return JSON.stringify({ success: true, action: 'updated', contact: existing });
          } else {
            // Create new
            const contact: Contact = {
              id: `ct_${now}_${Math.random().toString(36).slice(2, 6)}`,
              name,
              phone: input.phone as string | undefined,
              email: input.email as string | undefined,
              birthday: input.birthday as string | undefined,
              address: input.address as string | undefined,
              relationship: input.relationship as string | undefined,
              company: input.company as string | undefined,
              notes: input.notes as string | undefined,
              created_at: now,
              updated_at: now,
            };
            store.contacts.push(contact);
            saveStore(config, store);

            return JSON.stringify({ success: true, action: 'created', contact });
          }
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'contact_search',
      description:
        'Search contacts by name or any field. Use when the user asks about someone\'s info.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search term — matches against name, company, relationship, notes',
          },
        },
        required: ['query'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const store = loadStore(config);
          const query = (input.query as string).toLowerCase();

          const matches = store.contacts.filter(c => {
            const searchable = [
              c.name, c.phone, c.email, c.company,
              c.relationship, c.notes, c.address,
            ].filter(Boolean).join(' ').toLowerCase();
            return searchable.includes(query);
          });

          return JSON.stringify({
            success: true,
            count: matches.length,
            contacts: matches,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'contact_list',
      description: 'List all contacts, optionally filtered by relationship.',
      inputSchema: {
        type: 'object',
        properties: {
          relationship: {
            type: 'string',
            description: 'Filter by relationship type (e.g. "family", "colleague")',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const store = loadStore(config);
          let contacts = store.contacts;

          if (input.relationship) {
            const rel = (input.relationship as string).toLowerCase();
            contacts = contacts.filter(c =>
              c.relationship?.toLowerCase().includes(rel),
            );
          }

          contacts.sort((a, b) => a.name.localeCompare(b.name));

          return JSON.stringify({
            success: true,
            count: contacts.length,
            contacts: contacts.map(c => ({
              id: c.id,
              name: c.name,
              relationship: c.relationship || null,
              phone: c.phone || null,
              email: c.email || null,
            })),
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'contact_delete',
      description: 'Delete a contact by ID or name.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Contact ID' },
          name: { type: 'string', description: 'Contact name (used if ID not provided)' },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const store = loadStore(config);
          let idx: number;

          if (input.id) {
            idx = store.contacts.findIndex(c => c.id === input.id);
          } else if (input.name) {
            const name = (input.name as string).toLowerCase();
            idx = store.contacts.findIndex(c => c.name.toLowerCase() === name);
          } else {
            return JSON.stringify({ success: false, error: 'Provide id or name.' });
          }

          if (idx === -1) {
            return JSON.stringify({ success: false, error: 'Contact not found.' });
          }

          const removed = store.contacts.splice(idx, 1)[0];
          saveStore(config, store);
          return JSON.stringify({ success: true, deleted: { id: removed.id, name: removed.name } });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },
  ];
}
