'use strict';
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const Database = require('better-sqlite3');
const RSSParser = require('rss-parser');
const cheerio = require('cheerio');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
const POLL_INTERVAL = 45000;

// Database setup
const db = new Database(path.join(__dirname, 'news.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT,
    feed_type TEXT NOT NULL DEFAULT 'rss',
    created_at DATETIME DEFAULT (datetime('now')),
    last_polled_at DATETIME,
    status TEXT DEFAULT 'active',
    error_message TEXT
  );
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    title TEXT,
    link TEXT,
    description TEXT,
    published_at DATETIME,
    guid TEXT,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_guid ON articles(guid) WHERE guid IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_articles_pub ON articles(published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_articles_src ON articles(source_id);
`);

const parser = new RSSParser({
  timeout: 12000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; NewsAggregator/1.0)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

// WebSocket broadcast
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// Try RSS feed directly
async function tryRSS(url) {
  try {
    const feed = await parser.parseURL(url);
    return { success: true, feed };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Find RSS link from HTML page
async function findRSSFromPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsAggregator/1.0)' },
      timeout: 12000
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    const links = [];
    $('link[type="application/rss+xml"], link[type="application/atom+xml"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        try { links.push(href.startsWith('http') ? href : new URL(href, url).href); } catch(e) {}
      }
    });
    return links;
  } catch (e) {
    return [];
  }
}

// Twitter/X feed with fallback chain
async function fetchTwitterFeed(twitterUrl) {
  const parts = twitterUrl.replace(/\/$/, '').split('/');
  const username = parts[parts.length - 1].replace(/^@/, '').split('?')[0];

  // Method 1: RSSBridge
  try {
    console.log(`[Twitter] Trying RSSBridge for @${username}`);
    const bridgeUrl = `https://rss-bridge.org/bridge01/?action=display&bridge=TwitterBridge&context=By+username&u=${username}&format=Atom`;
    const r = await tryRSS(bridgeUrl);
    if (r.success && r.feed.items && r.feed.items.length > 0) {
      console.log(`[Twitter] RSSBridge SUCCESS: ${r.feed.items.length} items`);
      return { success: true, feed: r.feed, method: 'rssbridge', title: `@${username}` };
    }
  } catch(e) { console.log(`[Twitter] RSSBridge error: ${e.message}`); }

  // Method 2: Nitter instances
  const nitters = [
    'https://nitter.privacydev.net',
    'https://nitter.poast.org',
    'https://nitter.net',
    'https://nitter.1d4.us',
    'https://nitter.cz',
  ];
  for (const base of nitters) {
    try {
      console.log(`[Twitter] Trying Nitter: ${base}/@${username}`);
      const r = await tryRSS(`${base}/${username}/rss`);
      if (r.success && r.feed.items && r.feed.items.length > 0) {
        console.log(`[Twitter] Nitter SUCCESS: ${base}, ${r.feed.items.length} items`);
        return { success: true, feed: r.feed, method: 'nitter', title: `@${username}` };
      }
    } catch(e) {}
  }

  // Method 3: Twitter syndication endpoint
  try {
    console.log(`[Twitter] Trying syndication endpoint for @${username}`);
    const res = await fetch(
      `https://syndication.twitter.com/srv/timeline-profile/screen-name/${username}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
          'Accept': 'text/html,application/xhtml+xml',
        },
        timeout: 15000
      }
    );
    if (res.ok) {
      const html = await res.text();
      const $ = cheerio.load(html);
      const items = [];
      $('[data-testid="tweet"]').each((i, el) => {
        const text = $(el).find('[data-testid="tweetText"]').text().trim();
        const linkEl = $(el).find('a[href*="/status/"]');
        const href = linkEl.attr('href');
        if (text && text.length > 3) {
          const link = href ? (href.startsWith('http') ? href : `https://x.com${href}`) : `https://x.com/${username}`;
          items.push({ title: text.substring(0, 280), link, guid: link, pubDate: new Date().toISOString(), content: text });
        }
      });
      if (items.length > 0) {
        console.log(`[Twitter] Syndication SUCCESS: ${items.length} items`);
        return { success: true, feed: { title: `@${username}`, items }, method: 'syndication', title: `@${username}` };
      }
    }
  } catch(e) { console.log(`[Twitter] Syndication error: ${e.message}`); }

  // Method 4: Direct x.com scrape
  try {
    console.log(`[Twitter] Trying direct x.com scrape for @${username}`);
    const res = await fetch(`https://x.com/${username}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000
    });
    const html = await res.text();
    const items = [];
    const matches = [...html.matchAll(/"full_text":"((?:[^"\\]|\\.)*)"/g)];
    matches.forEach((m, i) => {
      const text = m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (text.length > 10) {
        items.push({
          title: text.substring(0, 280),
          link: `https://x.com/${username}`,
          guid: `x-${username}-${i}-${Date.now()}`,
          pubDate: new Date().toISOString(),
          content: text
        });
      }
    });
    if (items.length > 0) {
      console.log(`[Twitter] Direct scrape SUCCESS: ${items.length} items`);
      return { success: true, feed: { title: `@${username}`, items: items.slice(0, 20) }, method: 'scrape', title: `@${username}` };
    }
  } catch(e) { console.log(`[Twitter] Direct scrape error: ${e.message}`); }

  console.log(`[Twitter] ALL methods failed for @${username}`);
  return { success: false, error: `All Twitter methods failed for @${username}` };
}

