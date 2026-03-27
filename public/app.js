const feedEl = document.getElementById("feed");
const feedEmpty = document.getElementById("feedEmpty");
const sourcesList = document.getElementById("sourcesList");
const sourcesEmpty = document.getElementById("sourcesEmpty");
const addForm = document.getElementById("addSourceForm");
const feedUrlInput = document.getElementById("feedUrl");
const addBtn = document.getElementById("addBtn");
const addError = document.getElementById("addError");
const connectionDot = document.getElementById("connectionDot");

// ── State ───────────────────────────────────────────────────────────────────

let articles = [];
let sources = [];

// ── API ─────────────────────────────────────────────────────────────────────

async function fetchSources() {
  const res = await fetch("/api/sources");
  sources = await res.json();
  renderSources();
}

async function fetchArticles() {
  const res = await fetch("/api/articles?limit=100");
  const data = await res.json();
  articles = Array.isArray(data) ? data : (data.articles || []);
  renderArticles();
}

async function addSource(url) {
  addError.textContent = "";
  addBtn.disabled = true;
  addBtn.textContent = "Adding...";

  try {
    const res = await fetch("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();

    if (!res.ok) {
      addError.textContent = data.error || "Failed to add feed";
      return;
    }

    feedUrlInput.value = "";
    await Promise.all([fetchSources(), fetchArticles()]);
  } catch (err) {
    addError.textContent = "Network error";
  } finally {
    addBtn.disabled = false;
    addBtn.textContent = "Add";
  }
}

async function deleteSource(id) {
  await fetch(`/api/sources/${id}`, { method: "DELETE" });
  await Promise.all([fetchSources(), fetchArticles()]);
}

// ── Rendering ───────────────────────────────────────────────────────────────

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.max(0, now - then);

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderSources() {
  sourcesEmpty.style.display = sources.length ? "none" : "block";
  sourcesList.innerHTML = sources
    .map(
      (s) => `
    <li>
      <div class="source-info">
        <div class="source-name" title="${escapeHtml(s.url)}">${escapeHtml(s.title || s.url)}</div>
        <div class="source-count">${s.article_count} articles</div>
      </div>
      <button class="delete-btn" onclick="deleteSource(${s.id})" title="Remove feed">&times;</button>
    </li>
  `
    )
    .join("");
}

function renderArticles(newIds = new Set()) {
  feedEmpty.style.display = articles.length ? "none" : "block";

  const html = articles
    .map(
      (a) => `
    <div class="article${newIds.has(a.id) ? " new" : ""}">
      <div class="article-title">
        <a href="${escapeHtml(a.link)}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a>
      </div>
      <div class="article-meta">
        <span>${escapeHtml(a.source_title || "")}</span>
        <span>${timeAgo(a.published_at)}</span>
      </div>
    </div>
  `
    )
    .join("");

  feedEl.innerHTML = html + (articles.length ? "" : feedEmpty.outerHTML);
}

// ── WebSocket ───────────────────────────────────────────────────────────────

let ws;
let reconnectDelay = 1000;

function connectWs() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    connectionDot.classList.add("connected");
    connectionDot.title = "Connected";
    reconnectDelay = 1000;
  };

  ws.onclose = () => {
    connectionDot.classList.remove("connected");
    connectionDot.title = "Disconnected — reconnecting...";
    setTimeout(connectWs, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };

  ws.onerror = () => {
    ws.close();
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "new_articles" && data.articles.length > 0) {
      const newIds = new Set(data.articles.map((a) => a.id));

      // Prepend new articles and re-sort
      articles = [...data.articles, ...articles].sort(
        (a, b) => new Date(b.published_at) - new Date(a.published_at)
      );
      renderArticles(newIds);
      fetchSources(); // Update counts

      // Browser notification
      if (Notification.permission === "granted") {
        const count = data.articles.length;
        const title = count === 1 ? data.articles[0].title : `${count} new articles`;
        const body =
          count === 1
            ? data.articles[0].source_title
            : data.articles.map((a) => a.title).slice(0, 3).join("\n");

        new Notification(title, { body, icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📰</text></svg>" });
      }

      // Clear new highlight after 5s
      setTimeout(() => {
        document.querySelectorAll(".article.new").forEach((el) => el.classList.remove("new"));
      }, 5000);
    }
  };
}

// ── Notifications ───────────────────────────────────────────────────────────

if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission();
}

// ── Events ──────────────────────────────────────────────────────────────────

addForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const url = feedUrlInput.value.trim();
  if (url) addSource(url);
});

// ── Init ────────────────────────────────────────────────────────────────────

fetchSources();
fetchArticles();
connectWs();

// Refresh relative timestamps every minute
setInterval(() => renderArticles(), 60000);
