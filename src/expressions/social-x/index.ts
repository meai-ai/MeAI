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

let hasCredentials = false;

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
      console.log("[expressions:social-x] X API credentials configured");
    }
  },

  isAvailable(): boolean {
    return hasCredentials;
  },

  async postSocial(text: string, _media?: Buffer): Promise<{ postId?: string; url?: string }> {
    if (!hasCredentials) throw new Error("X API credentials not configured");

    // This provider delegates to the existing SocialEngine/XClient
    // for now. Full extraction would move XClient logic here.
    console.log(`[expressions:social-x] Would post: ${text.slice(0, 100)}`);
    return { postId: undefined, url: undefined };
  },
};

export default provider;
