# Breaking News Dashboard

Real-time news monitoring dashboard that aggregates RSS/Atom feeds with live WebSocket updates and browser notifications.

![Stack](https://img.shields.io/badge/stack-Node.js%20%2B%20Express%20%2B%20WebSocket-blue)

## Features

- **Add any RSS/Atom feed** — validates on add, polls every 60 seconds
- **Live updates** — new articles pushed via WebSocket, animate in at the top
- **Browser notifications** — get notified when new articles arrive
- **Dark theme** — clean, responsive UI that works on mobile
- **SQLite storage** — articles deduped by guid/link, persists across restarts
- **Connection indicator** — green/red dot with auto-reconnect and exponential backoff

## Quick Start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) and add some feeds:

```
https://feeds.bbci.co.uk/news/rss.xml
https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml
https://www.aljazeera.com/xml/rss/all.xml
https://feeds.arstechnica.com/arstechnica/index
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sources` | List all feed sources |
| `POST` | `/api/sources` | Add a feed (`{ "url": "..." }`) |
| `DELETE` | `/api/sources/:id` | Remove a feed and its articles |
| `GET` | `/api/articles?limit=50&offset=0` | Paginated articles (newest first) |

WebSocket connects at `ws://host` and receives `{ type: "new_articles", articles: [...] }` messages.

## Stack

- **Backend**: Node.js, Express, ws, rss-parser, better-sqlite3
- **Frontend**: Vanilla HTML/CSS/JS (no build step)
- **Database**: SQLite (auto-created as `news.db`)

## Production

```bash
# With pm2
pm2 start server.js --name news-dashboard
pm2 save

# With environment variable
PORT=8080 node server.js
```
