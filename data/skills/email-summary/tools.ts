/**
 * Email summary skill — read Gmail via IMAP over TLS.
 * Minimal IMAP client using Node's built-in tls module.
 * READ-ONLY: never sends, deletes, or modifies emails.
 *
 * Requires: email.imap_user and email.imap_app_password stored in MeAI memory.
 */

import * as tls from 'tls';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ── Memory reader (to get credentials) ──────────────────────────────────────

interface Memory {
  key: string;
  value: string;
  timestamp: number;
  confidence: number;
}

function getMemoryValue(config: any, key: string): string | null {
  try {
    const statePath = config?.statePath || 'data';
    const storePath = join(statePath, 'memory', 'store.json');
    if (!existsSync(storePath)) return null;
    const store = JSON.parse(readFileSync(storePath, 'utf-8'));
    const mem = (store.memories as Memory[]).find(m => m.key === key);
    return mem?.value || null;
  } catch {
    return null;
  }
}

// ── Minimal IMAP client over TLS ────────────────────────────────────────────

interface EmailHeader {
  uid: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

class SimpleIMAP {
  private socket: tls.TLSSocket | null = null;
  private buffer = '';
  private tagCounter = 0;
  private dataHandler: ((data: string) => void) | null = null;

  async connect(host: string, port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);

      this.socket = tls.connect({ host, port, rejectUnauthorized: true }, () => {
        clearTimeout(timeout);
      });

      let greeting = '';
      const onData = (data: Buffer) => {
        greeting += data.toString();
        if (greeting.includes('\r\n')) {
          this.socket!.removeListener('data', onData);
          this.setupDataHandler();
          resolve(greeting.trim());
        }
      };

