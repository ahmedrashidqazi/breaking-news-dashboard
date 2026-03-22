# Breaking News Dashboard — Project Context

## What This Is

Real-time news monitoring dashboard that aggregates RSS/Atom feeds. Backend polls feeds every 60s, deduplicates articles in SQLite, and pushes new ones to all connected clients via WebSocket. Browser notifications alert on new articles.

## Stack

- **Backend**: Node.js, Express, ws, rss-parser, better-sqlite3
- **Frontend**: Vanilla HTML/CSS/JS served by Express (no build step)
- **Database**: SQLite (`news.db`, auto-created, gitignored)
- **Process manager**: pm2 (`news-dashboard`)

## Directory Structure

```
breaking-news-dashboard/
├── .claude/CLAUDE.md       # This file
├── server.js               # Express + WebSocket + RSS polling
├── public/
│   ├── index.html          # Single page app
│   ├── style.css           # Dark theme, responsive
│   └── app.js              # WebSocket client, DOM rendering, notifications
├── package.json
├── .gitignore
└── README.md
```

## Deployment

- **VPS**: Hetzner (89.167.101.239), runs as `deploy` user
- **Port**: 3001 (3000 is taken by Tailscale)
- **pm2**: `pm2 start server.js --name news-dashboard` with `PORT=3001`
- **Firewall**: ufw — port 3001 is currently CLOSED (private). Run `sudo ufw allow 3001` to expose publicly.
- **Reboot persistence**: pm2 systemd service configured (`pm2-deploy.service`)
- **Tailscale access**: Always available at http://100.81.125.53:3001

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/sources | List all feed sources with article counts |
| POST | /api/sources | Add feed `{ "url": "..." }` — validates, does initial poll |
| DELETE | /api/sources/:id | Remove feed and its articles (CASCADE) |
| GET | /api/articles?limit=50&offset=0 | Paginated articles, newest first |

WebSocket: auto-connects at `ws://host`, receives `{ type: "new_articles", articles: [...] }`

## DB Schema

- **sources**: id, url, title, created_at, last_polled_at
- **articles**: id, source_id, title, link, published_at, guid, created_at (unique on guid, unique on link)

## Key Behaviors

- Feed validation: POST /api/sources fetches and parses the feed before saving. Rejects non-RSS/Atom URLs.
- Initial poll: When a feed is added, existing articles are saved silently (no WebSocket broadcast). Only subsequent polls trigger notifications.
- Deduplication: Articles are deduped by guid and link (INSERT OR IGNORE).
- Polling: Every 60 seconds, all sources are polled sequentially.

## Common Commands

```bash
# Start/restart
pm2 restart news-dashboard

# Logs
pm2 logs news-dashboard

# Expose publicly
sudo ufw allow 3001

# Make private again
sudo ufw delete allow 3001

# Status
pm2 status
```

## Git

- **Repo**: https://github.com/ahmedrashidqazi/breaking-news-dashboard (public)
- Follow standard git workflow from global CLAUDE.md
