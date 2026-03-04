/**
 * Repair common LLM JSON output issues and parse.
 * Handles: trailing commas, unescaped newlines/tabs, control chars, unescaped quotes.
 * Returns null if JSON cannot be repaired.
 */
export function repairAndParseJson(raw: string): any {
  let s = raw;
  // 1. Remove trailing commas before } or ]
  s = s.replace(/,\s*([\]}])/g, "$1");
  // 2. Replace unescaped newlines/tabs inside string values
  s = s.replace(/"([^"]*?)"/g, (_m, content: string) =>
    `"${content.replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`,
  );
  try {
    return JSON.parse(s);
  } catch {
    // Second attempt: strip all control chars
    s = s.replace(/[\x00-\x1f]/g, " ");
    try {
      return JSON.parse(s);
    } catch {
      // Third attempt: fix unescaped quotes inside string values
      try {
        s = s.replace(/"([^"]*?)"\s*:/g, (m) => `<<<${m}>>>`);
        s = s.replace(/:\s*"((?:[^"\\]|\\.)*)"/g, (_m, val: string) => {
          return `: "${val.replace(/(?<!\\)"/g, '\\"')}"`;
        });
        s = s.replace(/<<<(".*?"\s*:)>>>/g, "$1");
        return JSON.parse(s);
      } catch {
        // All repair attempts failed
        return null;
      }
    }
  }
}
