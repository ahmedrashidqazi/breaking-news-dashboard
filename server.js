const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const Database = require("better-sqlite3");
const RSSParser = require("rss-parser");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const parser = new RSSParser();

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL = 60_000;

// ── Database ────────────────────────────────────────────────────────────────

const db = new Database(path.join(__dirname, "news.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_polled_at TEXT
  );

  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    published_at TEXT,
    guid TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(guid),
    UNIQUE(link)
  );

  CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_id);
`);

// Prepared statements
const stmts = {
  getSources: db.prepare("SELECT * FROM sources ORDER BY created_at DESC"),
  getSource: db.prepare("SELECT * FROM sources WHERE id = ?"),
  addSource: db.prepare("INSERT INTO sources (url, title) VALUES (?, ?)"),
  deleteSource: db.prepare("DELETE FROM sources WHERE id = ?"),
  updatePolled: db.prepare("UPDATE sources SET last_polled_at = datetime('now'), title = ? WHERE id = ?"),
  getArticles: db.prepare(
    "SELECT a.*, s.title as source_title FROM articles a JOIN sources s ON a.source_id = s.id ORDER BY a.published_at DESC LIMIT ? OFFSET ?"
  ),
  insertArticle: db.prepare(
    `INSERT OR IGNORE INTO articles (source_id, title, link, published_at, guid)
     VALUES (?, ?, ?, ?, ?)`
  ),
  sourceArticleCount: db.prepare("SELECT COUNT(*) as count FROM articles WHERE source_id = ?"),
};

// ── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── REST API ────────────────────────────────────────────────────────────────

app.get("/api/sources", (_req, res) => {
  const sources = stmts.getSources.all().map((s) => ({
    ...s,
    article_count: stmts.sourceArticleCount.get(s.id).count,
  }));
  res.json(sources);
});

app.post("/api/sources", async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }

  const trimmed = url.trim();

  // Check duplicate
  const existing = db.prepare("SELECT id FROM sources WHERE url = ?").get(trimmed);
  if (existing) {
    return res.status(409).json({ error: "Feed already added" });
  }

  // Validate by fetching the feed
  let feed;
  try {
    feed = await parser.parseURL(trimmed);
  } catch (err) {
    return res.status(422).json({ error: `Invalid feed: ${err.message}` });
  }

  const title = feed.title || trimmed;
  const info = stmts.addSource.run(trimmed, title);
  const sourceId = info.lastInsertRowid;

  // Initial poll — insert existing articles silently (no notifications)
  for (const item of feed.items || []) {
    const articleTitle = item.title || "Untitled";
    const link = item.link || "";
    const published = item.isoDate || item.pubDate || new Date().toISOString();
    const guid = item.guid || item.id || link;

    stmts.insertArticle.run(sourceId, articleTitle, link, published, guid);
  }

  stmts.updatePolled.run(title, sourceId);

  const source = stmts.getSource.get(sourceId);
  source.article_count = stmts.sourceArticleCount.get(sourceId).count;
  res.status(201).json(source);
});

app.delete("/api/sources/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const source = stmts.getSource.get(id);
  if (!source) {
    return res.status(404).json({ error: "Source not found" });
  }
  stmts.deleteSource.run(id);
  res.json({ ok: true });
});

app.get("/api/articles", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;
  const articles = stmts.getArticles.all(limit, offset);
  res.json(articles);
});

// ── WebSocket ───────────────────────────────────────────────────────────────

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "connected" }));
});

// ── Feed Polling ────────────────────────────────────────────────────────────

async function pollSource(source) {
  let feed;
  try {
    feed = await parser.parseURL(source.url);
  } catch (err) {
    console.error(`[poll] Failed to fetch ${source.url}: ${err.message}`);
    return;
  }

  const title = feed.title || source.title;
  const newArticles = [];

  for (const item of feed.items || []) {
    const articleTitle = item.title || "Untitled";
    const link = item.link || "";
    const published = item.isoDate || item.pubDate || new Date().toISOString();
    const guid = item.guid || item.id || link;

    const result = stmts.insertArticle.run(
      source.id, articleTitle, link, published, guid
    );

    if (result.changes > 0) {
      newArticles.push({
        id: result.lastInsertRowid,
        source_id: source.id,
        source_title: title,
        title: articleTitle,
        link,
        published_at: published,
        guid,
      });
    }
  }

  stmts.updatePolled.run(title, source.id);

  if (newArticles.length > 0) {
    console.log(`[poll] ${title}: ${newArticles.length} new article(s)`);
    broadcast({ type: "new_articles", articles: newArticles });
  }
}

async function pollAll() {
  const sources = stmts.getSources.all();
  for (const source of sources) {
    await pollSource(source);
  }
}

// ── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  // Start polling loop
  pollAll();
  setInterval(pollAll, POLL_INTERVAL);
});
