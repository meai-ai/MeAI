/**
 * X (Twitter) social posting provider.
 *
 * Extracted from src/social.ts + src/x-client.ts.
 * This is a stub that delegates to the existing XClient.
 *
 * Requires: X API credentials in config.
 */

import type { AppConfig } from "../../types.js";
import type { ExpressionProvider, ExpressionType } from "../types.js";
import { XClient, type XCredentials } from "../../x-client.js";

let hasCredentials = false;
let xClient: XClient | null = null;

const provider: ExpressionProvider = {
  id: "social-x",
  type: "social_post" as ExpressionType,
  name: "X (Twitter) Social Posting",

  init(config: AppConfig): void {
    hasCredentials = !!(
      config.xApiKey &&
      config.xApiKeySecret &&
      config.xAccessToken &&
      config.xAccessTokenSecret
    );
    if (hasCredentials) {
      xClient = new XClient({
        apiKey: config.xApiKey!,
        apiKeySecret: config.xApiKeySecret!,
        accessToken: config.xAccessToken!,
        accessTokenSecret: config.xAccessTokenSecret!,
      });
      console.log("[expressions:social-x] X API credentials configured");
    }
  },

  isAvailable(): boolean {
    return hasCredentials;
  },

  async postSocial(text: string, _media?: Buffer): Promise<{ postId?: string; url?: string }> {
    if (!hasCredentials || !xClient) throw new Error("X API credentials not configured");

    const result = await xClient.postTweet(text);
    if (!result.success) {
      throw new Error(`X post failed: ${result.error ?? "unknown error"}`);
    }

    const url = result.tweetId ? `https://x.com/i/status/${result.tweetId}` : undefined;
    return { postId: result.tweetId, url };
  },
};

export default provider;
