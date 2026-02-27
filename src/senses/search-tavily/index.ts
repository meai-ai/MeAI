/**
 * Tavily search sense provider.
 *
 * Extracted from src/lib/search.ts. Uses Tavily's paid API
 * for AI-ranked, high-quality web search results.
 *
 * Requires: config.tavilyApiKey
 */

import * as https from "https";
import type { AppConfig } from "../../types.js";
import type { SenseProvider, SenseType, SearchResult } from "../types.js";

let tavilyApiKey: string | undefined;

const provider: SenseProvider = {
  id: "search-tavily",
  type: "search" as SenseType,
  name: "Tavily AI Search",

  init(config: AppConfig): void {
    tavilyApiKey = config.tavilyApiKey;
    if (tavilyApiKey) {
      console.log("[senses:search-tavily] Tavily API configured");
    }
  },

  isAvailable(): boolean {
    return !!tavilyApiKey;
  },

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    if (!tavilyApiKey) throw new Error("Tavily API key not configured");

    const body = JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: "basic",
      include_raw_content: false,
      include_answer: false,
      topic: "general",
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.tavily.com",
        path: "/search",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tavilyApiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`Tavily API error ${res.statusCode}: ${data.slice(0, 200)}`));
              return;
            }
            const json = JSON.parse(data);
            const results: SearchResult[] = (json.results ?? []).map((r: any) => ({
              title: r.title ?? "",
              url: r.url ?? "",
              snippet: r.content ?? "",
              content: r.raw_content || undefined,
              score: r.score,
            }));
            resolve(results);
          } catch (err) {
            reject(new Error(`Failed to parse Tavily response: ${err}`));
          }
        });
      });

      req.on("error", reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("Tavily timeout")); });
      req.write(body);
      req.end();
    });
  },
};

export default provider;
