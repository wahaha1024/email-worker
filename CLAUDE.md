# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Email-Worker is a unified email + RSS subscription management system deployed on Cloudflare Workers. It combines email routing with RSS feed aggregation in a single interface featuring Koobai-inspired design with lavender theme.

**Tech Stack:**
- **Runtime**: Cloudflare Workers (edge computing)
- **Database**: Cloudflare D1 (SQLite)
- **Email Parsing**: postal-mime v2.7.3
- **Frontend**: Vanilla JavaScript with inline CSS
- **Build Tool**: Wrangler 4.61.1
- **Icons**: Lucide Icons (CDN)
- **Design System**: Koobai-inspired with lavender accent (#b4a7d6)

**Current Version**: `74cb6735-5a28-4c68-b622-ceb932528a03`
**Production URL**: https://email.zjyyy.top
**Dev URL**: https://email.912741793.workers.dev

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
# or
wrangler deploy

# Deploy using PowerShell script (includes environment checks)
npm run pub

# Database operations
wrangler d1 execute email_db --local --file=migrations/001_add_rss_tables.sql  # Local
wrangler d1 execute email_db --file=migrations/001_add_rss_tables.sql          # Production
```

## Architecture

### Entry Point
- **src/index.js** (~220KB) - Main worker file containing:
  - Email handler: `async email(message, env, ctx)` - Receives and parses incoming emails via Cloudflare Email Routing
  - HTTP handler: `async fetch(request, env, ctx)` - Handles all web requests and API endpoints
  - Cron handler: `async scheduled(event, env, ctx)` - Executes RSS feed fetching every 5 minutes
  - Logging system with in-memory buffer + D1 persistence
  - All UI rendering functions (Koobai-styled)

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
- `emails` - Email storage with full MIME parsing
- `rss_feeds` - RSS subscription sources with individual cron expressions
- `rss_articles` - Fetched RSS articles
- `email_logs` - Processing logs for debugging
- `forward_history` - Email forwarding records
- `tags`, `email_tags` - Tagging system (reserved)

**Key Schema Pattern:**
- RSS feeds use per-feed `cron_expression` column for flexible scheduling
- Soft delete pattern: `is_deleted` boolean instead of hard deletes
- Foreign key cascade: Articles deleted when parent feed is deleted

**Migration Files:**
- `migrations/001_add_rss_tables.sql` - Creates RSS tables with indexes

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

// RSS articles
GET  /api/articles          → Get articles (with ?feed_id filter)
POST /api/articles/mark-read → Mark articles as read
POST /api/articles/delete   → Delete articles (soft delete)

// Unified operations
GET  /api/unified           → Merged content API (supports ?type=email|rss|all)
POST /api/mark-read         → Mark emails as read
POST /api/delete            → Delete emails (soft delete)

// Email operations
POST /api/forward           → Forward email to address

// System
GET  /logs                  → System processing logs
GET  /diagnostics           → System health check
GET  /api/stats             → Statistics dashboard
```

## Key Features & Code Structure

### 1. Unified Timeline

**Location**: `src/index.js` - `renderUnifiedList(items, filters)`

Merges emails and RSS articles by timestamp:
```javascript
// Emails: { id, title (from subject), source (from sender), date, type: 'email', url: '/view/:id' }
// RSS: { id, title, source (from feed_name), date, type: 'rss', url: '/article/:id' }
```

**Filtering**:
- Type: `?type=email|rss|all`
- Category: `?filter=inbox|important|unread`
- Search: `?search=keywords` (searches title + content)

### 2. UI Components (Koobai Design)

**Main Page Renderer**: `renderKoobaiPage({ page, emailId, content })`
- Renders complete HTML page with navigation
- Includes Lucide Icons CDN script
- Contains all JavaScript logic (NO duplicate scripts in child components)

**Key UI Elements**:

1. **Left Sidebar - Type Filter** (位置: 左侧居中)
   ```javascript
   // In renderUnifiedList()
   .type-filter-bar {
     position: fixed;
     left: 24px;
     top: 50%;
     transform: translateY(-50%);
     // Lavender frosted glass effect
     background: rgba(242, 240, 235, 0.5);
     backdrop-filter: blur(20px) saturate(1.8);
   }
   ```
   - Buttons: 全部 (layers), 邮件 (mail), RSS (rss)
   - Mobile: Horizontal at top

2. **Right Bottom FAB** (位置: 右下角)
   ```javascript
   // In renderUnifiedList()
   .fab-container {
     position: fixed;
     right: 24px;
     bottom: 120px;
   }
   .fab-main {
     width: 56px;
     height: 56px;
     border-radius: 50%;
     background: var(--accent); // #b4a7d6
   }
   ```
   - Hover to show menu: Filter, Search, Edit
   - Material Design Floating Action Button style

3. **Bottom Navigation** (位置: 底部居中)
   ```javascript
   .bottom-nav {
     position: fixed;
     bottom: 30px;
     left: 50%;
     transform: translateX(-50%);
     width: auto;
     min-width: 120px;
     max-width: 600px;
   }
   ```
   - Auto-width based on button count
   - Icons: Inbox, Logs, RSS Feeds
   - Lavender theme with glassmorphism

### 3. Icon System (Lucide)

**CRITICAL**: Avoid duplicate script blocks!

**Initialization** (in `renderKoobaiPage` only):
```javascript
<script>
  // Multi-retry initialization mechanism
  function initLucideIcons() { ... }
  function tryInitIcons() { ... }

  // DOM ready check
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInitIcons);
  } else {
    tryInitIcons();
  }

  // Window load backup
  window.addEventListener('load', function() {
    setTimeout(initLucideIcons, 100);
  });
</script>
```

**Icon Usage**:
```html
<span data-lucide="icon-name"></span>
<!-- Will be replaced with SVG by lucide.createIcons() -->
```

**Common Icons**:
- Navigation: `mail`, `activity`, `rss`
- Actions: `filter`, `search`, `edit-3`, `menu`
- Types: `layers`, `mail`, `rss`
- Controls: `square`, `check-square`, `check`, `trash-2`

### 4. JavaScript State Management

**Global Variables** (declared once in `renderKoobaiPage`):
```javascript
let selectMode = false;
let selectedIds = new Set();
let currentForwardId = null;
let filterMenuOpen = false;
let searchBoxOpen = false;
let editMenuOpen = false;
```

**Key Functions**:
- `toggleFilterMenu()` - Show/hide filter menu
- `toggleSearchBox()` - Show/hide search input
- `toggleEditMenu()` - Show/hide edit menu
- `closeFabMenu()` - Close FAB menu
- `toggleSelect()` - Enter/exit selection mode
- `updateSelection()` - Update selected items
- `markRead()` - Mark selected items as read
- `doDelete()` - Delete selected items

### 5. Per-Feed RSS Scheduling

**Cron Evaluation**: `src/rss-utils.js` - `shouldRunCron(cronExpression, lastFetchAt, now)`

Supports 5-field cron format:
```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, 0=Sunday)
│ │ │ │ │
* * * * *
```

Examples:
- `0 * * * *` - Every hour
- `*/30 * * * *` - Every 30 minutes
- `0 0 * * *` - Daily at midnight
- `0 9,18 * * *` - 9am and 6pm daily

**Scheduled Handler**: `async scheduled(event, env, ctx)`
```javascript
// Runs every 5 minutes (configured in wrangler.jsonc)
// Calls fetchAllDueFeeds() to check each feed's cron
```

## Koobai Design System

**Theme Colors** (Updated):
```css
:root {
  --bg: #f2f0eb;              /* Warm beige background */
  --bg-card: #fffdfa;         /* Cloud white cards */
  --text: #222222;            /* Primary text */
  --text-secondary: #666666;  /* Secondary text */
  --text-muted: #999999;      /* Muted text */
  --border: rgba(0,0,0,0.08); /* Subtle borders */
  --accent: #b4a7d6;          /* Lavender (主题色) */
  --accent-light: rgba(180, 167, 214, 0.1);
  --hover-bg: rgba(0,0,0,0.06);
  --active-bg: rgba(0,0,0,0.1);
  --radius: 16px;
  --radius-sm: 12px;
}
```

**Design Principles**:
1. Minimalist, clean aesthetic
2. Glassmorphism effects (`backdrop-filter: blur(20px) saturate(1.8)`)
3. Rounded corners (16px for cards, 50px for nav)
4. Subtle shadows with multiple layers
5. Smooth transitions (0.2-0.3s cubic-bezier)
6. Bottom-fixed navigation (NOT top nav)
7. Auto-width components based on content

**Typography**:
- Code: JetBrains Mono
- Text: System fonts (-apple-system, BlinkMacSystemFont, Segoe UI, etc.)

**Layout**:
```css
body {
  max-width: 720px; /* Optimized reading width */
  margin: 0 auto;
  padding-bottom: 120px; /* Space for bottom nav */
}
```

## Cloudflare Configuration

### wrangler.jsonc

```jsonc
{
  "name": "email",
  "main": "src/index.js",
  "compatibility_date": "2024-01-01",
  "node_compat": true,

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "email_db",
      "database_id": "your-database-id",
      "migrations_dir": "migrations"
    }
  ],

  "triggers": {
    "crons": ["*/5 * * * *"]  // RSS fetch every 5 minutes
  },

  "routes": [
    {
      "pattern": "email.zjyyy.top",
      "custom_domain": true
    }
  ]
}
```

### Email Routing Setup

1. **Cloudflare Dashboard**:
   - Email Routing → Routing Rules
   - Catch-all: `*@zjyyy.top` → Send to Worker `email`

2. **Worker Configuration**:
   - Email handler: `async email(message, env, ctx)`
   - Automatically triggered on incoming emails

### Environment Variables

**Set via Cloudflare Dashboard or Wrangler**:
```bash
# For local development (.dev.vars file)
CLOUDFLARE_EMAIL=your@email.com
CLOUDFLARE_API_KEY=your_global_api_key

# For production (wrangler secret)
wrangler secret put CLOUDFLARE_EMAIL
wrangler secret put CLOUDFLARE_API_KEY
```

**Local Development**:
```bash
# ~/.bashrc (for CLI operations)
export CLOUDFLARE_EMAIL="912741793@qq.com"
export CLOUDFLARE_API_KEY="f09a7982f7762f3fbd41a024b8639596c126f"
```

### D1 Database Access

**Local**:
```bash
wrangler d1 execute email_db --local --command="SELECT * FROM emails LIMIT 5"
```

**Production**:
```bash
wrangler d1 execute email_db --command="SELECT COUNT(*) FROM rss_articles"
```

**Migrations**:
```bash
# Apply migration locally
wrangler d1 execute email_db --local --file=migrations/001_add_rss_tables.sql

# Apply to production
wrangler d1 execute email_db --file=migrations/001_add_rss_tables.sql
```

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

### Adding UI Components

**CRITICAL RULES**:
1. ✅ Add HTML/CSS in `renderUnifiedList()` or other render functions
2. ✅ Add JavaScript functions in `renderKoobaiPage()` script section ONLY
3. ❌ NEVER add `<script>` blocks in component render functions
4. ❌ NEVER duplicate variable declarations (`let selectMode`, etc.)

**Example - Adding a New Button**:
```javascript
// In renderUnifiedList() - HTML only
const myButton = `
  <button class="my-btn" onclick="myFunction()">
    <span data-lucide="icon-name"></span>
    <span>Label</span>
  </button>
`;

// In renderKoobaiPage() <script> section - JavaScript only
function myFunction() {
  // Your logic here
  if (typeof lucide !== 'undefined') {
    lucide.createIcons(); // Re-render icons if HTML changed
  }
}
```

### Testing Email Reception
1. Start dev server: `npm run dev`
2. Send test email to configured address
3. Check console logs for parsing output
4. Visit `http://localhost:8787/logs` for detailed logs

## Deployment

### Deploy Command
```bash
wrangler deploy
# or
npm run deploy
```

### Post-Deployment Checks
1. Check version ID in output
2. Verify production URL: https://email.zjyyy.top
3. Test key features:
   - Email reception
   - RSS feed fetching
   - Icon display (open browser console)
   - Navigation functionality

### Deployment Script (PowerShell)
`deploy.ps1`:
1. Runs `wrangler deploy`
2. Captures version ID
3. Performs health checks
4. Displays deployment summary

## Troubleshooting

### Icons Not Displaying

**Check**:
1. Browser console for errors
2. Look for `✓ Lucide icons initialized` log
3. Verify no duplicate `let selectMode` declarations
4. Check network tab for Lucide CDN load

**Common Causes**:
- Duplicate script blocks (check `renderUnifiedList()` has no `<script>`)
- CDN blocked (firewall/ad blocker)
- JavaScript syntax error (stops execution)

**Fix**:
- Remove duplicate scripts
- Wait for proper initialization (multi-retry mechanism)
- Check console for syntax errors

### RSS Not Fetching

**Check**:
1. Cron expression syntax
2. Last fetch time vs current time
3. Feed URL accessibility
4. Error count (auto-disables after failures)

**Debug**:
```bash
# Check scheduled logs
curl https://email.zjyyy.top/logs | grep "RSS"

# Manual trigger
curl -X POST https://email.zjyyy.top/api/feeds/1/fetch
```

### Database Issues

**Check connection**:
```bash
wrangler d1 execute email_db --command="SELECT 1"
```

**Reset local database**:
```bash
rm -rf .wrangler/state
wrangler d1 execute email_db --local --file=migrations/001_add_rss_tables.sql
```

## Performance Optimization

### Current Metrics
- File size: 220.12 KB (raw), 49.44 KB (gzip)
- Cold start: ~100-200ms
- Warm request: ~20-50ms

### Best Practices
1. Minimize external dependencies (use inline CSS/JS)
2. Use D1 prepared statements for queries
3. Implement soft deletes (faster than hard deletes)
4. Cache static content (email content rarely changes)
5. Use indexes on frequently queried columns

### Rate Limits (Cloudflare Free Tier)
- 100,000 requests/day
- 10ms CPU time per request
- 1MB script size limit
- 25 cron triggers/day (current: 288/day = every 5 min)

## Notes

- **No build step**: Code is deployed as-is (vanilla JS, no transpilation)
- **Single-file architecture**: Most code in `src/index.js` for Worker deployment efficiency
- **Inline CSS**: All styles embedded in HTML strings for zero external dependencies
- **State**: Workers are stateless; all state in D1 database
- **Icons**: Loaded from CDN, initialized with retry mechanism
- **Design**: Koobai-inspired with lavender theme (#b4a7d6)
- **NO duplicate scripts**: JavaScript only in `renderKoobaiPage()`, HTML/CSS in render functions
