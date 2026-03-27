# A/B Test: HTML Scraping vs RSS — Design Spec

## Goal
Add a third column to the dashboard that shows GamesRadar articles fetched via direct HTML scraping, displayed side-by-side with RSS and Twitter columns for latency comparison. Each article shows both "published at" and "fetched at" timestamps.

## UI Layout

### Current: `sidebar (300px) | feed (1fr)`
### New: `sidebar (collapsible) | Wario Twitter (1fr) | GamesRadar RSS (1fr) | GamesRadar HTML (1fr)`

- Sidebar becomes collapsible (toggle button in header)
- When collapsed: just a thin strip with a toggle button
- 3 equal columns for the feeds
- Each column has a header label explaining the source/method
- Column headers:
  1. "🐦 @Wario64 — Twitter via Nitter"
  2. "📰 GamesRadar — RSS Feed"
  3. "⚡ GamesRadar — HTML Polling (A/B Test)"
- A/B test column gets a subtle accent border/badge to distinguish it

### Article cards (all 3 columns)
Each article card shows:
- Title (linked)
- **Published:** `{published_at}` — when the publisher says it was posted
- **Fetched:** `{created_at}` — when our system first detected it
- Source badge (colored)

## Backend Changes

### New DB table: `scrape_articles`
```sql
CREATE TABLE IF NOT EXISTS scrape_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  link TEXT UNIQUE,
  published_at DATETIME,
  created_at DATETIME DEFAULT (datetime('now')),
  guid TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scrape_link ON scrape_articles(link);
```

Separate table so RSS and scrape data are completely independent — clean A/B comparison.

### New function: `scrapeGamesRadar()`
```
1. fetch('https://www.gamesradar.com/games/')
2. cheerio.load(html)
3. Extract articles via selectors:
   - Links: a.wdn-listv2-item-link[href]
   - Titles: .wdn-listv2-item-content-title
   - Published: time.relative-date[datetime]
4. For each article: INSERT OR IGNORE into scrape_articles
5. Return new articles (those with changes > 0)
```

### New API endpoint: `GET /api/scrape-articles?limit=50`
Returns `{ articles: [...], total: N }` from `scrape_articles` table.

### New WebSocket event: `new_scrape_articles`
When scrapeGamesRadar() finds new articles, broadcast them separately so the frontend can route them to the correct column.

### New poll loop
`scrapeGamesRadar()` runs on the same 15s interval alongside the existing RSS/Twitter polling but independently.

### Existing articles table
Add `created_at` tracking — already exists in the schema (DEFAULT datetime('now')). The `published_at` field already stores the publisher's timestamp. No schema change needed for existing articles.

## Frontend Changes

### HTML structure
```html
<header>
  <h1>...</h1>
  <button id="toggleSidebar">☰</button>  <!-- new -->
  <button id="muteBtn">🔔</button>
</header>
<div class="layout">
  <aside class="sidebar" id="sidebar">...</aside>
  <section class="feed" id="col-twitter">
    <div class="col-header">🐦 @Wario64 — Twitter via Nitter</div>
    <div id="arts-twitter"></div>
  </section>
  <section class="feed" id="col-rss">
    <div class="col-header">📰 GamesRadar — RSS Feed</div>
    <div id="arts-rss"></div>
  </section>
  <section class="feed" id="col-scrape">
    <div class="col-header">⚡ GamesRadar — HTML Polling (A/B Test)</div>
    <div id="arts-scrape"></div>
  </section>
</div>
```

### CSS changes
- `.layout` grid: `300px 1fr 1fr 1fr` (sidebar open) or `0px 1fr 1fr 1fr` (collapsed)
- `.sidebar.collapsed` = `display: none` or `width: 0; overflow: hidden`
- `.col-header` styling: uppercase label, muted, with colored left border
- A/B test column: dashed border or subtle background to distinguish
- Responsive: stack vertically on mobile

### JS changes
- `loadArts()` → split into `loadArtsTwitter()`, `loadArtsRSS()`, `loadArtsScrape()`
  - Twitter: `GET /api/articles?limit=100` filtered by source_id for Wario
  - RSS: `GET /api/articles?limit=100` filtered by source_id for GamesRadar
  - Scrape: `GET /api/scrape-articles?limit=100`
- `artHTML()` updated to show both timestamps:
  - "Published: 5:23 PM" (from published_at)
  - "Fetched: 5:25 PM" (from created_at)
- WebSocket handler: route `new_articles` to correct column based on feed_type, route `new_scrape_articles` to scrape column
- Sidebar toggle: `document.getElementById('toggleSidebar').onclick` toggles `.collapsed` class

### API change needed
`GET /api/articles` needs a `source_id` query param to filter by source:
```
GET /api/articles?source_id=2&limit=100  → Wario only
GET /api/articles?source_id=1&limit=100  → GamesRadar RSS only
```

## Files Changed
- `server.js` — new table, scraper function, API endpoint, WebSocket event, poll loop addition
- `public/index.html` — complete layout overhaul (3 columns, collapsible sidebar, dual timestamps)

## What Does NOT Change
- Existing RSS polling logic
- Twitter caching/racing logic
- Database schema for existing tables
- Source management (add/delete, still hidden)
