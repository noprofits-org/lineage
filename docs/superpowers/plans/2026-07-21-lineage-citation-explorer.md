# Lineage Citation Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build lineage.pvjohnston.com — a static single-page citation-graph explorer over the Semantic Scholar API with a time-axis (year-pinned x) layout.

**Architecture:** Single page, no build step: `index.html` loads ES modules directly (`main.js` controller+model, `s2.js` API client, `graph.js` D3 renderer, `lineage.css` theme). D3 v7 from CDN. Unit tests via `node --test`; e2e via Playwright with `page.route` stubbing both the API and the D3 CDN URL.

**Tech Stack:** Vanilla ES modules, D3 v7 (CDN), `@playwright/test` (only dependency, dev-only), Node 24 built-in test runner, Python's `http.server` for local serving.

**Spec:** `docs/superpowers/specs/2026-07-21-lineage-citation-explorer-design.md` — binding. Read it before starting.

## Global Constraints

- No build step, no runtime dependencies, no API keys. The only devDependency is `@playwright/test`.
- D3 is pinned to `d3@7.9.0` on the CDN with Subresource Integrity (`integrity` + `crossorigin="anonymous"` exactly as written in Task 7); never load it unpinned or without SRI.
- Repo root IS the site root (`index.html` at top level), sibling style to `~/noprofits/grants`.
- Single accent color `#465C9B`, used only for selected node, its direct edges, and hyperlinks. Everything else monochrome. No shadows, gradients, or rounded corners (border-radius 0 everywhere).
- Fonts: Hanken Grotesk (UI), Bricolage Grotesque (wordmark only) — woff2 copied from `../pvjohnston.com/fonts/`; mono is the system stack `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace` (no mono font file shipped).
- Edges encode citation **citing → cited** (usually, not always, newer → older); UI copy must use exactly: "Edges encode citation, from the citing paper to the cited paper — usually, but not always, newer to older. Read the graph left-to-right as intellectual influence."
- Constants (exact values): pool `limit=500`; admit batch 25; node cap 300; queue pace 1 request/second; retry max 4 attempts, base 1 s, max delay 30 s, full jitter; cache prefix `lineage.v1.`, cap 2,000,000 bytes.
- Truthful disclosure strings must match the spec's three tiers exactly (formats in Task 5).
- All commits on `main` of the `lineage` repo, message style `feat:`/`test:`/`chore:`, each ending with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Scaffolding and test harness

**Files:**
- Create: `package.json`, `.gitignore`, `playwright.config.js`, `tests/unit/smoke.test.mjs`, `tests/fixtures/d3.v7.min.js` (downloaded)

**Interfaces:**
- Produces: npm scripts `test` (unit), `test:e2e`, `serve`; the committed d3 fixture used by every e2e task.

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "lineage",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/unit/",
    "test:e2e": "playwright test",
    "serve": "python3 -m http.server 8010"
  },
  "devDependencies": {
    "@playwright/test": "^1.45.0"
  }
}
```

`.gitignore`:
```
node_modules/
test-results/
playwright-report/
.DS_Store
```

`playwright.config.js`:
```js
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 20_000,
  use: { baseURL: 'http://127.0.0.1:8010' },
  webServer: {
    command: 'python3 -m http.server 8010',
    port: 8010,
    reuseExistingServer: true,
  },
})
```

- [ ] **Step 2: Install dev tooling** (the plan's only installs — pre-announced here per Peter's global rules)

Run: `npm install && npx playwright install chromium`
Expected: `@playwright/test` in `node_modules`, chromium downloaded.

- [ ] **Step 3: Download the d3 fixture (served to the browser in e2e instead of the CDN)**

Run: `mkdir -p tests/fixtures && curl -sL https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js -o tests/fixtures/d3.v7.min.js && head -c 60 tests/fixtures/d3.v7.min.js`
Expected: file exists, starts with a d3 v7 banner/minified JS.

- [ ] **Step 4: Write a smoke unit test**

`tests/unit/smoke.test.mjs`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'

test('harness runs', () => { assert.equal(1 + 1, 2) })
```

- [ ] **Step 5: Run it**

Run: `npm test`
Expected: `pass 1`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore playwright.config.js tests/
git commit -m "chore: scaffold repo, test harness, d3 e2e fixture"
```

---

### Task 2: s2.js — response mapping, error classification, backoff

**Files:**
- Create: `s2.js`
- Test: `tests/unit/s2-pure.test.mjs`

**Interfaces:**
- Produces (exact signatures, consumed by Tasks 4, 5, 8+):
  - `mapPaper(raw) -> {paperId, title, year, authors: string[], venue, abstract, citationCount, referenceCount, doi} | null`
  - `mapConnections(json, direction) -> {papers: Paper[], next: number|null}` — `direction` is `'citations' | 'references'`
  - `isRetryable(status: number) -> boolean` (429, >=500, and 0 = network error)
  - `backoffDelay(attempt, retryAfterSeconds, rand = Math.random) -> ms`
  - Constants: `API_BASE`, `PAPER_FIELDS`, `POOL_LIMIT = 500`, `MAX_ATTEMPTS = 4`, `PACE_MS = 1000`

- [ ] **Step 1: Write the failing tests**

`tests/unit/s2-pure.test.mjs`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mapPaper, mapConnections, isRetryable, backoffDelay, POOL_LIMIT, MAX_ATTEMPTS } from '../../s2.js'

test('mapPaper normalizes a raw record', () => {
  const p = mapPaper({
    paperId: 'abc', title: 'T', year: 1953,
    authors: [{ name: 'J. Watson' }, { name: null }],
    venue: 'Nature', citationCount: 443, referenceCount: 6,
    externalIds: { DOI: '10.1038/171737a0' },
  })
  assert.deepEqual(p, {
    paperId: 'abc', title: 'T', year: 1953, authors: ['J. Watson'],
    venue: 'Nature', abstract: null, citationCount: 443, referenceCount: 6,
    doi: '10.1038/171737a0',
  })
})

test('mapPaper: missing year -> null year; missing counts -> 0; no paperId -> null', () => {
  assert.equal(mapPaper({ paperId: 'x', title: 'T' }).year, null)
  assert.equal(mapPaper({ paperId: 'x', title: 'T' }).citationCount, 0)
  assert.equal(mapPaper({ paperId: null, title: 'T' }), null)
  assert.equal(mapPaper(null), null)
})

test('mapConnections unwraps citingPaper/citedPaper and next', () => {
  const cit = mapConnections({ offset: 0, data: [{ citingPaper: { paperId: 'c1', title: 'C' } }], next: 500 }, 'citations')
  assert.equal(cit.papers[0].paperId, 'c1')
  assert.equal(cit.next, 500)
  const ref = mapConnections({ offset: 0, data: [{ citedPaper: { paperId: 'r1', title: 'R' } }] }, 'references')
  assert.equal(ref.papers[0].paperId, 'r1')
  assert.equal(ref.next, null)   // absent next -> null (completeness authority)
})

test('mapConnections drops rows with null papers (API tombstones)', () => {
  const out = mapConnections({ data: [{ citedPaper: null }, { citedPaper: { paperId: 'ok', title: 'T' } }] }, 'references')
  assert.equal(out.papers.length, 1)
})

test('isRetryable: 429/5xx/network yes, 400/404 no', () => {
  assert.equal(isRetryable(429), true)
  assert.equal(isRetryable(500), true)
  assert.equal(isRetryable(503), true)
  assert.equal(isRetryable(0), true)
  assert.equal(isRetryable(400), false)
  assert.equal(isRetryable(404), false)
})

test('backoffDelay: honors Retry-After, else full jitter under 2^attempt seconds, capped at 30s', () => {
  assert.equal(backoffDelay(0, 7), 7000)
  assert.equal(backoffDelay(0, 90), 30000)                     // Retry-After capped
  assert.equal(backoffDelay(0, null, () => 0.5), 500)          // 0.5 * 1000
  assert.equal(backoffDelay(2, null, () => 0.5), 2000)         // 0.5 * 4000
  assert.equal(backoffDelay(10, null, () => 0.999), 29970)     // capped at 30000
})

test('constants', () => {
  assert.equal(POOL_LIMIT, 500)
  assert.equal(MAX_ATTEMPTS, 4)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `Cannot find module ... s2.js`.

- [ ] **Step 3: Implement the pure layer of `s2.js`**

`s2.js` (start of file — the client class is appended in Task 4):
```js
// Semantic Scholar Academic Graph client for Lineage.
// Pure helpers here; S2Client (queue + retry + cache) below.

export const API_BASE = 'https://api.semanticscholar.org/graph/v1'
export const PAPER_FIELDS = 'title,year,authors,venue,citationCount,referenceCount,externalIds'
export const POOL_LIMIT = 500
export const MAX_ATTEMPTS = 4
export const PACE_MS = 1000
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30000

export function mapPaper(raw) {
  if (!raw || !raw.paperId) return null
  return {
    paperId: raw.paperId,
    title: raw.title || 'Untitled',
    year: Number.isInteger(raw.year) ? raw.year : null,
    authors: (raw.authors || []).map(a => a && a.name).filter(Boolean),
    venue: raw.venue || null,
    abstract: raw.abstract || null,
    citationCount: raw.citationCount ?? 0,
    referenceCount: raw.referenceCount ?? 0,
    doi: raw.externalIds?.DOI || null,
  }
}

export function mapConnections(json, direction) {
  const key = direction === 'citations' ? 'citingPaper' : 'citedPaper'
  const papers = (json.data || []).map(row => mapPaper(row[key])).filter(Boolean)
  return { papers, next: json.next ?? null }
}

export function isRetryable(status) {
  return status === 429 || status >= 500 || status === 0
}

