# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Email-Worker is a unified email + RSS subscription management system deployed on Cloudflare Workers. It combines email routing with RSS feed aggregation in a single interface featuring Koobai-inspired design.

**Tech Stack:**
- **Runtime**: Cloudflare Workers (edge computing)
- **Database**: Cloudflare D1 (SQLite)
- **Email Parsing**: postal-mime v2.7.3
- **Frontend**: Vanilla JavaScript with inline CSS
- **Build Tool**: Wrangler 4.61.1
- **Design System**: Koobai-inspired (see `.codebuddy/rules/koobai-design-system.mdc`)

## Development Commands

```bash
# Install dependencies
npm install

# Local development (starts local dev server with D1 database)
npm run dev
# or
npm start

# Deploy to Cloudflare Workers
npm run deploy

# Deploy using PowerShell script (includes environment checks)
npm run pub
```

## Architecture

### Entry Point
- **src/index.js** (117KB) - Main worker file containing:
  - Email handler: `async email(message, env, ctx)` - Receives and parses incoming emails via Cloudflare Email Routing
  - HTTP handler: `async fetch(request, env, ctx)` - Handles all web requests and API endpoints
  - Cron handler: `async scheduled(event, env, ctx)` - Executes RSS feed fetching every 5 minutes
  - Logging system with in-memory buffer + D1 persistence

### RSS Module (Modular Design)
- **src/rss-utils.js** - Core RSS parsing and scheduling logic:
  - `parseRssFeed()` - Parses RSS 2.0 and Atom feeds
  - `shouldRunCron()` - Cron expression evaluation per feed
  - `fetchAllDueFeeds()` - Fetches feeds based on individual cron schedules

- **src/rss-handlers.js** - API endpoint handlers:
  - Feed management (CRUD operations)
  - Manual fetch triggers
  - Article operations (mark read/delete)

- **src/rss-ui.js** - UI rendering functions:
  - Feed management interface
  - Article list/detail views
  - Koobai-styled components

### Database Schema

**Core Tables:**
- `emails` - Email storage with full MIME parsing (14 emails currently)
- `rss_feeds` - RSS subscription sources with individual cron expressions (2 feeds)
- `rss_articles` - Fetched RSS articles (13 articles)
- `email_logs` - Processing logs for debugging (661 entries)
- `forward_history` - Email forwarding records
- `tags`, `email_tags` - Tagging system (reserved)

**Key Schema Pattern:**
- RSS feeds use per-feed `cron_expression` column for flexible scheduling
- Soft delete pattern: `is_deleted` boolean instead of hard deletes
- Foreign key cascade: Articles deleted when parent feed is deleted

Migration files: `migrations/001_add_rss_tables.sql`

### Request Routing

The main `fetch()` handler uses URL path matching:

```javascript
// Email pages
GET  /                      → Unified inbox (emails + RSS merged by timestamp)
GET  /view/:id              → Email detail view
GET  /article/:id           → RSS article detail view

// RSS management
GET  /feeds                 → RSS subscription management page
GET  /api/feeds             → Get feeds with stats (JSON)
POST /api/feeds             → Add new feed
POST /api/feeds/:id/fetch   → Manual fetch trigger
PUT  /api/feeds/:id         → Update feed (enable/disable, cron)
DELETE /api/feeds/:id       → Delete feed

// Unified operations
GET  /api/unified           → Merged content API (supports ?type=email|rss|all)
POST /api/mark-read         → Mark items read (supports both emails and articles)
POST /api/delete            → Delete items (supports both types)

// System
GET  /logs                  → System processing logs
GET  /diagnostics           → System health check
GET  /api/stats             → Statistics dashboard
```

### Key Features

1. **Unified Timeline**: Emails and RSS articles merged by timestamp with type detection
2. **Smart Filtering**:
   - Type: `?type=email|rss|all`
   - Category: `?filter=inbox|important|unread`
   - Search: `?search=keywords` (searches title + content)
