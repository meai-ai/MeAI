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

// ── State ────────────────────────────────────────────────────────────

let docsDir = "";
let indexPath = "";

// ── Init ─────────────────────────────────────────────────────────────

export function initDocuments(statePath: string): void {
  docsDir = path.join(statePath, "documents");
  indexPath = path.join(docsDir, "index.json");

  // Ensure directory exists
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  // Ensure index exists
  if (!fs.existsSync(indexPath)) {
    writeJsonAtomic(indexPath, { documents: [] });
  }

  // Scan for unindexed files
  syncIndex();
}

// ── Index Management ─────────────────────────────────────────────────

function loadIndex(): DocumentIndex {
  return readJsonSafe(indexPath, { documents: [] });
}

function saveIndex(index: DocumentIndex): void {
  writeJsonAtomic(indexPath, index);
}

/** Scan documents dir for files not in the index and add them. */
function syncIndex(): void {
  const index = loadIndex();
  const indexed = new Set(index.documents.map(d => d.filename));

  const files = fs.readdirSync(docsDir).filter(f =>
    !f.startsWith(".") &&
    f !== "index.json" &&
    fs.statSync(path.join(docsDir, f)).isFile()
  );

  let added = 0;
  for (const file of files) {
    if (!indexed.has(file)) {
      const stat = fs.statSync(path.join(docsDir, file));
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
    fs.existsSync(path.join(docsDir, d.filename))
  );

  if (added > 0) {
    saveIndex(index);
    console.log(`[documents] Synced index: ${added} new file(s) found`);
  }
}

// ── Public API ───────────────────────────────────────────────────────

export function getDocumentIndex(): DocumentEntry[] {
  return loadIndex().documents;
}

export function getDocumentsDir(): string {
  return docsDir;
}

/** Format document list for system prompt context. */
export function formatDocumentContext(): string {
  const docs = getDocumentIndex();
  if (docs.length === 0) return "";

  const lines = docs.map(d => {
    const date = pstDateStr(new Date(d.updatedAt));
    const tags = d.tags.length > 0 ? ` [${d.tags.join(", ")}]` : "";
    return `- ${d.title} (${d.filename}, ${date})${tags}\n  ${d.summary}`;
  });

  return `${s().headers.my_documents}:\n${lines.join("\n")}`;
}