export function backoffDelay(attempt, retryAfterSeconds, rand = Math.random) {
  if (retryAfterSeconds != null) return Math.min(retryAfterSeconds * 1000, MAX_DELAY_MS)
  const cap = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
  return Math.floor(rand() * cap)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add s2.js tests/unit/s2-pure.test.mjs
git commit -m "feat: s2 response mapping, retry classification, jittered backoff"
```

---

### Task 3: s2.js — cache (memory + localStorage, LRU, corruption/quota fallback)

**Files:**
- Modify: `s2.js` (append)
- Test: `tests/unit/s2-cache.test.mjs`

**Interfaces:**
- Produces: `createCache(storage|null) -> {get(key), set(key, val), diskDisabled() -> boolean}`. Keys are URL strings; values JSON-serializable. `storage` is any localStorage-shaped object; `null` means memory-only.

- [ ] **Step 1: Write the failing tests**

`tests/unit/s2-cache.test.mjs`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCache } from '../../s2.js'

function fakeStorage() {
  const m = new Map()
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    _map: m,
  }
}

test('set/get round-trips via memory and disk', () => {
  const disk = fakeStorage()
  const c = createCache(disk)
  c.set('u1', { a: 1 })
  assert.deepEqual(c.get('u1'), { a: 1 })
  // fresh cache over same disk -> disk hit
  const c2 = createCache(disk)
  assert.deepEqual(c2.get('u1'), { a: 1 })
})

test('corrupt disk entry degrades to a miss, not a throw', () => {
  const disk = fakeStorage()
  disk.setItem('lineage.v1.bad', '{not json')
  const c = createCache(disk)
  assert.equal(c.get('bad'), undefined)
})

test('quota error flips to memory-only and keeps working', () => {
  const disk = fakeStorage()
  disk.setItem = () => { throw new Error('QuotaExceededError') }
  const c = createCache(disk)
  c.set('u1', { a: 1 })
  assert.equal(c.diskDisabled(), true)
  assert.deepEqual(c.get('u1'), { a: 1 })   // memory still serves it
})

test('LRU evicts oldest entries beyond the byte cap', () => {
  const disk = fakeStorage()
  const c = createCache(disk, { maxBytes: 50 })
  c.set('a', 'xxxxxxxxxxxxxxxxxxxx')   // ~22 bytes serialized
  c.set('b', 'yyyyyyyyyyyyyyyyyyyy')
  c.set('c', 'zzzzzzzzzzzzzzzzzzzz')   // pushes 'a' out
  assert.equal(disk.getItem('lineage.v1.a'), null)
  assert.notEqual(disk.getItem('lineage.v1.c'), null)
})

test('null storage means memory-only from the start', () => {
  const c = createCache(null)
  c.set('k', 1)
  assert.equal(c.get('k'), 1)
  assert.equal(c.diskDisabled(), true)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `createCache` not exported.

- [ ] **Step 3: Implement (append to `s2.js`)**

```js
const CACHE_PREFIX = 'lineage.v1.'
const CACHE_INDEX_KEY = 'lineage.v1.__index'
const CACHE_MAX_BYTES = 2_000_000

export function createCache(storage, { maxBytes = CACHE_MAX_BYTES } = {}) {
  const mem = new Map()
  let disk = storage || null
  const readIndex = () => {
    try { return JSON.parse(disk.getItem(CACHE_INDEX_KEY)) || [] } catch { return [] }
  }
  return {
    get(key) {
      if (mem.has(key)) return mem.get(key)
      if (!disk) return undefined
      try {
        const raw = disk.getItem(CACHE_PREFIX + key)
        if (raw == null) return undefined
        const val = JSON.parse(raw)
        mem.set(key, val)
        return val
      } catch { return undefined }
    },
    set(key, val) {
      mem.set(key, val)
      if (!disk) return
      try {
        const raw = JSON.stringify(val)
        let idx = readIndex().filter(e => e.k !== key)
        idx.push({ k: key, n: raw.length + key.length + 24 })
        let total = idx.reduce((s, e) => s + e.n, 0)
        while (total > maxBytes && idx.length > 1) {
          const ev = idx.shift()
          try { disk.removeItem(CACHE_PREFIX + ev.k) } catch {}
          total -= ev.n
        }
        disk.setItem(CACHE_PREFIX + key, raw)
        disk.setItem(CACHE_INDEX_KEY, JSON.stringify(idx))
      } catch { disk = null }   // quota / unavailable -> memory-only from here on
    },
    diskDisabled: () => disk == null,
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: all PASS. If the LRU test's byte math is off by a few bytes, adjust the test's `maxBytes` (the behavior under test is eviction order, not exact byte counts).

- [ ] **Step 5: Commit**

```bash
git add s2.js tests/unit/s2-cache.test.mjs
git commit -m "feat: versioned LRU cache with quota/corruption fallback"
```

---

### Task 4: s2.js — S2Client (1 rps queue, retry with pause, endpoints, staleness)

**Files:**
- Modify: `s2.js` (append)
- Test: `tests/unit/s2-client.test.mjs`

**Interfaces:**
- Produces (consumed by Task 8+):
  - `class S2Client({fetchFn, storage, onStatus, delay})`
    - `search(query) -> Promise<Paper[]>` (limit 10)
    - `paper(id) -> Promise<Paper>` (includes abstract)
    - `connections(id, direction, offset = 0, isStale = () => false) -> Promise<{papers, next}>` (limit `POOL_LIMIT`)
    - `onStatus({state: 'loading'|'idle'|'backoff'|'error'|'note', message?, retryable?})`
    - `delay(ms) -> Promise` injectable for tests; defaults to setTimeout.
  - `class S2Error extends Error {status, retryable}`; `class StaleError extends Error`

- [ ] **Step 1: Write the failing tests**

`tests/unit/s2-client.test.mjs`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { S2Client, S2Error, StaleError, PACE_MS } from '../../s2.js'

const ok = json => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => json })
const err = (status, retryAfter = null) => ({
  ok: false, status,
  headers: { get: h => (h === 'Retry-After' ? retryAfter : null) },
  json: async () => ({}),
})

function makeClient(responses, { delays = [] } = {}) {
  const calls = []
  const client = new S2Client({
    fetchFn: async url => { calls.push(url); const r = responses.shift(); if (r === 'network') throw new TypeError('fetch failed'); return r },
    storage: null,
    onStatus: () => {},
    delay: async ms => { delays.push(ms) },
  })
  return { client, calls, delays }
}

test('search maps results', async () => {
  const { client } = makeClient([ok({ data: [{ paperId: 'p1', title: 'A' }] })])
  const out = await client.search('dna')
  assert.equal(out[0].paperId, 'p1')
})

test('responses are cached: identical request does not refetch', async () => {
  const { client, calls } = makeClient([ok({ data: [] })])
  await client.search('q')
  await client.search('q')
  assert.equal(calls.length, 1)
})

test('requests are paced >= PACE_MS apart via injected delay', async () => {
  const { client, delays } = makeClient([ok({ data: [] }), ok({ data: [] })])
  await client.search('a')
  await client.search('b')
  assert.ok(delays.some(ms => ms > 0 && ms <= PACE_MS), `expected a pacing delay, got ${delays}`)
})

test('429 retries with Retry-After honored, then succeeds', async () => {
  const { client, calls, delays } = makeClient([err(429, '3'), ok({ data: [] })])
  await client.search('q')
  assert.equal(calls.length, 2)
  assert.ok(delays.includes(3000), `expected 3000ms Retry-After delay in ${delays}`)
})

test('404 fails immediately, no retry, S2Error not retryable', async () => {
  const { client, calls } = makeClient([err(404)])
  await assert.rejects(() => client.paper('nope'), e => e instanceof S2Error && e.retryable === false)
  assert.equal(calls.length, 1)
})

test('network errors retry; exhaustion after MAX_ATTEMPTS yields retryable S2Error', async () => {
  const { client, calls } = makeClient(['network', 'network', 'network', 'network'])
  await assert.rejects(() => client.search('q'), e => e instanceof S2Error && e.retryable === true)
  assert.equal(calls.length, 4)
})

test('a failed request does not wedge the queue', async () => {
  const { client } = makeClient([err(400), ok({ data: [] })])
  await assert.rejects(() => client.search('bad'))
  const out = await client.search('good')
  assert.deepEqual(out, [])
})

test('stale check runs before the fetch and drops the queued request', async () => {
  const { client, calls } = makeClient([ok({ data: [] })])
  await assert.rejects(
    () => client.connections('p1', 'citations', 0, () => true),
    e => e instanceof StaleError,
  )
  assert.equal(calls.length, 0)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `S2Client` not exported.

- [ ] **Step 3: Implement (append to `s2.js`)**

```js
export class S2Error extends Error {
  constructor(status, retryable) {
    super(`S2 request failed (${status})`)
    this.status = status
    this.retryable = retryable
  }
}

export class StaleError extends Error {
  constructor() { super('request superseded by graph reset') }
}

export class S2Client {
  constructor({ fetchFn, storage, onStatus, delay } = {}) {
    this.fetchFn = fetchFn || ((...a) => fetch(...a))
    this.cache = createCache(
      storage !== undefined ? storage : (typeof localStorage !== 'undefined' ? localStorage : null),
    )
    this.onStatus = onStatus || (() => {})
    this.delay = delay || (ms => new Promise(r => setTimeout(r, ms)))
    this.chain = Promise.resolve()
    this.lastStart = 0
  }

  request(path, isStale = () => false) {
    const url = API_BASE + path
    const cached = this.cache.get(url)
    if (cached !== undefined) return Promise.resolve(cached)
    const run = this.chain.then(() => {
      if (isStale()) throw new StaleError()
      return this.#fetchWithRetry(url)
    })
    this.chain = run.then(() => {}, () => {})   // keep the queue alive after failures
    return run
  }

  async #fetchWithRetry(url) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const wait = this.lastStart + PACE_MS - Date.now()
      if (wait > 0) await this.delay(wait)
      this.lastStart = Date.now()
      this.onStatus({ state: 'loading' })
      let res
      try {
        res = await this.fetchFn(url)
      } catch {
        res = { ok: false, status: 0, headers: { get: () => null } }
      }
      if (res.ok) {
        const json = await res.json()
        this.cache.set(url, json)
        if (this.cache.diskDisabled()) {
          this.onStatus({ state: 'note', message: 'local cache unavailable — using memory only' })
        }
        this.onStatus({ state: 'idle' })
        return json
      }
      if (!isRetryable(res.status)) {
        this.onStatus({
          state: 'error',
          message: res.status === 404 ? 'paper not found' : `request failed (${res.status})`,
        })
        throw new S2Error(res.status, false)
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        const raw = res.headers && res.headers.get ? res.headers.get('Retry-After') : null
        const ra = raw != null && Number.isFinite(Number(raw)) ? Number(raw) : null
        const ms = backoffDelay(attempt, ra)
        this.onStatus({ state: 'backoff', message: `rate limited — retrying in ${Math.max(1, Math.round(ms / 1000))}s` })
        await this.delay(ms)
      }
    }
    this.onStatus({ state: 'error', message: 'request failed after retries', retryable: true })
    throw new S2Error(429, true)
  }

  search(query) {
    return this
      .request(`/paper/search?query=${encodeURIComponent(query)}&fields=${PAPER_FIELDS}&limit=10`)
      .then(json => (json.data || []).map(mapPaper).filter(Boolean))
  }

  paper(id) {
    return this.request(`/paper/${id}?fields=${PAPER_FIELDS},abstract`).then(mapPaper)
  }

  connections(id, direction, offset = 0, isStale = () => false) {
    return this
      .request(`/paper/${id}/${direction}?fields=${PAPER_FIELDS}&offset=${offset}&limit=${POOL_LIMIT}`, isStale)
      .then(json => mapConnections(json, direction))
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: all PASS. Note the retry loop retries in place (inside the queued task), so the queue "pauses while backing off rather than dropping requests" — exactly the spec.

- [ ] **Step 5: Commit**

```bash
git add s2.js tests/unit/s2-client.test.mjs
git commit -m "feat: S2Client with paced queue, retry policy, staleness drop"
```

---

### Task 5: main.js — model (state, expansion, ranking, cap, disclosure)

**Files:**
- Create: `main.js` (pure model half; controller half comes in Task 8)
- Test: `tests/unit/model.test.mjs`

**Interfaces:**
- Produces (consumed by Tasks 8–13):
  - `NODE_CAP = 300`, `BATCH = 25`
  - `createState() -> {gen, nodes: Map<paperId, Node>, edges: Map<string, {citing, cited}>, selected, seedId}`
  - `addPaper(state, paper) -> Node` — idempotent; Node = paper + `expansion: {references: Exp, citations: Exp}`
  - `newExpansion(total) -> Exp` where `Exp = {status:'idle'|'loading'|'error', nextOffset: 0|number|null, fetchedCount, displayedCount, total, exhausted, pool: Paper[]}`
  - `addEdge(state, citingId, citedId) -> boolean` (deduped; self-loops rejected)
  - `rankPool(papers) -> Paper[]` (citationCount desc, stable copy)
  - `completeFetch(exp, {papers, next})` — merges into ranked pool, updates counts/offset/exhausted, status → idle
  - `admit(state, node, direction, {cap = NODE_CAP} = {}) -> {admitted: Node[], capped: boolean, requested: number}` — rank order, partial admission at cap; adds edges (direction `'citations'`: other→node; `'references'`: node→other)
  - `disclosure(exp, noun) -> string` — the spec's three tiers, `noun` is `'citations' | 'references'`

- [ ] **Step 1: Write the failing tests**

`tests/unit/model.test.mjs`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createState, addPaper, addEdge, newExpansion, rankPool,
  completeFetch, admit, disclosure, NODE_CAP, BATCH,
} from '../../main.js'

const paper = (id, year, cc = 0, rc = 0) => ({
  paperId: id, title: `T${id}`, year, authors: ['A'], venue: null,
  abstract: null, citationCount: cc, referenceCount: rc, doi: null,
})

test('addPaper is idempotent and attaches expansion state', () => {
  const s = createState()
  const a = addPaper(s, paper('a', 1990, 10, 3))
  const a2 = addPaper(s, paper('a', 1990, 10, 3))
  assert.equal(a, a2)
  assert.equal(s.nodes.size, 1)
  assert.equal(a.expansion.citations.total, 10)
  assert.equal(a.expansion.references.total, 3)
  assert.equal(a.expansion.references.status, 'idle')
})

test('addEdge dedupes and rejects self-loops', () => {
  const s = createState()
  assert.equal(addEdge(s, 'x', 'y'), true)
  assert.equal(addEdge(s, 'x', 'y'), false)
  assert.equal(addEdge(s, 'x', 'x'), false)
  assert.equal(s.edges.size, 1)
})

test('rankPool sorts by citationCount desc without mutating input', () => {
  const input = [paper('l', 2000, 5), paper('h', 2000, 500), paper('m', 2000, 50)]
  const out = rankPool(input)
  assert.deepEqual(out.map(p => p.paperId), ['h', 'm', 'l'])
  assert.equal(input[0].paperId, 'l')
})

test('completeFetch merges pages ranked, tracks counts and exhaustion via next', () => {
  const exp = newExpansion(443)
  completeFetch(exp, { papers: [paper('a', 1990, 1), paper('b', 1990, 100)], next: 500 })
  assert.equal(exp.fetchedCount, 2)
  assert.equal(exp.exhausted, false)
  assert.equal(exp.nextOffset, 500)
  completeFetch(exp, { papers: [paper('c', 1991, 50)], next: null })
  assert.equal(exp.exhausted, true)
  assert.equal(exp.nextOffset, null)
  assert.deepEqual(exp.pool.map(p => p.paperId), ['b', 'c', 'a'])
})

test('admit takes top BATCH in rank order and wires edge direction', () => {
  const s = createState()
  const seed = addPaper(s, paper('seed', 1953, 443, 6))
  const exp = seed.expansion.citations
  completeFetch(exp, { papers: Array.from({ length: 30 }, (_, i) => paper(`c${i}`, 1960, 30 - i)), next: null })
  const { admitted, capped } = admit(s, seed, 'citations')
  assert.equal(admitted.length, BATCH)
  assert.equal(capped, false)
  assert.equal(exp.displayedCount, BATCH)
  assert.equal(exp.pool.length, 5)
  assert.ok(s.edges.has('c0→seed'))          // citations: other -> seed
  const rexp = seed.expansion.references
  completeFetch(rexp, { papers: [paper('r0', 1949, 9)], next: null })
  admit(s, seed, 'references')
  assert.ok(s.edges.has('seed→r0'))          // references: seed -> other
})

test('admit at node cap: partial admission in rank order, capped flag', () => {
  const s = createState()
  const seed = addPaper(s, paper('seed', 1953, 443, 6))
  const exp = seed.expansion.citations
  completeFetch(exp, { papers: Array.from({ length: 25 }, (_, i) => paper(`c${i}`, 1960, 25 - i)), next: null })
  const { admitted, capped, requested } = admit(s, seed, 'citations', { cap: 11 })  // room for 10 new
  assert.equal(admitted.length, 10)
  assert.equal(capped, true)
  assert.equal(requested, 25)
  assert.deepEqual(admitted.map(n => n.paperId), Array.from({ length: 10 }, (_, i) => `c${i}`))
})

test('admit: papers already in the graph do not consume cap and still gain edges', () => {
  const s = createState()
  const seed = addPaper(s, paper('seed', 1953, 443, 6))
  addPaper(s, paper('c0', 1960, 99))
  const exp = seed.expansion.citations
  completeFetch(exp, { papers: [paper('c0', 1960, 99)], next: null })
  const { admitted } = admit(s, seed, 'citations', { cap: 2 })   // graph already full
  assert.equal(admitted.length, 1)
  assert.ok(s.edges.has('c0→seed'))
})

test('disclosure: three tiers exactly per spec', () => {
  // tier 1: exhausted, counts agree
  const t1 = newExpansion(443)
  completeFetch(t1, { papers: Array.from({ length: 443 }, (_, i) => paper(`p${i}`, 1960, i)), next: null })
  t1.displayedCount = 25
  assert.equal(disclosure(t1, 'citations'), 'showing top 25 of 443 citations')
  // tier 2: exhausted, counts differ
  const t2 = newExpansion(443)
  completeFetch(t2, { papers: Array.from({ length: 431 }, (_, i) => paper(`p${i}`, 1960, i)), next: null })
  t2.displayedCount = 25
  assert.equal(disclosure(t2, 'citations'), 'showing 25 of 431 available papers (443 citations reported)')
  // tier 3: more pages remain
  const t3 = newExpansion(8412)
  completeFetch(t3, { papers: Array.from({ length: 500 }, (_, i) => paper(`p${i}`, 1960, i)), next: 500 })
  t3.displayedCount = 25
  assert.equal(disclosure(t3, 'citations'), 'showing top 25 of the first 500 fetched (8,412 total)')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `main.js` missing.

- [ ] **Step 3: Implement the model half of `main.js`**

`main.js`:
```js
// Lineage controller + graph model. The pure model lives up top (unit
// tested); DOM wiring is in init() at the bottom and only runs in the page.

export const NODE_CAP = 300
export const BATCH = 25

export function createState() {
  return { gen: 0, nodes: new Map(), edges: new Map(), selected: null, seedId: null }
}

export function newExpansion(total) {
  return {
    status: 'idle', nextOffset: 0, fetchedCount: 0,
    displayedCount: 0, total, exhausted: false, pool: [],
  }
}

export function addPaper(state, paper) {
  const existing = state.nodes.get(paper.paperId)
  if (existing) return existing
  const node = {
    ...paper,
    expansion: {
      references: newExpansion(paper.referenceCount),
      citations: newExpansion(paper.citationCount),
    },
  }
  state.nodes.set(paper.paperId, node)
  return node
}

export function addEdge(state, citing, cited) {
  if (citing === cited) return false
  const key = `${citing}→${cited}`
  if (state.edges.has(key)) return false
  state.edges.set(key, { citing, cited })
  return true
}

export function rankPool(papers) {
  return [...papers].sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0))
}

export function completeFetch(exp, { papers, next }) {
  exp.status = 'idle'
  exp.pool = rankPool([...exp.pool, ...papers])
  exp.fetchedCount += papers.length
  exp.nextOffset = next
  exp.exhausted = next == null
}

export function admit(state, node, direction, { cap = NODE_CAP } = {}) {
  const exp = node.expansion[direction]
  const requested = exp.pool.length
  const want = Math.min(BATCH, exp.pool.length)
  const admitted = []
  let capped = false
  while (admitted.length < want && exp.pool.length > 0) {
    const paper = exp.pool[0]
    const isNew = !state.nodes.has(paper.paperId)
    if (isNew && state.nodes.size >= cap) { capped = true; break }
    exp.pool.shift()
    const other = addPaper(state, paper)
    if (direction === 'citations') addEdge(state, other.paperId, node.paperId)
    else addEdge(state, node.paperId, other.paperId)
    admitted.push(other)
    exp.displayedCount += 1
  }
  return { admitted, capped, requested }
}

const fmt = n => n.toLocaleString('en-US')

export function disclosure(exp, noun) {
  if (exp.exhausted && exp.fetchedCount === exp.total) {
    return `showing top ${fmt(exp.displayedCount)} of ${fmt(exp.total)} ${noun}`
  }
  if (exp.exhausted) {
    return `showing ${fmt(exp.displayedCount)} of ${fmt(exp.fetchedCount)} available papers (${fmt(exp.total)} ${noun} reported)`
  }
  return `showing top ${fmt(exp.displayedCount)} of the first ${fmt(exp.fetchedCount)} fetched (${fmt(exp.total)} total)`
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add main.js tests/unit/model.test.mjs
git commit -m "feat: graph model — expansion state, ranked admission, cap, disclosure"
```

---

### Task 6: graph.js — pure layout math

**Files:**
- Create: `graph.js` (pure half; D3 renderer appended in Task 9)
- Test: `tests/unit/layout.test.mjs`

**Interfaces:**
- Produces (consumed by renderer in Task 9 and keyboard nav in Task 12):
  - `GUTTER_W = 84`, `PAD = 24`
  - `datedDomain(nodesIterable) -> [minYear, maxYear] | null` (single year widens ±1; null if no dated nodes)
  - `solveDomain({minYear, maxYear, selYear, prevFrac}) -> [a, b]` — domain ⊇ [minYear,maxYear] whose scale keeps the selected node at `prevFrac` of the plot width, exactly when `prevFrac` ∈ (0.02, 0.98), clamped (minimal displacement) otherwise
  - `makeXScale(domain, width) -> (year) => x` (maps domain onto `[PAD, width - GUTTER_W - PAD]`)
  - `gutterX(width) -> x` (center of the undated gutter)
  - `nodeRadius(citationCount) -> px` (3–6, log-scaled)
  - `nearestInDirection(positions, fromId, dir) -> id | null` — `positions: [{id,x,y}]`, `dir: 'left'|'right'|'up'|'down'`; ±45° cone first, half-plane fallback

- [ ] **Step 1: Write the failing tests**

`tests/unit/layout.test.mjs`:
```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  datedDomain, solveDomain, makeXScale, gutterX,
  nodeRadius, nearestInDirection, GUTTER_W, PAD,
} from '../../graph.js'

test('datedDomain ignores undated, widens single year, null when none dated', () => {
  assert.deepEqual(datedDomain([{ year: 1990 }, { year: null }, { year: 2001 }]), [1990, 2001])
  assert.deepEqual(datedDomain([{ year: 1990 }]), [1989, 1991])
  assert.equal(datedDomain([{ year: null }]), null)
})

test('solveDomain keeps selected fraction exactly when feasible', () => {
  const [a, b] = solveDomain({ minYear: 1950, maxYear: 2000, selYear: 1990, prevFrac: 0.5 })
  assert.ok(a <= 1950 && b >= 2000)
  assert.ok(Math.abs((1990 - a) / (b - a) - 0.5) < 1e-9)
})

test('solveDomain clamps when selected sat at the plot edge (minimal displacement)', () => {
  const [a, b] = solveDomain({ minYear: 1900, maxYear: 2000, selYear: 1950, prevFrac: 0 })
  assert.ok(a <= 1900 && b >= 2000)
  const f = (1950 - a) / (b - a)
  assert.ok(f > 0 && f <= 0.03, `clamped fraction, got ${f}`)
})

test('makeXScale maps domain ends onto padded plot area, reserving the gutter', () => {
  const x = makeXScale([1900, 2000], 1000)
  assert.equal(x(1900), PAD)
  assert.equal(x(2000), 1000 - GUTTER_W - PAD)
  assert.ok(gutterX(1000) > 1000 - GUTTER_W && gutterX(1000) < 1000)
})

test('nodeRadius: 3px floor, 6px ceiling, monotone', () => {
  assert.equal(nodeRadius(0), 3)
  assert.ok(nodeRadius(100) > nodeRadius(10))
  assert.ok(nodeRadius(10_000_000) <= 6)
})

test('nearestInDirection picks the nearest node in the cone', () => {
  const pos = [
    { id: 'me', x: 100, y: 100 },
    { id: 'right-near', x: 160, y: 110 },
    { id: 'right-far', x: 400, y: 100 },
    { id: 'left', x: 20, y: 100 },
    { id: 'below', x: 105, y: 300 },
  ]
  assert.equal(nearestInDirection(pos, 'me', 'right'), 'right-near')
  assert.equal(nearestInDirection(pos, 'me', 'left'), 'left')
  assert.equal(nearestInDirection(pos, 'me', 'down'), 'below')
  assert.equal(nearestInDirection(pos, 'me', 'up'), null)
})

test('nearestInDirection falls back to half-plane when the cone is empty', () => {
  const pos = [
    { id: 'me', x: 100, y: 100 },
    { id: 'up-right', x: 300, y: 40 },   // rightward but outside the ±45° cone? dx=200, dy=-60 -> inside cone actually
    { id: 'shallow', x: 130, y: 20 },    // upward-ish, outside 'right' cone
  ]
  assert.equal(nearestInDirection(pos, 'me', 'up'), 'shallow')
})

test('nearestInDirection: unknown fromId -> null', () => {
  assert.equal(nearestInDirection([], 'ghost', 'left'), null)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `graph.js` missing.

- [ ] **Step 3: Implement the pure half of `graph.js`**

`graph.js`:
```js
// Lineage renderer. Pure layout math up top (unit tested); the D3
// force/SVG renderer is appended below and exercised via Playwright.

export const GUTTER_W = 84
export const PAD = 24

export function datedDomain(nodes) {
  let min = Infinity, max = -Infinity
  for (const n of nodes) {
    if (n.year != null) { min = Math.min(min, n.year); max = Math.max(max, n.year) }
  }
  if (min === Infinity) return null
  if (min === max) return [min - 1, max + 1]
  return [min, max]
}

export function solveDomain({ minYear, maxYear, selYear, prevFrac }) {
  const EPS = 0.02
  const f = Math.min(1 - EPS, Math.max(EPS, prevFrac))
  const span = Math.max(
    (selYear - minYear) / f,
    (maxYear - selYear) / (1 - f),
    1,
  )
  const a = selYear - f * span
  return [a, a + span]
}

export function makeXScale(domain, width) {
  const x0 = PAD, x1 = width - GUTTER_W - PAD
  const [a, b] = domain
  return year => x0 + ((year - a) / (b - a)) * (x1 - x0)
}

export function gutterX(width) {
  return width - GUTTER_W / 2
}

export function nodeRadius(citationCount) {
  return 3 + 3 * Math.min(1, Math.log10(1 + (citationCount ?? 0)) / 4)
}

export function nearestInDirection(positions, fromId, dir) {
  const from = positions.find(p => p.id === fromId)
  if (!from) return null
  const [vx, vy] = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir]
  const pick = (predicate) => {
    let best = null, bestD = Infinity
    for (const p of positions) {
      if (p.id === fromId) continue
      const dx = p.x - from.x, dy = p.y - from.y
      const along = dx * vx + dy * vy
      if (along <= 0) continue
      const ortho = Math.abs(dx * vy) + Math.abs(dy * vx)
      if (!predicate(along, ortho)) continue
      const d = dx * dx + dy * dy
      if (d < bestD) { bestD = d; best = p.id }
    }
    return best
  }
  return pick((along, ortho) => ortho <= along) ?? pick(() => true)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add graph.js tests/unit/layout.test.mjs
git commit -m "feat: layout math — year domain solver, scales, spatial keyboard adjacency"
```

---

### Task 7: Static shell — index.html, lineage.css, fonts, empty state

**Files:**
- Create: `index.html`, `lineage.css`, `fonts/hanken-grotesk.woff2`, `fonts/bricolage-grotesque.woff2`, `tests/e2e/fixtures.mjs`, `tests/e2e/helpers.mjs`, `tests/e2e/shell.spec.mjs`

**Interfaces:**
- Produces: the DOM contract every later task relies on — element ids `#search`, `#results`, `#canvas`, `#inspector`, `#status`, `#empty`, `#retry`; classes `.example-query`; `data-testid` attributes as written below. Also the e2e stubbing helpers `stubApi(page)` and fixture exports.

- [ ] **Step 1: Copy fonts**

Run: `mkdir -p fonts && cp ../pvjohnston.com/fonts/hanken-grotesk.woff2 ../pvjohnston.com/fonts/bricolage-grotesque.woff2 fonts/`
Expected: both files present.

- [ ] **Step 2: Write `index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lineage — a citation explorer</title>
  <meta name="description" content="Trace the ancestry and descent of scientific ideas. Search a paper, then expand what it cites and who cites it, laid out along a timeline.">
  <link rel="stylesheet" href="lineage.css">
</head>
<body>
  <header>
    <span class="wordmark">Lineage</span>
    <form id="search-form" role="search">
      <input id="search" type="search" placeholder="Search for a paper…"
             aria-label="Search for a paper" autocomplete="off">
    </form>
    <ul id="results" role="listbox" aria-label="Search results" hidden></ul>
  </header>

  <main>
    <svg id="canvas" role="application" aria-label="Citation graph. Use arrow keys to move between papers, Enter to select."></svg>
    <div id="empty">
      <p>Search for a paper, then click nodes to trace what it cites and who cites it.</p>
      <p class="convention">Edges encode citation, from the citing paper to the cited paper —
        usually, but not always, newer to older. Read the graph left-to-right as
        intellectual influence.</p>
      <p class="examples">Try:
        <button type="button" class="example-query">Attention Is All You Need</button>
        <button type="button" class="example-query">Hartree 1928</button>
        <button type="button" class="example-query">CRISPR-Cas9</button>
      </p>
    </div>
    <aside id="inspector" hidden aria-label="Paper details">
      <button id="inspector-close" type="button" aria-label="Close details">×</button>
      <h2 data-testid="insp-title"></h2>
      <p class="meta" data-testid="insp-meta"></p>
      <p class="counts mono" data-testid="insp-counts"></p>
      <p class="abstract" data-testid="insp-abstract"></p>
      <p class="links" data-testid="insp-links"></p>
      <div class="actions">
        <button type="button" data-testid="expand-references">show references</button>
        <button type="button" data-testid="expand-citations">show citations</button>
        <button type="button" data-testid="load-more" hidden>load more</button>
      </div>
      <div class="relations">
        <h3>Cites (shown)</h3><ul data-testid="rel-cites"></ul>
        <h3>Cited by (shown)</h3><ul data-testid="rel-citedby"></ul>
      </div>
    </aside>
  </main>

  <footer>
    <span id="status" role="status" aria-live="polite">ready</span>
    <button id="retry" type="button" hidden>retry</button>
  </footer>

  <script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"
          integrity="sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i"
          crossorigin="anonymous"></script>
  <script type="module">
    import { init } from './main.js'
    init()
  </script>
</body>
</html>
```

- [ ] **Step 3: Write `lineage.css`** (complete theme; ink-on-paper per spec)

```css
/* Lineage — ink on paper. Monochrome except the single indigo accent
   (#465C9B) reserved for the selected node, its edges, and hyperlinks.
   Square corners, hairline borders, no shadows/gradients/pills. */

@font-face {
  font-family: 'Hanken Grotesk';
  src: url('fonts/hanken-grotesk.woff2') format('woff2');
  font-weight: 100 900; font-display: swap;
}
@font-face {
  font-family: 'Bricolage Grotesque';
  src: url('fonts/bricolage-grotesque.woff2') format('woff2');
  font-weight: 200 800; font-display: swap;
}

:root {
  --ink: #16161a;
  --ink-soft: #55555c;
  --ink-faint: #9a9aa2;
  --hairline: #d8d8dc;
  --paper: #ffffff;
  --accent: #465C9B;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans: 'Hanken Grotesk', system-ui, -apple-system, sans-serif;
}

* { box-sizing: border-box; border-radius: 0; }
html, body { margin: 0; height: 100%; }
body {
  font-family: var(--sans); color: var(--ink); background: var(--paper);
  display: flex; flex-direction: column; overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
button {
  font: inherit; color: var(--ink); background: var(--paper);
  border: 1px solid var(--ink); padding: 4px 10px; cursor: pointer;
}
button:hover { background: var(--ink); color: var(--paper); }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.mono { font-family: var(--mono); }

/* header */
header {
  flex: none; display: flex; align-items: center; gap: 20px;
  padding: 10px 20px; border-bottom: 1px solid var(--ink); position: relative;
}
.wordmark { font-family: 'Bricolage Grotesque', var(--sans); font-weight: 700; font-size: 20px; }
#search-form { flex: 1; max-width: 480px; }
#search {
  width: 100%; font: inherit; color: var(--ink); background: var(--paper);
  border: 1px solid var(--ink); padding: 6px 10px;
}
#results {
  position: absolute; top: 100%; left: 190px; z-index: 10;
  width: min(480px, 80vw); margin: 0; padding: 0; list-style: none;
  background: var(--paper); border: 1px solid var(--ink); border-top: 0;
  max-height: 50vh; overflow-y: auto;
}
#results li { padding: 8px 10px; border-bottom: 1px solid var(--hairline); cursor: pointer; }
#results li:last-child { border-bottom: 0; }
#results li:hover, #results li[aria-selected="true"] { background: var(--ink); color: var(--paper); }
#results .yr { font-family: var(--mono); font-size: 12px; color: var(--ink-faint); }
#results li:hover .yr, #results li[aria-selected="true"] .yr { color: var(--paper); }

/* main area */
main { flex: 1; display: flex; min-height: 0; position: relative; }
#canvas { flex: 1; min-width: 0; display: block; }

/* graph marks (SVG) */
.edge { stroke: var(--ink-soft); stroke-width: 0.75; fill: none; }
.edge.dim { stroke: var(--hairline); }
.edge.selected-edge { stroke: var(--accent); }
.node circle.dot { fill: var(--ink); stroke: none; }
.node.undated circle.dot { fill: var(--paper); stroke: var(--ink); stroke-width: 1; }
.node circle.hit { fill: transparent; cursor: pointer; }
.node.selected circle.dot { fill: var(--accent); }
.node.selected circle.ring, .node:focus-visible circle.ring {
  fill: none; stroke: var(--ink); stroke-width: 1; visibility: visible;
}
.node circle.ring { visibility: hidden; }
.node.selected circle.ring { stroke: var(--accent); }
.node text {
  font-family: var(--mono); font-size: 11px; fill: var(--ink);
  paint-order: stroke; stroke: var(--paper); stroke-width: 3px;
  visibility: hidden; pointer-events: none;
}
.node:hover text, .node.selected text, .node.pinned text, .node:focus-visible text { visibility: visible; }
.axis text { font-family: var(--mono); font-size: 11px; fill: var(--ink-soft); }
.axis line, .axis path { stroke: var(--ink-soft); }
.gutter-rule { stroke: var(--hairline); stroke-dasharray: 3 3; }
.gutter-label { font-family: var(--mono); font-size: 10px; fill: var(--ink-faint); }

/* empty state */
#empty {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px; text-align: center;
  padding: 24px; pointer-events: none;
}
#empty p { max-width: 52ch; margin: 4px 0; }
#empty .convention { color: var(--ink-soft); font-size: 14px; }
#empty .examples { pointer-events: auto; }
.example-query { margin: 0 4px; }

/* inspector: side column >=720px, bottom sheet below */
#inspector {
  flex: none; width: 340px; border-left: 1px solid var(--ink);
  padding: 16px; overflow-y: auto; position: relative; background: var(--paper);
}
#inspector h2 { font-size: 16px; margin: 0 24px 6px 0; }
#inspector .meta { color: var(--ink-soft); margin: 0 0 4px; }
#inspector .counts { font-size: 12px; color: var(--ink-soft); }
#inspector .abstract { font-size: 14px; }
#inspector .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
#inspector .relations h3 {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  border-top: 1px solid var(--hairline); padding-top: 10px; margin: 14px 0 4px;
}
#inspector .relations ul { margin: 0; padding-left: 18px; font-size: 13px; }
#inspector-close { position: absolute; top: 8px; right: 8px; border-color: var(--hairline); }
@media (max-width: 719px) {
  #inspector {
    position: absolute; left: 0; right: 0; bottom: 0; width: auto;
    max-height: 55%; border-left: 0; border-top: 1px solid var(--ink);
  }
}

/* footer */
footer {
  flex: none; display: flex; align-items: center; gap: 12px;
  border-top: 1px solid var(--ink); padding: 6px 20px;
  font-family: var(--mono); font-size: 12px; color: var(--ink-soft);
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
```

- [ ] **Step 4: Write e2e fixtures and helpers**

`tests/e2e/fixtures.mjs`:
```js
export const paper = (id, year, cc, title, rc = 3) => ({
  paperId: id, title, year,
  authors: [{ name: `Author ${id}` }], venue: 'Test Venue',
  citationCount: cc, referenceCount: rc,
  externalIds: { DOI: `10.1/${id}` },
})

export const SEED = paper('seed1', 1953, 30, 'Molecular Structure of Nucleic Acids', 3)
export const REFS = [
  paper('r1', 1949, 900, 'Reference One'),
  paper('r2', 1950, 20, 'Reference Two'),
  paper('r3', null, 5, 'Undated Reference'),
]
export const CITS = Array.from({ length: 30 }, (_, i) =>
  paper(`c${i}`, 1960 + (i % 40), 1000 - i, `Citation ${i}`))

export const routes = {
  search: { total: 1, offset: 0, data: [SEED] },
  paper: { ...SEED, abstract: 'A structure for deoxyribose nucleic acid.' },
  references: { offset: 0, data: REFS.map(p => ({ citedPaper: p })) },          // no next, counts agree
  citations: { offset: 0, data: CITS.map(p => ({ citingPaper: p })) },          // no next; 30 fetched vs 30 reported
}
```

`tests/e2e/helpers.mjs`:
```js
export async function stubD3(page) {
  // Serves the exact bytes of the pinned CDN file, so the SRI integrity
  // attribute on the script tag still validates against the stub.
  await page.route('https://cdn.jsdelivr.net/npm/d3@7.9.0/**', route =>
    route.fulfill({ path: 'tests/fixtures/d3.v7.min.js', contentType: 'text/javascript' }))
}

// overrides: {pathSuffix: responseObjectOrFn} matched against url.pathname
export async function stubApi(page, fixtures, overrides = {}) {
  await stubD3(page)
  await page.route('https://api.semanticscholar.org/**', async route => {
    const url = new URL(route.request().url())
    const p = url.pathname
    for (const [suffix, resp] of Object.entries(overrides)) {
      if (p.endsWith(suffix)) {
        const r = typeof resp === 'function' ? resp(url) : resp
        return route.fulfill({ status: r.status ?? 200, headers: r.headers ?? {}, json: r.json ?? r })
      }
    }
    if (p.endsWith('/paper/search')) return route.fulfill({ json: fixtures.routes.search })
    if (p.endsWith('/references')) return route.fulfill({ json: fixtures.routes.references })
    if (p.endsWith('/citations')) return route.fulfill({ json: fixtures.routes.citations })
    if (/\/paper\/[^/]+$/.test(p)) return route.fulfill({ json: fixtures.routes.paper })
    return route.fulfill({ status: 404, json: { error: 'not stubbed: ' + p } })
  })
}
```

- [ ] **Step 5: Write the failing shell e2e test**

`tests/e2e/shell.spec.mjs`:
```js
import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

test('shell renders: wordmark, search, empty state with convention text', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await expect(page.locator('.wordmark')).toHaveText('Lineage')
  await expect(page.locator('#search')).toBeVisible()
  await expect(page.locator('#empty')).toContainText('Search for a paper')
  await expect(page.locator('#empty .convention')).toContainText('from the citing paper to the cited paper')
  await expect(page.locator('.example-query')).toHaveCount(3)
  await expect(page.locator('#status')).toHaveText('ready')
})
```

- [ ] **Step 6: Run to verify failure, then add the minimal `init()`**

Run: `npm run test:e2e`
Expected: FAIL — `init` is not exported by `main.js`.

Append to `main.js` the minimal controller stub (grown in Task 8):
```js
// ---------------------------------------------------------------- DOM layer
export function init() {
  // Populated in later tasks; presence makes the shell load cleanly.
}
```

- [ ] **Step 7: Run to verify pass**

Run: `npm run test:e2e`
Expected: PASS (1 test).

- [ ] **Step 8: Commit**

```bash
git add index.html lineage.css fonts/ main.js tests/e2e/
git commit -m "feat: static shell — ink-on-paper theme, empty state, e2e stubbing harness"
```

---

### Task 8: Search flow — input → results → seed node on canvas

**Files:**
- Modify: `main.js` (replace the `init()` stub with the real controller)
- Test: `tests/e2e/search.spec.mjs`

**Interfaces:**
- Consumes: `S2Client` (Task 4), model (Task 5), `createGraph` (Task 9 — this task lands first with a placeholder call guarded by `window.d3`, see note in Step 2).
- Produces: `init({clientOpts} = {})`; module-level `state`; `select(paperId)`, `expand(node, direction)`, `setStatus(text)` used by Tasks 10–13. URL test hook: `?cap=N` overrides the node cap.

**Note on ordering:** Tasks 8 and 9 are one review unit in spirit — Task 8 wires search/state/status and calls `graph.update()`; Task 9 supplies the real renderer. To keep each task green, Task 8 ships a minimal inline renderer (plain circles, no forces) that Task 9 replaces. The e2e assertions in this task only rely on the minimal renderer.

- [ ] **Step 1: Write the failing e2e test**

`tests/e2e/search.spec.mjs`:
```js
import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

test('search shows results; picking one seeds the graph and hides empty state', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  const item = page.locator('#results li').first()
  await expect(item).toContainText('Molecular Structure of Nucleic Acids')
  await item.click()
  await expect(page.locator('#results')).toBeHidden()
  await expect(page.locator('#empty')).toBeHidden()
  await expect(page.locator('.node')).toHaveCount(1)
  await expect(page.locator('#inspector')).toBeVisible()
  await expect(page.getByTestId('insp-title')).toContainText('Molecular Structure')
})

test('example query buttons run a search', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await page.locator('.example-query').first().click()
  await expect(page.locator('#results li').first()).toBeVisible()
})

test('empty search results get a plain message', async ({ page }) => {
  await stubApi(page, fixtures, { '/paper/search': { json: { total: 0, offset: 0, data: [] } } })
  await page.goto('/')
  await page.fill('#search', 'zzz')
  await page.press('#search', 'Enter')
  await expect(page.locator('#status')).toContainText('no papers found')
})
```

- [ ] **Step 2: Replace the `init()` stub in `main.js` with the controller**

```js
// ---------------------------------------------------------------- DOM layer
import { S2Client, S2Error, StaleError } from './s2.js'
import { createGraph } from './graph.js'

let state, client, graph, els

const $ = id => document.getElementById(id)

export function setStatus(text) { els.status.textContent = text }

function nodeCap() {
  const q = new URLSearchParams(location.search).get('cap')
  return q ? Number(q) : NODE_CAP
}

export function init(opts = {}) {
  state = createState()
  els = {
    form: $('search-form'), search: $('search'), results: $('results'),
    canvas: $('canvas'), empty: $('empty'), inspector: $('inspector'),
    status: $('status'), retry: $('retry'), close: $('inspector-close'),
  }
  client = new S2Client({
    onStatus: s => {
      if (s.state === 'loading') setStatus('fetching…')
      else if (s.state === 'backoff') setStatus(s.message)
      else if (s.state === 'note') setStatus(s.message)
      else if (s.state === 'error') showError(s)
      else setStatus('ready')
    },
    ...opts.clientOpts,
  })
  graph = createGraph(els.canvas, {
    onSelect: select,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  })

  els.form.addEventListener('submit', e => { e.preventDefault(); runSearch(els.search.value) })
  document.querySelectorAll('.example-query').forEach(b =>
    b.addEventListener('click', () => { els.search.value = b.textContent; runSearch(b.textContent) }))
  els.close.addEventListener('click', () => { els.inspector.hidden = true })
  wireInspector()   // defined in Task 10; a no-op function until then
}

async function runSearch(query) {
  if (!query.trim()) return
  let papers
  try { papers = await client.search(query.trim()) }
  catch { return }   // client.onStatus already surfaced the error
  if (papers.length === 0) { setStatus('no papers found for that search'); return }
  els.results.innerHTML = ''
  els.results.hidden = false
  papers.forEach((p, i) => {
    const li = document.createElement('li')
    li.setAttribute('role', 'option')
    li.tabIndex = -1
    li.innerHTML = `<span class="yr">${p.year ?? '—'}</span> ${escapeHtml(p.title)}`
    li.addEventListener('click', () => seed(p))
    li.addEventListener('keydown', e => { if (e.key === 'Enter') seed(p) })
    els.results.appendChild(li)
    if (i === 0) li.focus()
  })
  wireResultArrows()
}

function wireResultArrows() {
  els.results.querySelectorAll('li').forEach((li, i, all) => {
    li.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' && all[i + 1]) { e.preventDefault(); all[i + 1].focus() }
      if (e.key === 'ArrowUp' && all[i - 1]) { e.preventDefault(); all[i - 1].focus() }
      all.forEach(x => x.removeAttribute('aria-selected'))
      document.activeElement?.setAttribute?.('aria-selected', 'true')
    })
  })
}

function seed(paper) {
  els.results.hidden = true
  els.empty.hidden = true
  const node = addPaper(state, paper)
  state.seedId = paper.paperId
  select(paper.paperId)
  render()
}

export function select(paperId) {
  state.selected = paperId
  const node = state.nodes.get(paperId)
  showInspector(node)   // defined in Task 10; minimal version below
  render()
}

function render() {
  graph.update({
    nodes: [...state.nodes.values()],
    edges: [...state.edges.values()],
    selectedId: state.selected,
    cap: nodeCap(),
  })
}

function showError(s) {
  setStatus(s.message || 'request failed')
  els.retry.hidden = !s.retryable
}

// Minimal inspector until Task 10 replaces these two:
function wireInspector() {}
function showInspector(node) {
  els.inspector.hidden = false
  els.inspector.querySelector('[data-testid="insp-title"]').textContent = node.title
  els.inspector.querySelector('[data-testid="insp-meta"]').textContent =
    [node.authors.join(', '), node.year ?? 'undated', node.venue].filter(Boolean).join(' · ')
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
```

And append a **temporary minimal renderer** at the bottom of `graph.js` (replaced wholesale in Task 9):
```js
export function createGraph(svg, { onSelect } = {}) {
  return {
    update({ nodes, selectedId }) {
      svg.innerHTML = ''
      const w = svg.clientWidth || 800, h = svg.clientHeight || 500
      const domain = datedDomain(nodes) || [1900, 2030]
      const x = makeXScale(domain, w)
      nodes.forEach((n, i) => {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
        g.setAttribute('class', 'node' + (n.paperId === selectedId ? ' selected' : ''))
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
        c.setAttribute('class', 'dot')
        c.setAttribute('cx', n.year != null ? x(n.year) : gutterX(w))
        c.setAttribute('cy', h / 2 + i * 14)
        c.setAttribute('r', nodeRadius(n.citationCount))
        g.appendChild(c)
        g.addEventListener('click', () => onSelect(n.paperId))
        svg.appendChild(g)
      })
    },
    focusNode() {},
  }
}
```

- [ ] **Step 3: Run to verify pass**

Run: `npm run test:e2e`
Expected: all e2e PASS (shell + search). Also run `npm test` — unit suite still green (the DOM layer imports guard nothing at module top level besides other modules; `init` is only called from the page).

- [ ] **Step 4: Commit**

```bash
git add main.js graph.js tests/e2e/search.spec.mjs
git commit -m "feat: search flow — results list, seeding, selection, status line"
```

---

### Task 9: graph.js — real D3 renderer (forces, axis, gutter, ticks, labels)

**Files:**
- Modify: `graph.js` (replace the Task 8 minimal `createGraph` entirely)
- Test: `tests/e2e/render.spec.mjs`

**Interfaces:**
- Consumes: window-global `d3` (CDN script), pure helpers from Task 6.
- Produces: `createGraph(svgEl, {onSelect, reducedMotion}) -> {update({nodes, edges, selectedId, cap}), focusNode(id), positions() -> [{id,x,y}]}`. `positions()` feeds keyboard nav (Task 12).

- [ ] **Step 1: Write the failing e2e test**

`tests/e2e/render.spec.mjs`:
```js
import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

async function seedAndExpandRefs(page) {
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-references').click()
  await expect(page.locator('.node')).toHaveCount(4)   // seed + 3 refs
}

test('year axis, dated ordering, undated gutter, hairline edges', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedAndExpandRefs(page)
  await expect(page.locator('.axis')).toBeVisible()
  await expect(page.locator('.edge')).toHaveCount(3)
  // r1 (1949) must sit left of the seed (1953)
  const cx = async id => Number(await page.locator(`.node[data-id="${id}"] circle.dot`).getAttribute('cx'))
  expect(await cx('r1')).toBeLessThan(await cx('seed1'))
  // undated r3 sits in the gutter (right of every dated node)
  expect(await cx('r3')).toBeGreaterThan(await cx('seed1'))
  await expect(page.locator('.node[data-id="r3"]')).toHaveClass(/undated/)
  await expect(page.locator('.gutter-label')).toHaveText('undated')
})

test('selection paints accent classes and cited-end ticks appear on selection', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedAndExpandRefs(page)
  await page.locator('.node[data-id="seed1"] circle.hit').click()
  await expect(page.locator('.node[data-id="seed1"]')).toHaveClass(/selected/)
  await expect(page.locator('.edge.selected-edge')).toHaveCount(3)
  // selected edges carry the cited-end marker
  const marked = page.locator('.edge.selected-edge').first()
  await expect(marked).toHaveAttribute('marker-end', 'url(#tick)')
})

test('hit areas are ~24px even though dots are small', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedAndExpandRefs(page)
  const r = await page.locator('.node[data-id="seed1"] circle.hit').getAttribute('r')
  expect(Number(r)).toBeGreaterThanOrEqual(12)
})
```

- [ ] **Step 2: Replace `createGraph` in `graph.js` with the D3 renderer**

```js
export function createGraph(svg, { onSelect = () => {}, reducedMotion = false } = {}) {
  const d3 = window.d3
  const sel = d3.select(svg)
  sel.selectAll('*').remove()

  const defs = sel.append('defs')
  defs.append('marker')
    .attr('id', 'tick').attr('viewBox', '0 0 8 8')
    .attr('refX', 7, ).attr('refY', 4)
    .attr('markerWidth', 8).attr('markerHeight', 8)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M1,1 L7,4').attr('stroke', 'currentColor').attr('stroke-width', 1)

  const edgeLayer = sel.append('g')
  const nodeLayer = sel.append('g')
  const axisLayer = sel.append('g').attr('class', 'axis')
  const gutterLayer = sel.append('g')

  let sim = null
  let nodesById = new Map()
  let prevDomain = null

  function dims() {
    return { w: svg.clientWidth || 800, h: svg.clientHeight || 500 }
  }

  function update({ nodes, edges, selectedId }) {
    const { w, h } = dims()
    const dated = datedDomain(nodes)

    // domain: minimize displacement of the selected node (spec rescale rule)
    let domain = dated || [1900, 2030]
    const selNode = nodesById.get(selectedId)
    if (dated && prevDomain && selNode && selNode.year != null && selNode.x != null) {
      const x0 = PAD, x1 = w - GUTTER_W - PAD
      const prevFrac = (selNode.x - x0) / (x1 - x0)
      domain = solveDomain({ minYear: dated[0], maxYear: dated[1], selYear: selNode.year, prevFrac })
    }
    const widened = prevDomain && (domain[0] < prevDomain[0] || domain[1] > prevDomain[1])
    prevDomain = domain
    const x = makeXScale(domain, w)

    // sim datums: reuse existing objects so y positions persist across updates
    const datums = nodes.map(n => {
      let d = nodesById.get(n.paperId)
      if (!d) { d = { id: n.paperId, y: h / 2 + (Math.random() - 0.5) * 40 }; nodesById.set(n.paperId, d) }
      d.node = n
      d.year = n.year
      d.r = nodeRadius(n.citationCount)
      d.fx = n.year != null ? x(n.year) : gutterX(w)
      d.x = d.fx
      return d
    })
    const links = edges
      .filter(e => nodesById.has(e.citing) && nodesById.has(e.cited))
      .map(e => ({ source: e.citing, target: e.cited }))

    // axis + gutter
    const axisScale = d3.scaleLinear().domain(domain).range([PAD, w - GUTTER_W - PAD])
    axisLayer.attr('transform', `translate(0,${h - 28})`)
      .call(d3.axisBottom(axisScale).ticks(Math.max(3, Math.floor(w / 110))).tickFormat(d3.format('d')))
    gutterLayer.selectAll('*').remove()
    gutterLayer.append('line').attr('class', 'gutter-rule')
      .attr('x1', w - GUTTER_W).attr('x2', w - GUTTER_W).attr('y1', 12).attr('y2', h - 34)
    gutterLayer.append('text').attr('class', 'gutter-label')
      .attr('x', gutterX(w)).attr('y', h - 36).attr('text-anchor', 'middle').text('undated')

    // edges (citing → cited; marker-end = cited-end tick)
    const edgeSel = edgeLayer.selectAll('line.edge')
      .data(links, d => `${d.source.id ?? d.source}→${d.target.id ?? d.target}`)
    edgeSel.exit().remove()
    const edgeEnter = edgeSel.enter().append('line').attr('class', 'edge')
    const allEdges = edgeEnter.merge(edgeSel)
      .classed('selected-edge', d =>
        (d.source.id ?? d.source) === selectedId || (d.target.id ?? d.target) === selectedId)
      .attr('marker-end', d =>
        ((d.source.id ?? d.source) === selectedId || (d.target.id ?? d.target) === selectedId)
          ? 'url(#tick)' : null)

    // nodes
    const nodeSel = nodeLayer.selectAll('g.node').data(datums, d => d.id)
    nodeSel.exit().remove()
    const nodeEnter = nodeSel.enter().append('g')
      .attr('class', 'node')
      .attr('data-id', d => d.id)
      .attr('tabindex', -1)
      .attr('role', 'button')
    nodeEnter.append('circle').attr('class', 'hit').attr('r', 12)
    nodeEnter.append('circle').attr('class', 'dot')
    nodeEnter.append('circle').attr('class', 'ring')
    nodeEnter.append('text').attr('dy', -10)
    nodeEnter.on('click', (event, d) => onSelect(d.id))
      .on('keydown', (event, d) => { if (event.key === 'Enter') onSelect(d.id) })

    const allNodes = nodeEnter.merge(nodeSel)
      .classed('selected', d => d.id === selectedId)
      .classed('undated', d => d.year == null)
      .classed('pinned', d => d.id === selectedId)
    allNodes.select('circle.dot').attr('r', d => d.r)
    allNodes.select('circle.ring').attr('r', d => d.r + 4)
    allNodes.select('text')
      .text(d => `${(d.node.authors[0] || '').split(' ').pop() || '—'} ${d.year ?? '—'}`)
    allNodes.attr('aria-label', d =>
      `${d.node.authors[0] || 'Unknown'}, ${d.year ?? 'undated'}: ${d.node.title}`)

    function place() {
      allNodes.attr('transform', d => `translate(${d.fx},${d.y})`)
      allEdges
        .attr('x1', d => d.source.fx).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.fx).attr('y2', d => d.target.y)
    }

    if (sim) sim.stop()
    sim = d3.forceSimulation(datums)
      .force('collide', d3.forceCollide(d => d.r + 8))
      .force('y', d3.forceY(h / 2 - 14).strength(0.05))
      .force('link', d3.forceLink(links).id(d => d.id).strength(0))
      .on('tick', place)
    if (reducedMotion) { sim.stop(); sim.tick(120); place() }

    return { widened }
  }

  return {
    update,
    focusNode(id) { nodeLayer.select(`g.node[data-id="${CSS.escape(id)}"]`).node()?.focus() },
    positions() {
      return [...nodesById.values()].map(d => ({ id: d.id, x: d.fx ?? d.x, y: d.y }))
    },
  }
}
```

- [ ] **Step 3: Wire the "timeline widened" note in `main.js`'s `render()`**

Replace `render()`:
```js
function render() {
  const out = graph.update({
    nodes: [...state.nodes.values()],
    edges: [...state.edges.values()],
    selectedId: state.selected,
    cap: nodeCap(),
  })
  if (out?.widened) setStatus('timeline widened')
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:e2e`
Expected: render.spec PASSes and earlier specs stay green. (The render spec needs `expand-references` to work — that lands in Task 10. **Run only shell/search specs now** (`npx playwright test shell search`), and re-run the full suite at the end of Task 10; note this in the Task 10 verification.)

- [ ] **Step 5: Run unit suite**

Run: `npm test`
Expected: PASS (pure helpers untouched).

- [ ] **Step 6: Commit**

```bash
git add graph.js main.js tests/e2e/render.spec.mjs
git commit -m "feat: D3 renderer — year-pinned forces, axis, gutter, ticks, labels"
```

---

### Task 10: Expand flow + inspector + disclosure + load-more

**Files:**
- Modify: `main.js` (replace `wireInspector`/`showInspector` minimal versions; add `expand`)
- Test: `tests/e2e/expand.spec.mjs`

**Interfaces:**
- Consumes: `client.connections` (Task 4), `completeFetch`/`admit`/`disclosure` (Task 5), renderer (Task 9).
- Produces: `expand(node, direction)` — the full spec flow (dedupe, staleness, pool, load-more).

- [ ] **Step 1: Write the failing e2e test**

`tests/e2e/expand.spec.mjs`:
```js
import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

async function seedPage(page) {
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
}

test('expand references: nodes, edges, tier-1 disclosure', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedPage(page)
  await page.getByTestId('expand-references').click()
  await expect(page.locator('.node')).toHaveCount(4)
  // REFS has 3 papers and SEED.referenceCount is 3 -> exhausted, counts agree
  await expect(page.locator('#status')).toHaveText('showing top 3 of 3 references')
})

test('expand citations: batch of 25 from a 30-pool, load-more without network', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedPage(page)
  let citationCalls = 0
  page.on('request', r => { if (r.url().includes('/citations')) citationCalls++ })
  await page.getByTestId('expand-citations').click()
  await expect(page.locator('.node')).toHaveCount(26)   // seed + 25
  await expect(page.locator('#status')).toHaveText('showing top 25 of 30 citations')
  await expect(page.getByTestId('load-more')).toBeVisible()
  await page.getByTestId('load-more').click()
  await expect(page.locator('.node')).toHaveCount(31)   // remaining 5 from pool
  expect(citationCalls).toBe(1)                          // pool reveal = no second request
})

test('double-click on expand fires one request (loading dedupe)', async ({ page }) => {
  await stubApi(page, fixtures, {
    '/citations': () => ({ json: fixtures.routes.citations }),
  })
  await seedPage(page)
  let calls = 0
  page.on('request', r => { if (r.url().includes('/citations')) calls++ })
  await page.getByTestId('expand-citations').click({ clickCount: 2, delay: 30 })
  await expect(page.locator('.node')).toHaveCount(26)
  expect(calls).toBe(1)
})

test('inspector shows relationships lists and abstract', async ({ page }) => {
  await stubApi(page, fixtures)
  await seedPage(page)
  await page.getByTestId('expand-references').click()
  await page.locator('.node[data-id="seed1"] circle.hit').click()
  await expect(page.getByTestId('insp-abstract')).toContainText('deoxyribose')
  await expect(page.getByTestId('rel-cites').locator('li')).toHaveCount(3)
  await expect(page.getByTestId('insp-links')).toContainText('DOI')
})

test('node cap: partial admission with disclosure (cap=10 test hook)', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/?cap=10')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-citations').click()
  await expect(page.locator('.node')).toHaveCount(10)
  await expect(page.locator('#status')).toContainText('node cap reached — added 9 of')
})
```

- [ ] **Step 2: Implement in `main.js`** — replace `wireInspector` and `showInspector`, add `expand`:

```js
function wireInspector() {
  els.inspector.querySelector('[data-testid="expand-references"]')
    .addEventListener('click', () => expandSelected('references'))
  els.inspector.querySelector('[data-testid="expand-citations"]')
    .addEventListener('click', () => expandSelected('citations'))
  els.inspector.querySelector('[data-testid="load-more"]')
    .addEventListener('click', () => expandSelected(lastDirection))
}

let lastDirection = 'citations'

function expandSelected(direction) {
  const node = state.nodes.get(state.selected)
  if (node) expand(node, direction)
}

export async function expand(node, direction) {
  lastDirection = direction
  const exp = node.expansion[direction]
  if (exp.status === 'loading') return                    // concurrent-click dedupe
  if (exp.pool.length === 0 && !exp.exhausted) {
    exp.status = 'loading'
    const gen = state.gen
    let page
    try {
      page = await client.connections(node.paperId, direction, exp.nextOffset ?? 0, () => gen !== state.gen)
    } catch (err) {
      if (err instanceof StaleError || gen !== state.gen) return
      exp.status = 'error'
      if (err instanceof S2Error && err.retryable) {
        els.retry.hidden = false
        els.retry.onclick = () => { els.retry.hidden = true; exp.status = 'idle'; expand(node, direction) }
      }
      return
    }
    if (gen !== state.gen) return                          // stale generation → discard
    completeFetch(exp, page)
  }
  if (exp.pool.length === 0 && exp.exhausted && exp.displayedCount === 0) {
    setStatus(direction === 'citations' ? 'no citations recorded' : 'no references recorded')
    return
  }
  const res = admit(state, node, direction, { cap: nodeCap() })
  let msg = disclosure(exp, direction)
  if (res.capped) msg += ` — node cap reached — added ${res.admitted.length} of ${res.requested}`
  setStatus(msg)
  els.inspector.querySelector('[data-testid="load-more"]').hidden =
    exp.pool.length === 0 && exp.exhausted
  showInspector(node)
  render()
}

function showInspector(node) {
  els.inspector.hidden = false
  const q = t => els.inspector.querySelector(`[data-testid="${t}"]`)
  q('insp-title').textContent = node.title
  q('insp-meta').textContent =
    [node.authors.join(', '), node.year ?? 'undated', node.venue].filter(Boolean).join(' · ')
  q('insp-counts').textContent =
    `${node.citationCount.toLocaleString('en-US')} citations · ${node.referenceCount.toLocaleString('en-US')} references`
  q('insp-abstract').textContent = node.abstract ?? ''
  q('insp-links').innerHTML = [
    node.doi ? `<a href="https://doi.org/${escapeHtml(node.doi)}" target="_blank" rel="noopener">DOI</a>` : '',
    `<a href="https://www.semanticscholar.org/paper/${escapeHtml(node.paperId)}" target="_blank" rel="noopener">Semantic Scholar</a>`,
  ].filter(Boolean).join(' · ')
  // textual relationships (the non-visual equivalent of the edges)
  const cites = [], citedBy = []
  for (const e of state.edges.values()) {
    if (e.citing === node.paperId) cites.push(state.nodes.get(e.cited))
    if (e.cited === node.paperId) citedBy.push(state.nodes.get(e.citing))
  }
  const fill = (t, list) => {
    const ul = q(t); ul.innerHTML = ''
    list.filter(Boolean).forEach(n => {
      const li = document.createElement('li')
      li.textContent = `${n.title} (${n.year ?? 'undated'})`
      ul.appendChild(li)
    })
  }
  fill('rel-cites', cites)
  fill('rel-citedby', citedBy)
  // fetch abstract lazily if missing
  if (node.abstract == null && !node._abstractRequested) {
    node._abstractRequested = true
    client.paper(node.paperId).then(full => {
      if (full?.abstract && state.nodes.get(node.paperId) === node) {
        node.abstract = full.abstract
        if (state.selected === node.paperId) q('insp-abstract').textContent = full.abstract
      }
    }).catch(() => {})
  }
}
```

- [ ] **Step 3: Run the FULL e2e suite (including Task 9's deferred render.spec)**

Run: `npm run test:e2e`
Expected: all specs PASS — shell, search, render, expand.

- [ ] **Step 4: Run unit suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add main.js tests/e2e/expand.spec.mjs
git commit -m "feat: expand flow — pooled ranking, load-more, disclosure, inspector"
```

---

### Task 11: Reset flow + stale-generation discard

**Files:**
- Modify: `main.js`, `index.html`
- Test: `tests/e2e/reset.spec.mjs`

**Interfaces:**
- Consumes: `state.gen`, `StaleError` staleness hook (Tasks 4, 10).
- Produces: a `#reset` header button; new search while a graph exists resets it (gen bump).

- [ ] **Step 1: Write the failing e2e test**

`tests/e2e/reset.spec.mjs`:
```js
import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

test('reset clears the graph and restores the empty state', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.locator('#reset').click()
  await expect(page.locator('.node')).toHaveCount(0)
  await expect(page.locator('#empty')).toBeVisible()
  await expect(page.locator('#inspector')).toBeHidden()
})

test('a response landing after reset is discarded (stale generation)', async ({ page }) => {
  let release
  const gate = new Promise(r => { release = r })
  await stubApi(page, fixtures, {
    '/citations': async () => { await gate; return { json: fixtures.routes.citations } },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-citations').click()   // hangs on the gate
  await page.locator('#reset').click()                  // reset while in flight
  release()
  await page.waitForTimeout(300)
  await expect(page.locator('.node')).toHaveCount(0)    // stale response discarded
})
```

Note: `stubApi`'s override handler must support async functions — it already does (`typeof resp === 'function'` then `await` is added here). Update `helpers.mjs`'s override branch to:
```js
const r = typeof resp === 'function' ? await resp(url) : resp
```

- [ ] **Step 2: Implement**

`index.html` — add to `<header>` after the form:
```html
<button id="reset" type="button" hidden>reset</button>
```

`main.js`:
- In `init()`, add `els.reset = $('reset')` and `els.reset.addEventListener('click', reset)`.
- In `seed()`, add `els.reset.hidden = false`.
- Add:
```js
function reset() {
  state.gen += 1
  state.nodes.clear()
  state.edges.clear()
  state.selected = null
  state.seedId = null
  els.inspector.hidden = true
  els.empty.hidden = false
  els.reset.hidden = true
  setStatus('ready')
  render()
}
```

- [ ] **Step 3: Run to verify pass**

Run: `npm run test:e2e`
Expected: all PASS. The stale test passes because `expand()` checks `gen !== state.gen` after the await and the client's `isStale` drops still-queued requests.

- [ ] **Step 4: Commit**

```bash
git add main.js index.html tests/e2e/reset.spec.mjs tests/e2e/helpers.mjs
git commit -m "feat: reset with generation counter; stale responses discarded"
```

---

### Task 12: Keyboard navigation, a11y, reduced motion

**Files:**
- Modify: `main.js` (canvas key handling), `graph.js` (roving tabindex)
- Test: `tests/e2e/a11y.spec.mjs`

**Interfaces:**
- Consumes: `graph.positions()`, `nearestInDirection` (Task 6), `graph.focusNode(id)` (Task 9).
- Produces: arrow-key spatial navigation on the canvas; Tab reaches nodes; reduced-motion instant layout.

- [ ] **Step 1: Write the failing e2e test**

`tests/e2e/a11y.spec.mjs`:
```js
import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

async function seedAndExpand(page) {
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-references').click()
}

test('keyboard-only: search → result → seed → arrow to neighbor → Enter selects', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.press('#results li >> nth=0', 'Enter')          // seed via keyboard
  await page.getByTestId('expand-references').click()
  await page.locator('.node[data-id="seed1"] circle.hit').click()
  await page.locator('.node[data-id="seed1"]').press('ArrowLeft')  // r1 (1949) sits left
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-id'))
  expect(['r1', 'r2']).toContain(focused)                    // nearest leftward node
  await page.keyboard.press('Enter')
  await expect(page.locator(`.node[data-id="${focused}"]`)).toHaveClass(/selected/)
})

test('nodes expose aria-labels and visible focus ring class hooks', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.goto('/')
  await seedAndExpand(page)
  const label = await page.locator('.node[data-id="seed1"]').getAttribute('aria-label')
  expect(label).toContain('1953')
  expect(label).toContain('Molecular Structure')
})

test('reduced motion: layout settles instantly (no mid-animation positions)', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await seedAndExpand(page)
  const y1 = await page.locator('.node[data-id="r1"]').getAttribute('transform')
  await page.waitForTimeout(400)
  const y2 = await page.locator('.node[data-id="r1"]').getAttribute('transform')
  expect(y1).toBe(y2)   // already settled at first paint
})
```

- [ ] **Step 2: Implement**

`graph.js` — in `update()`, make the selected node the tab stop (roving tabindex): after `.classed('pinned', ...)` add:
```js
    allNodes.attr('tabindex', d => (d.id === selectedId ? 0 : -1))
```

`main.js` — in `init()`, wire canvas arrow keys:
```js
  els.canvas.addEventListener('keydown', e => {
    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key]
    if (!dir) return
    const fromId = document.activeElement?.getAttribute?.('data-id') || state.selected
    if (!fromId) return
    e.preventDefault()
    const next = nearestInDirection(graph.positions(), fromId, dir)
    if (next) graph.focusNode(next)
  })
```
Add `nearestInDirection` to the `graph.js` import line in `main.js`.

- [ ] **Step 3: Run to verify pass**

Run: `npm run test:e2e`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add main.js graph.js tests/e2e/a11y.spec.mjs
git commit -m "feat: spatial keyboard nav, aria labels, reduced-motion instant layout"
```

---

### Task 13: Error flows — 404 vs 429, Retry-After, exhaustion, offline recovery, narrow viewport

**Files:**
- Test: `tests/e2e/errors.spec.mjs` (implementation already exists in Tasks 4/10; this task verifies it end-to-end and patches anything the tests flush out)

**Interfaces:**
- Consumes: `S2Client` retry policy, `#retry` button, `#inspector` responsive CSS.

- [ ] **Step 1: Write the e2e tests**

`tests/e2e/errors.spec.mjs`:
```js
import { test, expect } from '@playwright/test'
import * as fixtures from './fixtures.mjs'
import { stubApi } from './helpers.mjs'

test('404 surfaces immediately with no retry button', async ({ page }) => {
  await stubApi(page, fixtures, { '/paper/search': { status: 404, json: {} } })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await expect(page.locator('#status')).toContainText('paper not found')
  await expect(page.locator('#retry')).toBeHidden()
})

test('429 with Retry-After: backoff message, then success on retry', async ({ page }) => {
  let calls = 0
  await stubApi(page, fixtures, {
    '/paper/search': () => {
      calls++
      return calls === 1
        ? { status: 429, headers: { 'Retry-After': '1' }, json: {} }
        : { json: fixtures.routes.search }
    },
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await expect(page.locator('#status')).toContainText('rate limited — retrying in 1s')
  await expect(page.locator('#results li').first()).toBeVisible({ timeout: 10_000 })
})

test('retry exhaustion: manual retry appears, works after service recovers', async ({ page }) => {
  let healthy = false
  await stubApi(page, fixtures, {
    '/citations': () => (healthy ? { json: fixtures.routes.citations } : { status: 503, json: {} }),
  })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  await page.getByTestId('expand-citations').click()
  await expect(page.locator('#retry')).toBeVisible({ timeout: 60_000 })   // 3 jittered backoffs first
  healthy = true
  await page.locator('#retry').click()
  await expect(page.locator('.node')).toHaveCount(26, { timeout: 15_000 })
})

test('narrow viewport: inspector is a bottom sheet with a close button', async ({ page }) => {
  await stubApi(page, fixtures)
  await page.setViewportSize({ width: 480, height: 800 })
  await page.goto('/')
  await page.fill('#search', 'nucleic')
  await page.press('#search', 'Enter')
  await page.locator('#results li').first().click()
  const box = await page.locator('#inspector').boundingBox()
  expect(box.width).toBeGreaterThan(400)          // full-width sheet, not side column
  expect(box.y).toBeGreaterThan(300)              // anchored low
  await page.locator('#inspector-close').click()
  await expect(page.locator('#inspector')).toBeHidden()
})
```

- [ ] **Step 2: Run**

Run: `npm run test:e2e`
Expected: all PASS. The exhaustion test is slow (~real jittered backoff, up to ~40 s worst case) — acceptable for one test; if it flakes on time, cap it by adding `&& new URLSearchParams(location.search).get('fastretry')` style hook — do NOT weaken the production backoff.

- [ ] **Step 3: Fix anything flushed out, keep suite green, commit**

```bash
git add tests/e2e/errors.spec.mjs main.js s2.js
git commit -m "test: end-to-end error flows — 404, Retry-After, exhaustion, bottom sheet"
```

---

### Task 14: Deploy artifacts and README

**Files:**
- Create: `CNAME`, `README.md`, `.github/workflows/test.yml`, `robots.txt`

- [ ] **Step 1: Write deploy/config files**

`CNAME`:
```
lineage.pvjohnston.com
```

`robots.txt`:
```
User-agent: *
Allow: /
```

`.github/workflows/test.yml`:
```yaml
name: test
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm ci
      - run: npm test
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e
```

`README.md`:
```markdown
# Lineage

A citation explorer, served at **lineage.pvjohnston.com**. Search any paper
via the [Semantic Scholar Academic Graph](https://api.semanticscholar.org/),
then expand what it cites and who cites it. Papers are pinned to a year
axis, so citation lineage reads left-to-right as a genealogy of ideas.

Edges encode citation, from the citing paper to the cited paper — usually,
but not always, newer to older. Read the graph left-to-right as intellectual
influence.

## Architecture

Single page, no build step. `index.html` loads ES modules directly:

```
index.html       # site root
├── main.js      # controller + graph model (state, ranking, disclosure)
├── s2.js        # Semantic Scholar client: 1 rps queue, retry, LRU cache
├── graph.js     # D3 renderer: year-pinned x, force-managed y
└── lineage.css  # the entire theme (ink on paper)
```

- D3 v7 from CDN; no API key (keyless shared pool, 1 request/second pace).
- Design spec: `docs/superpowers/specs/2026-07-21-lineage-citation-explorer-design.md`.

## Development

```sh
npm install && npx playwright install chromium
npm test          # unit (node --test)
npm run test:e2e  # Playwright, API + CDN fully stubbed
npm run serve     # http://localhost:8010
```

## License

BSD-3-Clause.
```

- [ ] **Step 2: Full suite green**

Run: `npm test && npm run test:e2e`
Expected: everything PASSes.

- [ ] **Step 3: Commit**

```bash
git add CNAME robots.txt README.md .github/
git commit -m "chore: deploy artifacts — CNAME, CI workflow, README"
```

- [ ] **Step 4: Manual launch steps (require Peter / cannot be done by the executor)**

Report these as the task's deliverable — do NOT attempt them:
1. Create the GitHub repo (`gh repo create noprofits-org/lineage --public --source=. --push` or under whichever org Peter chooses) — needs Peter's confirmation of org and visibility.
2. Enable GitHub Pages: repo → Settings → Pages → deploy from `main` / root.
3. DNS: add a CNAME record `lineage` → `<github-username>.github.io` on pvjohnston.com's DNS.
4. Follow-up in the pvjohnston.com repo (separate session/PR): swap the flagship work-card on `index.html` from noprofits.org to Lineage, per the spec's Identity section.

---

## Self-review notes (already applied)

- Spec coverage: every spec section maps to a task — semantic convention (7, 9), visual system (7, 9), layout/responsive (7, 13), a11y contract (12), architecture files (2–9), ranking/pagination contract (5, 10), concurrency (10, 11), retry (4, 13), cache fallback (3), cap partial admission (5, 10), empty state (7), disclosure tiers (5, 10), gutter/undated (6, 9), rescale minimal-displacement (6, 9 via `solveDomain`), deploy (14).
- Deliberate deferrals within the plan (not spec gaps): Task 9's render.spec runs fully only after Task 10 wires expansion — called out in both tasks.
- Type consistency: `expansion.{references,citations}` naming used identically in Tasks 5, 8, 10; `direction` strings are `'references' | 'citations'` everywhere; edge keys use `→` consistently.