3. **Per-Feed Scheduling**: Each RSS feed has individual cron expression (e.g., `0 * * * *`, `*/30 * * * *`)
4. **Error Handling**: Automatic feed disabling after consecutive failures

### Koobai Design System

**IMPORTANT**: This project follows Koobai design guidelines (see `.codebuddy/rules/koobai-design-system.mdc`). When modifying UI:

- Background: `#f2f0eb` (warm beige)
- Card background: `#fffdfe` (near white)
- Accent color: `#994d61` (rose)
- Icons: Lucide Icons (https://lucide.dev/) - already embedded in index.js
- Typography: JetBrains Mono for code, system fonts for text
- Layout: **Bottom fixed navigation bar with glassmorphism** (signature Koobai element)

```css
/* Bottom nav (NOT top nav) */
position: fixed;
bottom: 30px;
backdrop-filter: blur(20px) saturate(1.8);
border-radius: 50px;
```

## Configuration

### wrangler.jsonc
- Bindings: D1 database as `env.DB`
- Triggers:
  - Cron: `*/5 * * * *` (every 5 minutes for RSS fetching)
  - Email: `*@zjyyy.top` catch-all
- Routes: Custom domain `email.zjyyy.top`

### Environment Variables (not in code)
Set via Wrangler or Cloudflare dashboard:
- `CLOUDFLARE_EMAIL`
- `CLOUDFLARE_API_KEY`

## Important Patterns

### Email Processing Flow
1. Email arrives → `email()` handler triggered
2. Stream → ArrayBuffer → postal-mime parsing
3. Extract: subject, sender, HTML/text body, attachments
4. Insert into `emails` table
5. Log to `email_logs` with timing metrics

### RSS Fetching Flow
1. Cron triggers every 5 minutes → `scheduled()` handler
2. Query feeds where `shouldRunCron(cron_expression, last_fetch_at)` returns true
3. Fetch each feed's XML → parse with `parseRssFeed()`
4. Insert new articles (dedupe by `guid`)
5. Update `last_fetch_at`, handle errors, auto-disable on repeated failures

### Logging System
- Dual-layer: In-memory buffer (200 entries) + D1 persistence
- `addLog(env, type, action, details)` writes to both
- Used for debugging email processing issues

## Common Development Tasks

### Adding a New API Endpoint
1. Add route handler in `src/index.js` `fetch()` method
2. Follow existing pattern: check method, parse request, query DB, return JSON
3. Add corresponding UI in `src/rss-ui.js` if needed

### Modifying RSS Parser
1. Edit `src/rss-utils.js` → `parseRssFeed()`
2. Test with existing feeds via manual fetch: `POST /api/feeds/:id/fetch`
3. Check logs at `/logs` for parsing errors

### Database Schema Changes
1. Create new migration: `migrations/00X_description.sql`
2. Test locally: `wrangler d1 execute email_db --local --file=migrations/00X_description.sql`
3. Apply to production: `wrangler d1 execute email_db --file=migrations/00X_description.sql`
4. Update queries in `src/index.js` and `src/rss-handlers.js`

### Testing Email Reception
1. Start dev server: `npm run dev`
2. Send test email to configured address
3. Check console logs for parsing output
4. Visit `http://localhost:8787/logs` for detailed logs

## Deployment

The project uses a PowerShell deployment script (`deploy.ps1`) that:
1. Runs `wrangler deploy`
2. Captures version ID
3. Performs health checks
4. Displays deployment summary

Production URL: https://email.zjyyy.top

## Notes

- **No build step**: Code is deployed as-is (vanilla JS, no transpilation)
- **Single-file architecture**: Most code in `src/index.js` for Worker deployment efficiency
- **Inline CSS**: All styles embedded in HTML strings for zero external dependencies
- **State**: Workers are stateless; all state in D1 database
- **Rate limits**: Respect Cloudflare Workers free tier limits (100k requests/day, 10ms CPU time)
