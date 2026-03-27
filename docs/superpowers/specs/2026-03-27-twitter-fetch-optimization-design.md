# Twitter Feed Fetch Optimization — Design Spec

## Problem
The `fetchTwitterFeed()` function in `server.js` uses a sequential fallback chain:
1. RSSBridge (always fails)
2. Nitter privacydev (always fails)
3. Nitter poast (always fails)
4. Nitter.net (always succeeds)

This wastes ~10-20s per poll cycle trying 3 dead endpoints before hitting the working one. With a 15s poll interval, the fetch itself takes longer than the interval.

## Design

### Approach: Smart method caching with parallel fallback

**Core idea:** Remember which fetch method last succeeded for each Twitter source. On the next poll, try that method first. If it fails, race the remaining methods in parallel and update the cache.

### Implementation Details

**1. Method cache (in-memory Map)**
```js
const twitterMethodCache = new Map(); // username -> { method, url }
```

**2. Refactor fetch methods into named, independent functions**
Each method becomes a standalone async function that returns the same shape:
- `tryRSSBridge(username)`
- `tryNitter(username, baseUrl)`
- `trySyndication(username)`
- `tryDirectScrape(username)`

**3. Modified `fetchTwitterFeed()` flow:**
```
1. Check cache for this username
2. If cached method exists → try it first
   - Success → return result
   - Fail → clear cache, continue to step 3
3. Race ALL methods in parallel via Promise.any()
4. First success → cache the winning method, return result
5. All fail → return error
```

**4. Why `Promise.any()` for fallback:**
- Fires all methods simultaneously
- Resolves with the first success
- Only rejects if ALL fail
- Much faster than sequential: ~3-5s instead of ~10-20s

**5. Cache invalidation:**
- On failure of cached method, clear and re-race
- No TTL needed — if a method starts failing, next poll auto-discovers the new winner

### What changes
- `server.js`: Refactor `fetchTwitterFeed()` function (~100 lines)
- No new files, no new dependencies
- No DB changes
- Backward compatible — same inputs/outputs

### What doesn't change
- RSS feed polling (unrelated)
- Article deduplication logic
- WebSocket broadcast
- API endpoints

### Expected improvement
- Cached hit (normal case): ~2-3s per Twitter poll (down from ~10-20s)
- Cache miss (rare): ~3-5s via parallel race (down from ~10-20s sequential)
- Net effect: Twitter polls complete in time for the 15s interval instead of exceeding it
