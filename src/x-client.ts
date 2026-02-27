/**
 * X (Twitter) API v2 client — zero external dependencies.
 *
 * Uses Node.js built-in crypto for OAuth 1.0a signing.
 * Supports both posting tweets and reading timelines/searches.
 *
 * Required credentials (from X Developer Portal):
 * - API Key (Consumer Key)
 * - API Key Secret (Consumer Secret)
 * - Access Token
 * - Access Token Secret
 */

import * as https from "https";
import * as crypto from "crypto";

// ── Types ────────────────────────────────────────────────────────────

export interface XCredentials {
  apiKey: string;
  apiKeySecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export interface Tweet {
  id: string;
  text: string;
  authorId?: string;
  authorName?: string;
  authorUsername?: string;
  createdAt?: string;
  /** Public engagement metrics */
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
}

export interface PostTweetResult {
  success: boolean;
  tweetId?: string;
  error?: string;
}

export interface SearchResult {
  tweets: Tweet[];
  nextToken?: string;
}

// ── OAuth 1.0a Signing ──────────────────────────────────────────────

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

function generateTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

/**
 * Build OAuth 1.0a Authorization header.
 * See: https://developer.twitter.com/en/docs/authentication/oauth-1-0a/creating-a-signature
 */
function buildOAuthHeader(
  method: string,
  url: string,
  params: Record<string, string>,
  creds: XCredentials,
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: generateNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: generateTimestamp(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  // Combine all params for signature base string
  const allParams = { ...params, ...oauthParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join("&");

  // Signature base string
  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;

  // Signing key
  const signingKey = `${percentEncode(creds.apiKeySecret)}&${percentEncode(creds.accessTokenSecret)}`;

  // HMAC-SHA1 signature
  const signature = crypto
    .createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  oauthParams.oauth_signature = signature;

  // Build Authorization header
  const headerParams = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(", ");

  return `OAuth ${headerParams}`;
}

// ── HTTP helper ──────────────────────────────────────────────────────

function xRequest(
  method: string,
  urlStr: string,
  creds: XCredentials,
  body?: string,
  queryParams?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);

    // Add query params
    if (queryParams) {
      for (const [k, v] of Object.entries(queryParams)) {
        url.searchParams.set(k, v);
      }
    }

    // For OAuth signing, we need the base URL (no query params) and all params
    const baseUrl = `${url.protocol}//${url.hostname}${url.pathname}`;
    const signParams: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) {
      signParams[k] = v;
    }

    const authHeader = buildOAuthHeader(method, baseUrl, signParams, creds);

    const headers: Record<string, string> = {
      Authorization: authHeader,
      "User-Agent": "MeAI/1.0",
    };

    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body).toString();
    }

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );

    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("X API timeout")); });

    if (body) req.write(body);
    req.end();
  });
}

// ── X API Client ────────────────────────────────────────────────────

export class XClient {
  private creds: XCredentials;

  constructor(creds: XCredentials) {
    this.creds = creds;
  }

  // ── Write Operations ──────────────────────────────────────────────

