
import { readFile, readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";

interface AppConfig {
  [key: string]: any;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  execute: (params: Record<string, any>) => Promise<string>;
}

const ALLOWED_BASE = homedir();

function isAllowedPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  return resolved.startsWith(ALLOWED_BASE);
}

export function getTools(config: AppConfig): ToolDefinition[] {
  return [
    {
      name: "read_file",
      description: `Read contents of a file. Only files under ${ALLOWED_BASE}/ are accessible.`,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file to read"
          },
          tail: {
            type: "number",
            description: "Only return the last N lines (optional)"
          }
        },
        required: ["path"]
      },
      execute: async (params: Record<string, any>): Promise<string> => {
        const filePath = params.path as string;
        if (!isAllowedPath(filePath)) {
          return `Error: Access denied. Only files under ${ALLOWED_BASE}/ are accessible.`;
        }
        try {
          const content = await readFile(filePath, "utf-8");
          if (params.tail) {
            const lines = content.split("\n");
            const tail = Number(params.tail);
            return lines.slice(-tail).join("\n");
          }
          return content;
        } catch (e: any) {
          return `Error reading file: ${e.message}`;
        }
      }
    },
    {
      name: "list_dir",
      description: `List contents of a directory. Only directories under ${ALLOWED_BASE}/ are accessible.`,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the directory"
          }
        },
        required: ["path"]
      },
      execute: async (params: Record<string, any>): Promise<string> => {
        const dirPath = params.path as string;
        if (!isAllowedPath(dirPath)) {
          return `Error: Access denied. Only directories under ${ALLOWED_BASE}/ are accessible.`;
        }
        try {
          const entries = await readdir(dirPath);
          const results = [];
          for (const entry of entries) {
            try {
              const fullPath = join(dirPath, entry);
              const s = await stat(fullPath);
              const type = s.isDirectory() ? "📁" : "📄";
              const size = s.isFile() ? ` (${s.size} bytes)` : "";
              results.push(`${type} ${entry}${size}`);
            } catch {
              results.push(`❓ ${entry}`);
            }
          }
          return results.join("\n") || "Empty directory";
        } catch (e: any) {
          return `Error listing directory: ${e.message}`;
        }
      }
    }
  ];
}
