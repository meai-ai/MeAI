/**
 * Notes skill — quick-capture notes stored as markdown files.
 * Supports tagging, search, and append-to-existing.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

// ── Helpers ─────────────────────────────────────────────────────────────────

function getNotesDir(config: any): string {
  const statePath = config?.statePath || 'data';
  const dir = join(statePath, 'skills', 'notes', 'entries');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function formatTimestamp(): string {
  const pst = new Date().toLocaleString("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return pst.replace(/[/:, ]+/g, "-");
}

interface NoteMeta {
  filename: string;
  title: string;
  tags: string[];
  created: string;
  preview: string;
}

function parseNoteMeta(filename: string, content: string): NoteMeta {
  const lines = content.split('\n');
  const title = lines[0]?.replace(/^#\s*/, '').trim() || filename;

  // Extract tags from frontmatter or inline
  const tagMatch = content.match(/tags:\s*\[([^\]]*)\]/);
  const tags = tagMatch
    ? tagMatch[1].split(',').map(t => t.trim().replace(/['"]/g, '')).filter(Boolean)
    : [];

  // Extract created date
  const dateMatch = content.match(/created:\s*(\S+)/);
  const created = dateMatch ? dateMatch[1] : '';

  // Preview: first non-empty, non-header, non-frontmatter line
  const preview = lines
    .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('tags:') && !l.startsWith('created:'))
    .slice(0, 2)
    .join(' ')
    .slice(0, 150);

  return { filename, title, tags, created, preview };
}

// ── Tool exports ────────────────────────────────────────────────────────────

export function getTools(config?: any): any[] {
  return [
    {
      name: 'note_create',
      description:
        'Create a new note. Use for capturing ideas, meeting notes, lists, or any freeform text. ' +
        'Each note is a markdown file with a title, optional tags, and body text.',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Note title',
          },
          content: {
            type: 'string',
            description: 'Note body (markdown supported)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for categorization (e.g. ["work", "idea"])',
          },
        },
        required: ['title', 'content'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const dir = getNotesDir(config);
          const title = input.title as string;
          const content = input.content as string;
          const tags = (input.tags as string[]) || [];
          const ts = formatTimestamp();
          const filename = `${ts}_${slugify(title)}.md`;

          const noteContent = [
            `# ${title}`,
            '',
            `created: ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}`,
            tags.length > 0 ? `tags: [${tags.join(', ')}]` : '',
            '',
            '---',
            '',
            content,
            '',
          ].filter(line => line !== undefined).join('\n');

          writeFileSync(join(dir, filename), noteContent);

          return JSON.stringify({
            success: true,
            filename,
            title,
            tags,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'note_append',
      description:
        'Append text to an existing note. Use when the user wants to add more to a previous note.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'The filename of the note to append to (from note_search or note_list)',
          },
          content: {
            type: 'string',
            description: 'Text to append',
          },
        },
        required: ['filename', 'content'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const dir = getNotesDir(config);
          const filepath = join(dir, input.filename as string);

          if (!existsSync(filepath)) {
            return JSON.stringify({ success: false, error: 'Note not found.' });
          }

          const existing = readFileSync(filepath, 'utf-8');
          const updated = existing.trimEnd() + '\n\n' + (input.content as string) + '\n';
          writeFileSync(filepath, updated);

          return JSON.stringify({
            success: true,
            filename: input.filename,
            message: 'Content appended.',
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'note_search',
      description:
        'Search notes by keyword or tag. Returns matching notes with previews.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search keyword (searches title and content)',
          },
          tag: {
            type: 'string',
            description: 'Filter by tag',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const dir = getNotesDir(config);
          if (!existsSync(dir)) {
            return JSON.stringify({ success: true, count: 0, notes: [] });
          }

          const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse();
          const query = ((input.query as string) || '').toLowerCase();
          const tag = ((input.tag as string) || '').toLowerCase();

          const results: NoteMeta[] = [];

          for (const file of files) {
            const content = readFileSync(join(dir, file), 'utf-8');
            const meta = parseNoteMeta(file, content);

            let matches = true;
            if (query) {
              matches = content.toLowerCase().includes(query) || meta.title.toLowerCase().includes(query);
            }
            if (tag) {
              matches = matches && meta.tags.some(t => t.toLowerCase() === tag);
            }

            if (matches) results.push(meta);
            if (results.length >= 20) break;
          }

          return JSON.stringify({
            success: true,
            count: results.length,
            notes: results,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'note_read',
      description: 'Read the full content of a specific note.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'The filename to read',
          },
        },
        required: ['filename'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const dir = getNotesDir(config);
          const filepath = join(dir, input.filename as string);

          if (!existsSync(filepath)) {
            return JSON.stringify({ success: false, error: 'Note not found.' });
          }

          const content = readFileSync(filepath, 'utf-8');
          return JSON.stringify({
            success: true,
            filename: input.filename,
            content,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },
  ];
}