      this.socket.on('data', onData);
      this.socket.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  private setupDataHandler(): void {
    if (!this.socket) return;
    this.socket.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      if (this.dataHandler) {
        this.dataHandler(this.buffer);
      }
    });
  }

  private nextTag(): string {
    return `A${++this.tagCounter}`;
  }

  async command(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket) { reject(new Error('Not connected')); return; }

      const tag = this.nextTag();
      const fullCmd = `${tag} ${cmd}\r\n`;
      this.buffer = '';

      const timeout = setTimeout(() => {
        this.dataHandler = null;
        reject(new Error(`Command timeout: ${cmd.split(' ')[0]}`));
      }, 15000);

      this.dataHandler = (buf: string) => {
        // Check if the tagged response is complete
        const tagOK = `${tag} OK`;
        const tagNO = `${tag} NO`;
        const tagBAD = `${tag} BAD`;

        if (buf.includes(tagOK) || buf.includes(tagNO) || buf.includes(tagBAD)) {
          clearTimeout(timeout);
          this.dataHandler = null;
          const response = this.buffer;
          this.buffer = '';

          if (buf.includes(tagNO) || buf.includes(tagBAD)) {
            reject(new Error(`IMAP error: ${response.trim()}`));
          } else {
            resolve(response.trim());
          }
        }
      };

      this.socket.write(fullCmd);
    });
  }

  async login(user: string, pass: string): Promise<string> {
    // Escape special chars in password
    const escapedPass = `"${pass.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return this.command(`LOGIN "${user}" ${escapedPass}`);
  }

  async select(mailbox: string): Promise<string> {
    return this.command(`SELECT "${mailbox}"`);
  }

  async search(criteria: string): Promise<string[]> {
    const response = await this.command(`SEARCH ${criteria}`);
    const match = response.match(/\* SEARCH ([\d\s]+)/);
    if (!match) return [];
    return match[1].trim().split(/\s+/).filter(Boolean);
  }

  async fetchHeaders(uids: string[]): Promise<EmailHeader[]> {
    if (uids.length === 0) return [];

    const headers: EmailHeader[] = [];
    // Fetch in batches to avoid overwhelming the connection
    const batch = uids.slice(-50); // Last 50 (most recent)

    const uidList = batch.join(',');
    const response = await this.command(
      `FETCH ${uidList} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`,
    );

    // Parse the FETCH responses
    const fetchBlocks = response.split(/\* \d+ FETCH/);

    for (const block of fetchBlocks) {
      if (!block.trim()) continue;

      const from = extractHeader(block, 'From') || '(unknown)';
      const subject = extractHeader(block, 'Subject') || '(no subject)';
      const date = extractHeader(block, 'Date') || '';

      // Decode MIME encoded words
      const decodedFrom = decodeMimeWords(from);
      const decodedSubject = decodeMimeWords(subject);

      if (decodedFrom !== '(unknown)' || decodedSubject !== '(no subject)') {
        headers.push({
          uid: '',
          from: decodedFrom,
          subject: decodedSubject,
          date: formatEmailDate(date),
          snippet: '',
        });
      }
    }

    return headers;
  }

  async logout(): Promise<void> {
    try {
      await this.command('LOGOUT');
    } catch {
      // Best-effort
    }
    this.socket?.destroy();
    this.socket = null;
  }

  destroy(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

// ── Header parsing helpers ──────────────────────────────────────────────────

function extractHeader(block: string, name: string): string | null {
  // Match header, handling multi-line continuation (lines starting with whitespace)
  const regex = new RegExp(`${name}:\\s*(.+(?:\\r?\\n[ \\t]+.+)*)`, 'i');
  const match = block.match(regex);
  if (!match) return null;
  return match[1].replace(/\r?\n[ \t]+/g, ' ').trim();
}

function decodeMimeWords(text: string): string {
  // Decode =?charset?encoding?text?= patterns
  return text.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_, charset, encoding, encoded) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        // Base64
        return Buffer.from(encoded, 'base64').toString('utf-8');
      } else {
        // Quoted-printable
        return encoded
          .replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (_: string, hex: string) =>
            String.fromCharCode(parseInt(hex, 16)),
          );
      }
    } catch {
      return encoded;
    }
  });
}

function formatEmailDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

// ── Tool exports ────────────────────────────────────────────────────────────

export function getTools(config?: any): any[] {
  return [
    {
      name: 'email_check',
      description:
        'Check Gmail for unread emails. Returns subject, sender, and date for each unread message. ' +
        'READ-ONLY — never modifies the inbox. ' +
        'Requires email.imap_user and email.imap_app_password in memory. ' +
        'Use when the user asks about their email, inbox status, or messages from someone.',
      inputSchema: {
        type: 'object',
        properties: {
          max_emails: {
            type: 'number',
            description: 'Maximum unread emails to return. Default: 15.',
          },
          from_filter: {
            type: 'string',
            description: 'Optional: only show emails from this sender (partial match).',
          },
          mailbox: {
            type: 'string',
            description: 'Mailbox to check. Default: INBOX.',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const imap = new SimpleIMAP();

        try {
          // Get credentials from memory
          const user = getMemoryValue(config, 'email.imap_user');
          const pass = getMemoryValue(config, 'email.imap_app_password');

          if (!user || !pass) {
            return JSON.stringify({
              success: false,
              error: 'Email credentials not configured.',
              setup: 'Use memory_set to store email.imap_user (Gmail address) and email.imap_app_password (Google App Password). See SKILL.md for setup instructions.',
            });
          }

          const maxEmails = (input.max_emails as number) || 15;
          const fromFilter = (input.from_filter as string) || '';
          const mailbox = (input.mailbox as string) || 'INBOX';

          // Connect and authenticate
          await imap.connect('imap.gmail.com', 993);
          await imap.login(user, pass);
          await imap.select(mailbox);

          // Search for unseen messages
          let searchCriteria = 'UNSEEN';
          if (fromFilter) {
            searchCriteria = `UNSEEN FROM "${fromFilter}"`;
          }

          const messageIds = await imap.search(searchCriteria);

          if (messageIds.length === 0) {
            await imap.logout();
            return JSON.stringify({
              success: true,
              unread_count: 0,
              emails: [],
              message: fromFilter
                ? `No unread emails from "${fromFilter}".`
                : 'Inbox zero! No unread emails.',
            });
          }

          // Fetch the most recent ones
          const recentIds = messageIds.slice(-maxEmails);
          const headers = await imap.fetchHeaders(recentIds);

          await imap.logout();

          // Apply from filter on results (in case IMAP search was too broad)
          let filtered = headers;
          if (fromFilter) {
            const lowerFilter = fromFilter.toLowerCase();
            filtered = headers.filter(h => h.from.toLowerCase().includes(lowerFilter));
          }

          // Reverse so newest is first
          filtered.reverse();

          return JSON.stringify({
            success: true,
            unread_count: messageIds.length,
            showing: filtered.length,
            emails: filtered.map(h => ({
              from: h.from,
              subject: h.subject,
              date: h.date,
            })),
          });
        } catch (err: any) {
          imap.destroy();

          // Provide helpful error messages
          const errMsg = err.message || String(err);
          if (errMsg.includes('AUTHENTICATIONFAILED')) {
            return JSON.stringify({
              success: false,
              error: 'Authentication failed. Check email.imap_user and email.imap_app_password in memory.',
              hint: 'Make sure you\'re using a Google App Password, not your regular Gmail password.',
            });
          }

          return JSON.stringify({ success: false, error: errMsg });
        }
      },
    },

    {
      name: 'email_count',
      description:
        'Quick check: how many unread emails in the inbox. Faster than email_check.',
      inputSchema: {
        type: 'object',
        properties: {
          mailbox: {
            type: 'string',
            description: 'Mailbox to check. Default: INBOX.',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const imap = new SimpleIMAP();

        try {
          const user = getMemoryValue(config, 'email.imap_user');
          const pass = getMemoryValue(config, 'email.imap_app_password');

          if (!user || !pass) {
            return JSON.stringify({
              success: false,
              error: 'Email credentials not configured. Use memory_set to store email.imap_user and email.imap_app_password.',
            });
          }

          const mailbox = (input.mailbox as string) || 'INBOX';

          await imap.connect('imap.gmail.com', 993);
          await imap.login(user, pass);

          const selectResponse = await imap.select(mailbox);

          // Parse EXISTS count from SELECT response
          const existsMatch = selectResponse.match(/\* (\d+) EXISTS/);
          const totalCount = existsMatch ? parseInt(existsMatch[1]) : 0;

          // Count unseen
          const unseenIds = await imap.search('UNSEEN');

          await imap.logout();

          return JSON.stringify({
            success: true,
            mailbox,
            total: totalCount,
            unread: unseenIds.length,
          });
        } catch (err: any) {
          imap.destroy();
          return JSON.stringify({ success: false, error: err.message || String(err) });
        }
      },
    },
  ];
}
