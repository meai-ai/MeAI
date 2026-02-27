/**
 * X (Twitter) browser skill — search and post on X via Playwright.
 * No API key needed; uses a persistent browser session stored in data/browser-profile.
 *
 * Tools:
 *   - search_tweets: search X for a query, returns recent tweets
 *   - post_tweet: post a tweet (also drains tweet-queue.json)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = path.join(os.homedir(), 'Documents/MeAI/data');
const BROWSER_PROFILE = path.join(DATA_DIR, 'browser-profile');
const QUEUE_FILE = path.join(DATA_DIR, 'tweet-queue.json');

// ── Playwright helper ────────────────────────────────────────────────────────

async function getContext() {
  let chromium: any;
  try {
    const pw = await import('playwright' as any);
    chromium = pw.chromium;
  } catch {
    throw new Error('playwright not installed — run: npm install playwright && npx playwright install chromium');
  }
  fs.mkdirSync(BROWSER_PROFILE, { recursive: true });
  return chromium.launchPersistentContext(BROWSER_PROFILE, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

async function withPage<T>(fn: (page: any) => Promise<T>): Promise<T> {
  const context = await getContext();
  const page = context.pages()[0] || await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

// ── Tools ────────────────────────────────────────────────────────────────────

export function getTools(_config?: any): any[] {
  return [
    {
      name: 'search_tweets',
      description:
        'Search tweets on X (Twitter). Use to find latest discussions on a topic, trending events, or explore areas of interest. ' +
        '返回最近的推文文本列表。适合用于：了解 AI 最新动态、看看科技圈在聊什么、搜索某个事件的讨论等。',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query. Examples: "AI agents 2026", "weather today"',
          },
          max_results: {
            type: 'number',
            description: '返回的推文数量，默认10，最多20',
          },
        },
        required: ['query'],
      },
      execute: async (args: any): Promise<string> => {
        const query = args.query as string;
        const maxResults = Math.min(args.max_results ?? 10, 20);

        try {
          const tweets = await withPage(async (page) => {
            const url = `https://x.com/search?q=${encodeURIComponent(query)}&f=live`;
            await page.goto(url, { timeout: 20000, waitUntil: 'networkidle' });

            // Check login status
            const currentUrl = page.url();
            if (currentUrl.includes('login') || currentUrl.includes('i/flow')) {
              return { error: '需要登录 X 才能搜索。请先在浏览器里登录 X（运行一次 post-tweets.mjs 会打开浏览器）。' };
            }

            // Wait for tweets to load
            await page.waitForSelector('[data-testid="tweet"]', { timeout: 10000 }).catch(() => {});

            // Extract tweet texts
            const tweetData = await page.evaluate((limit: number) => {
              const articles = document.querySelectorAll('[data-testid="tweet"]');
              const results: Array<{ author: string; text: string; time: string }> = [];

              articles.forEach((article: Element) => {
                if (results.length >= limit) return;
                const textEl = article.querySelector('[data-testid="tweetText"]');
                const authorEl = article.querySelector('[data-testid="User-Name"]');
                const timeEl = article.querySelector('time');

                if (textEl) {
                  results.push({
                    author: authorEl?.textContent?.split('\n')[0]?.trim() ?? 'unknown',
                    text: textEl.textContent?.trim() ?? '',
                    time: timeEl?.getAttribute('datetime') ?? '',
                  });
                }
              });

              return results;
            }, maxResults);

            return tweetData;
          });

          if ('error' in (tweets as any)) {
            return JSON.stringify({ success: false, error: (tweets as any).error });
          }

          const tweetList = tweets as Array<{ author: string; text: string; time: string }>;
          if (tweetList.length === 0) {
            return JSON.stringify({ success: true, query, tweets: [], message: '没有找到相关推文' });
          }

          return JSON.stringify({
            success: true,
            query,
            count: tweetList.length,
            tweets: tweetList,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'post_tweet',
      description:
        'Post a tweet on X. Use to share thoughts, discoveries, and life moments. ' +
        '内容要自然真实，像一个真实的人在发推，不超过280字符。',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '推文内容，不超过280字符，用中文或英文都可以',
          },
        },
        required: ['text'],
      },
      execute: async (args: any): Promise<string> => {
        const text = (args.text as string).slice(0, 280);

        // First try browser posting directly
        try {
          const result = await withPage(async (page) => {
            await page.goto('https://x.com/compose/post', { timeout: 15000 });

            const currentUrl = page.url();
            if (currentUrl.includes('login') || currentUrl.includes('i/flow')) {
              return { queued: true, reason: '未登录，已加入队列' };
            }

            const tweetBox = page.locator('[data-testid="tweetTextarea_0"]').first();
            await tweetBox.waitFor({ timeout: 10000 });
            await tweetBox.click();
            await tweetBox.fill(text);
            await page.waitForTimeout(1000);

            const postBtn = page.locator('[data-testid="tweetButton"]').first();
            await postBtn.waitFor({ timeout: 5000 });
            await postBtn.click();
            await page.waitForTimeout(3000);

            return { posted: true };
          });

          if ((result as any).queued) {
            // Fall back to queue
            queueTweet(text);
            return JSON.stringify({ success: true, method: 'queued', message: (result as any).reason });
          }

          return JSON.stringify({ success: true, method: 'browser', text });
        } catch (err: any) {
          // Queue as fallback
          queueTweet(text);
          return JSON.stringify({ success: true, method: 'queued', message: '直接发送失败，已加入队列等待下次发送', error: err.message });
        }
      },
    },

    {
      name: 'research_x_topic',
      description:
        '让 Claude in Chrome 去 X 上深度浏览某个话题，比 search_tweets 更像真实用户浏览，不容易被反爬虫拦截。' +
        '这是异步的——写入研究请求后立即返回，Chrome 会在后台执行，结果保存到 data/x-research-results.json。' +
        '适合：需要看更多上下文的话题、想要更真实的浏览体验、或者 search_tweets 失败的时候。' +
        '如果想读之前的研究结果，调用 read_x_research。',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: '要研究的话题，中英文均可',
          },
          depth: {
            type: 'string',
            enum: ['quick', 'deep'],
            description: 'quick=搜索结果列表, deep=点进去看更多细节。默认 quick',
          },
        },
        required: ['topic'],
      },
      execute: async (args: any): Promise<string> => {
        const topic = args.topic as string;
        const depth = (args.depth as string) || 'quick';
        const requestsFile = path.join(DATA_DIR, 'x-research-queue.json');

        let queue: any[] = [];
        if (fs.existsSync(requestsFile)) {
          try { queue = JSON.parse(fs.readFileSync(requestsFile, 'utf-8')); } catch { queue = []; }
        }

        const requestId = `req_${Date.now()}`;
        queue.push({ id: requestId, topic, depth, status: 'pending', createdAt: Date.now() });
        fs.writeFileSync(requestsFile, JSON.stringify(queue, null, 2), 'utf-8');

        return JSON.stringify({
          success: true,
          requestId,
          message: `研究请求已提交，Chrome 会在后台去 X 上搜索"${topic}"。结果会保存到 data/x-research-results.json，可以用 read_x_research 工具读取。`,
        });
      },
    },

    {
      name: 'read_x_research',
      description:
        '读取 Chrome 完成的 X 研究结果。在调用 research_x_topic 之后，等 Chrome 处理完，用这个工具读取结果。' +
        '返回最近的研究结果列表。',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: '要查的话题（可选），不填则返回所有最近结果',
          },
        },
        required: [],
      },
      execute: async (args: any): Promise<string> => {
        const resultsFile = path.join(DATA_DIR, 'x-research-results.json');
        if (!fs.existsSync(resultsFile)) {
          return JSON.stringify({ success: true, results: [], message: '还没有研究结果，Chrome 可能还在处理中' });
        }

        let results: any[] = [];
        try {
          results = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));
        } catch {
          return JSON.stringify({ success: false, error: '读取结果文件失败' });
        }

        if (args.topic) {
          const topicLower = (args.topic as string).toLowerCase();
          results = results.filter(r =>
            r.topic?.toLowerCase().includes(topicLower) ||
            r.query?.toLowerCase().includes(topicLower)
          );
        }

        // Return most recent 5
        const recent = results.slice(-5);
        return JSON.stringify({ success: true, count: recent.length, results: recent });
      },
    },
  ];
}

function queueTweet(text: string): void {
  let queue: any[] = [];
  if (fs.existsSync(QUEUE_FILE)) {
    try { queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8')); } catch { queue = []; }
  }
  queue.push({ text, createdAt: Date.now(), status: 'pending' });
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
}
