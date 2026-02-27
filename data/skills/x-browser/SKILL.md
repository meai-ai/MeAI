# X Browser Skill

Search, research, and post on X (Twitter) without needing API keys.

## Tool selection guide

### Real-time → use `search_tweets`
- User asks about a topic and you want to show them X discussions
- Quick fact-checking
- Playwright headless search, returns results in seconds

### Deep research → use `research_x_topic`
- You want to deeply explore a topic (AI news, tech updates, etc.)
- Fallback when `search_tweets` gets rate-limited
- Runs in a real Chrome browser, more like a real user, richer results
- Async: submits immediately, read results later with `read_x_research`

### Read existing research → use `read_x_research`
- View completed Chrome research results
- Curiosity engine can call periodically for latest X updates

### Post → use `post_tweet`
- You have thoughts to share
- Post directly or queue for later

## Typical workflows

**Real-time chat**: `search_tweets("AI agents 2026")` → share findings with user

**Background research**: `research_x_topic("topic")` → wait for Chrome → `read_x_research("topic")` → weave into future conversations

**Posting**: `post_tweet("saw a rainbow on my run today 🌈...")` → post directly or queue