function isTwitterUrl(url) {
  return /twitter\.com|x\.com/i.test(url);
}

// Fetch and store articles for a source
async function fetchAndStore(source, isInitial = false) {
  let result;

  if (source.feed_type === 'twitter') {
    result = await fetchTwitterFeed(source.url);
  } else {
    result = await tryRSS(source.url);
    if (!result.success) {
      console.log(`[RSS] Direct fetch failed for ${source.url}, trying HTML discovery...`);
      const links = await findRSSFromPage(source.url);
      if (links.length > 0) {
        console.log(`[RSS] Found feed link: ${links[0]}`);
        result = await tryRSS(links[0]);
        if (result.success) {
          db.prepare('UPDATE sources SET url=? WHERE id=?').run(links[0], source.id);
        }
      }
    }
  }

  if (!result.success) {
    db.prepare("UPDATE sources SET status='error', error_message=?, last_polled_at=datetime('now') WHERE id=?")
      .run(result.error, source.id);
    return { newArticles: [], error: result.error };
  }

  const feed = result.feed;
  const feedTitle = result.title || feed.title || source.url;

  if (!source.title && feedTitle) {
    db.prepare('UPDATE sources SET title=? WHERE id=?').run(feedTitle, source.id);
    source.title = feedTitle;
  }

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO articles (source_id, title, link, description, published_at, guid)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const newArticles = [];
  for (const item of (feed.items || []).slice(0, 50)) {
    const guid = item.guid || item.id || item.link || `${source.id}-${Date.now()}-${Math.random()}`;
    const link = item.link || item.url || '';
    const title = item.title || item.content || '';
    const desc = (item.contentSnippet || item.content || item.description || '').substring(0, 500);
    const pubDate = item.pubDate || item.isoDate || item.published || new Date().toISOString();

    try {
      const info = insertStmt.run(source.id, title, link, desc, pubDate, guid);
      if (info.changes > 0 && !isInitial) {
        const art = db.prepare('SELECT * FROM articles WHERE rowid=?').get(info.lastInsertRowid);
        if (art) newArticles.push({ ...art, source_title: feedTitle, feed_type: source.feed_type });
      }
    } catch(e) {}
  }

  db.prepare("UPDATE sources SET status='active', error_message=NULL, last_polled_at=datetime('now') WHERE id=?")
    .run(source.id);

  return { newArticles, method: result.method, title: feedTitle };
}

// REST API
app.get('/api/sources', (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM articles WHERE source_id=s.id) as article_count
    FROM sources s ORDER BY s.created_at DESC
  `).all();
  res.json(rows);
});

app.post('/api/sources', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.trim()) return res.status(400).json({ error: 'URL required' });

  const feedType = isTwitterUrl(url) ? 'twitter' : 'rss';
  const info = db.prepare('INSERT INTO sources (url, feed_type, status) VALUES (?, ?, ?)').run(url.trim(), feedType, 'pending');
  const source = db.prepare('SELECT * FROM sources WHERE id=?').get(info.lastInsertRowid);

  const { error, method } = await fetchAndStore(source, true);
  const updated = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM articles WHERE source_id=s.id) as article_count
    FROM sources s WHERE s.id=?
  `).get(source.id);

  broadcast({ type: 'source_added', source: updated });

  if (error) return res.status(422).json({ error, source: updated });
  res.json({ source: updated, method });
});

app.delete('/api/sources/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const src = db.prepare('SELECT id FROM sources WHERE id=?').get(id);
  if (!src) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM sources WHERE id=?').run(id);
  broadcast({ type: 'source_deleted', id });
  res.json({ success: true });
});

app.get('/api/articles', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const articles = db.prepare(`
    SELECT a.*, s.title as source_title, s.feed_type
    FROM articles a
    JOIN sources s ON s.id=a.source_id
    ORDER BY a.published_at DESC, a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  const { count } = db.prepare('SELECT COUNT(*) as count FROM articles').get();
  res.json({ articles, total: count });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Polling loop
async function pollAll() {
  const sources = db.prepare('SELECT * FROM sources').all();
  for (const source of sources) {
    try {
      const { newArticles } = await fetchAndStore(source, false);
      if (newArticles.length > 0) {
        broadcast({ type: 'new_articles', articles: newArticles });
        console.log(`[Poll] +${newArticles.length} new from "${source.title || source.url}"`);
      }
    } catch(e) {
      console.error(`[Poll] Error on ${source.url}:`, e.message);
    }
  }
}

setInterval(pollAll, POLL_INTERVAL);

// WebSocket
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'connected' }));
  console.log(`[WS] Client connected (total: ${wss.clients.size})`);
  ws.on('close', () => console.log(`[WS] Client left (total: ${wss.clients.size})`));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Breaking News Dashboard on http://0.0.0.0:${PORT}`);
});