  /** Post a new tweet. */
  async postTweet(text: string): Promise<PostTweetResult> {
    try {
      const body = JSON.stringify({ text });
      const res = await xRequest(
        "POST",
        "https://api.x.com/2/tweets",
        this.creds,
        body,
      );

      if (res.status === 201) {
        const data = JSON.parse(res.body);
        return { success: true, tweetId: data.data?.id };
      }

      return {
        success: false,
        error: `HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** Reply to an existing tweet. */
  async replyToTweet(text: string, replyToId: string): Promise<PostTweetResult> {
    try {
      const body = JSON.stringify({
        text,
        reply: { in_reply_to_tweet_id: replyToId },
      });
      const res = await xRequest(
        "POST",
        "https://api.x.com/2/tweets",
        this.creds,
        body,
      );

      if (res.status === 201) {
        const data = JSON.parse(res.body);
        return { success: true, tweetId: data.data?.id };
      }

      return {
        success: false,
        error: `HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // ── Read Operations ───────────────────────────────────────────────

  /**
   * Search recent tweets (last 7 days).
   * Useful for getting real-time information about topics.
   */
  async searchRecent(query: string, maxResults = 10): Promise<SearchResult> {
    try {
      // Twitter API constraints:
      // - Query max 512 chars; truncate at last word boundary if too long
      // - max_results minimum is 10, maximum is 100
      let q = query.slice(0, 512);
      if (q.length < query.length) {
        const lastSpace = q.lastIndexOf(" ");
        if (lastSpace > 0) q = q.slice(0, lastSpace);
      }

      const res = await xRequest(
        "GET",
        "https://api.x.com/2/tweets/search/recent",
        this.creds,
        undefined,
        {
          query: q,
          max_results: String(Math.max(10, Math.min(maxResults, 100))),
          "tweet.fields": "created_at,public_metrics,author_id",
          expansions: "author_id",
          "user.fields": "name,username",
        },
      );

      if (res.status === 402) {
        // Search requires Basic tier ($100/mo) — not available on free plan, skip silently
        return { tweets: [] };
      }
      if (res.status !== 200) {
        console.error(`[x-client] Search error: HTTP ${res.status}`, res.body.slice(0, 200));
        return { tweets: [] };
      }

      return this.parseSearchResponse(res.body);
    } catch (err) {
      console.error("[x-client] Search error:", err);
      return { tweets: [] };
    }
  }

  /**
   * Get home timeline (reverse chronological).
   * Shows tweets from accounts the user follows.
   */
  async getTimeline(userId: string, maxResults = 20): Promise<Tweet[]> {
    try {
      const res = await xRequest(
        "GET",
        `https://api.x.com/2/users/${userId}/timelines/reverse_chronological`,
        this.creds,
        undefined,
        {
          max_results: String(Math.min(maxResults, 100)),
          "tweet.fields": "created_at,public_metrics,author_id",
          expansions: "author_id",
          "user.fields": "name,username",
        },
      );

      if (res.status !== 200) {
        // 402 = paid Basic tier required; don't spam logs for known limitation
        if (res.status !== 402) console.warn(`[x-client] Timeline error: HTTP ${res.status}`);
        return [];
      }

      return this.parseSearchResponse(res.body).tweets;
    } catch (err) {
      console.warn("[x-client] Timeline error:", err);
      return [];
    }
  }

  /**
   * Get trending topics for a specific location.
   * WOEID 23424977 = United States, 2459115 = New York
   */
  async getTrending(woeid = 2459115): Promise<string[]> {
    try {
      // Trending uses v1.1 API (not yet migrated to v2)
      const res = await xRequest(
        "GET",
        "https://api.x.com/1.1/trends/place.json",
        this.creds,
        undefined,
        { id: String(woeid) },
      );

      if (res.status !== 200) return [];

      const data = JSON.parse(res.body);
      if (!Array.isArray(data) || data.length === 0) return [];

      return (data[0].trends ?? [])
        .slice(0, 10)
        .map((t: any) => t.name as string);
    } catch {
      return [];
    }
  }

  /**
   * Look up the authenticated user's ID.
   * Needed for timeline requests.
   */
  async getMe(): Promise<{ id: string; name: string; username: string } | null> {
    try {
      const res = await xRequest(
        "GET",
        "https://api.x.com/2/users/me",
        this.creds,
      );

      if (res.status !== 200) return null;

      const data = JSON.parse(res.body);
      return data.data ?? null;
    } catch {
      return null;
    }
  }

  // ── Response parsing ──────────────────────────────────────────────

  private parseSearchResponse(body: string): SearchResult {
    try {
      const data = JSON.parse(body);
      const tweets: Tweet[] = [];

      // Build author lookup
      const authors = new Map<string, { name: string; username: string }>();
      if (data.includes?.users) {
        for (const u of data.includes.users) {
          authors.set(u.id, { name: u.name, username: u.username });
        }
      }

      for (const t of data.data ?? []) {
        const author = authors.get(t.author_id);
        tweets.push({
          id: t.id,
          text: t.text,
          authorId: t.author_id,
          authorName: author?.name,
          authorUsername: author?.username,
          createdAt: t.created_at,
          likeCount: t.public_metrics?.like_count,
          retweetCount: t.public_metrics?.retweet_count,
          replyCount: t.public_metrics?.reply_count,
        });
      }

      return {
        tweets,
        nextToken: data.meta?.next_token,
      };
    } catch {
      return { tweets: [] };
    }
  }
}
