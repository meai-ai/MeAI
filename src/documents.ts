/**
 * Document Store — manages documents the character creates.
 *
 * Manages documents that the character creates via run_claude_code (summaries, analyses,
 * reports, etc.). Provides an index so the character knows what has been written and can
 * reference or update them.
 *
 * Documents live in data/documents/ with a JSON index for metadata.
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { pstDateStr } from "./lib/pst-date.js";
import { s } from "./character.js";

// ── Types ────────────────────────────────────────────────────────────

export interface DocumentEntry {
  /** Unique ID */
  id: string;
  /** Human-readable title */
  title: string;
  /** Filename relative to documents dir */
  filename: string;
  /** One-line summary */
  summary: string;
  /** Optional tags for categorization */
  tags: string[];
  /** Creation timestamp */
  createdAt: number;
  /** Last updated timestamp */
  updatedAt: number;
}

interface DocumentIndex {
  documents: DocumentEntry[];
}

// ── Class ────────────────────────────────────────────────────────────

export class DocumentsEngine {
  private docsDir: string;
  private indexPath: string;

  constructor(statePath: string) {
    this.docsDir = path.join(statePath, "documents");
    this.indexPath = path.join(this.docsDir, "index.json");

    // Ensure directory exists
    if (!fs.existsSync(this.docsDir)) {
      fs.mkdirSync(this.docsDir, { recursive: true });
    }

    // Ensure index exists
    if (!fs.existsSync(this.indexPath)) {
      writeJsonAtomic(this.indexPath, { documents: [] });
    }

    // Scan for unindexed files
    this.syncIndex();
  }

  // ── Index Management ─────────────────────────────────────────────────

  private loadIndex(): DocumentIndex {
    return readJsonSafe(this.indexPath, { documents: [] });
  }

  private saveIndex(index: DocumentIndex): void {
    writeJsonAtomic(this.indexPath, index);
  }

  /** Scan documents dir for files not in the index and add them. */
  private syncIndex(): void {
    const index = this.loadIndex();
    const indexed = new Set(index.documents.map(d => d.filename));

    const files = fs.readdirSync(this.docsDir).filter(f =>
      !f.startsWith(".") &&
      f !== "index.json" &&
      fs.statSync(path.join(this.docsDir, f)).isFile()
    );

    let added = 0;
    for (const file of files) {
      if (!indexed.has(file)) {
        const stat = fs.statSync(path.join(this.docsDir, file));
        const title = file
          .replace(/\.[^.]+$/, "")       // strip extension
          .replace(/[-_]/g, " ")         // normalize separators
          .replace(/\b\w/g, c => c.toUpperCase()); // title case

        index.documents.push({
          id: `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          title,
          filename: file,
          summary: "(auto-indexed, no summary yet)",
          tags: [],
          createdAt: stat.birthtimeMs || stat.mtimeMs,
          updatedAt: stat.mtimeMs,
        });
        added++;
      }
    }

    // Remove entries whose files no longer exist
    index.documents = index.documents.filter(d =>
      fs.existsSync(path.join(this.docsDir, d.filename))
    );

    if (added > 0) {
      this.saveIndex(index);
      console.log(`[documents] Synced index: ${added} new file(s) found`);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────

  getDocumentIndex(): DocumentEntry[] {
    return this.loadIndex().documents;
  }

  getDocumentsDir(): string {
    return this.docsDir;
  }

  /** Format document list for system prompt context. */
  formatDocumentContext(): string {
    const docs = this.getDocumentIndex();
    if (docs.length === 0) return "";

    const lines = docs.map(d => {
      const date = pstDateStr(new Date(d.updatedAt));
      const tags = d.tags.length > 0 ? ` [${d.tags.join(", ")}]` : "";
      return `- ${d.title} (${d.filename}, ${date})${tags}\n  ${d.summary}`;
    });

    return `${s().headers.my_documents}:\n${lines.join("\n")}`;
  }
}

// ── Backward-compat singleton ────────────────────────────────────────

let _singleton: DocumentsEngine | null = null;

export function initDocuments(statePath: string): DocumentsEngine {
  _singleton = new DocumentsEngine(statePath);
  return _singleton;
}

function _get(): DocumentsEngine {
  if (!_singleton) throw new Error("initDocuments() not called");
  return _singleton;
}

export function getDocumentIndex(): DocumentEntry[] { return _get().getDocumentIndex(); }
export function getDocumentsDir(): string { return _get().getDocumentsDir(); }
export function formatDocumentContext(): string { return _get().formatDocumentContext(); }
