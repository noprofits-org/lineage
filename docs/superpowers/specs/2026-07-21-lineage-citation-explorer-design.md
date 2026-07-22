# Lineage — Citation Explorer: Design

**Date:** 2026-07-21 (rev 2, post spec review)
**Status:** Approved concept; rev 2 resolves review findings
**Role:** New flagship project for pvjohnston.com, succeeding noprofits.org in the flagship card slot.

## Summary

Lineage is a static, single-page interactive citation-graph explorer served at
**lineage.pvjohnston.com**. A visitor searches for any paper via the Semantic
Scholar Academic Graph API, the paper becomes a seed node, and clicking nodes
expands their references (what they cite) and citations (who cites them). The
distinctive feature is the **time-axis layout**: every paper's x-position is
pinned to its publication year, so citation lineage reads left-to-right as a
genealogy of ideas rather than a force-directed hairball.

Architecturally it is a sibling of grants.noprofits.org (single page, no build
step, ES modules, D3 v7, live keyless API). Visually it must read as a
**completely different implementation** from Grant Flows.

## Goals

- One project that credibly serves three purposes: research-adjacent substance,
  engineering portfolio signal, and broad approachability.
- Static hosting, zero running cost, no API keys, no proxy, nothing to leak.
- Sustainable: new papers and lineages are endless content; ties into the
  pvjohnston.com notebook (e.g. tracing the ancestry of Hartree–Fock).

## Non-goals

- No OpenAlex/funder/institution enrichment at launch (noted as future work).
- No accounts, no server state, no saved graphs (localStorage cache only).
- Desktop is primary; responsive behavior is specified below but mobile is not
  optimized beyond it.
- Not a replica of Connected Papers/Litmaps similarity maps — this is a strict
  citation-edge explorer with a temporal reading.

## Identity

- **Name:** Lineage. Wordmark set in Bricolage Grotesque.
- **Domain:** lineage.pvjohnston.com (CNAME → GitHub Pages; new repo, sibling
  of `grants`).
- **Follow-up (separate PR in pvjohnston.com repo, not part of the app):**
  replace the noprofits.org flagship card on the index with Lineage.

## Semantic convention: citation vs. influence

These are two readings of the same edge and the UI states the convention
explicitly (in the empty state and the About text):

> **Edges encode citation, from the newer paper to the older paper it cites.
> Read the graph left-to-right as intellectual influence.**

Position alone cannot encode direction for same-year citations, bad metadata,
or undated papers, so on **hover and selection** each edge gains a subtle
directional cue — a small monochrome half-arrow tick at the cited (older)
end. Default resting edges remain arrowless hairlines.

## Visual design

Ink on paper; deliberately the inversion of Grant Flows' cream/sky/rounded
tool chrome. Not flashy, not over-stylized.

- **Surface:** plain white background, near-black ink. No cream, no canvas
  tint, no shadows, no gradients, no pills. Square corners, 1 px borders.
- **Nodes:** small filled dots, 3–6 px radius, scaled gently by citation
  count. Undated papers render as hollow dots. Each dot sits inside an
  **invisible ~24 px hit area** that is the actual pointer/keyboard target.
- **Edges:** hairline (~0.75 px) grey-black lines; arrowless at rest, with
  the hover/selection directional tick described above.
- **Single accent color:** pvjohnston.com indigo `#465C9B`, used ONLY for the
  selected node, its direct edges, and hyperlinks. Selection is additionally
  indicated by a ring outline and pinned label, so it never depends on color
  alone. Everything else is monochrome.
- **Type (the "hint back" to pvjohnston.com):** Hanken Grotesk (UI),
  JetBrains Mono (years, counts, metadata, axis ticks), Bricolage Grotesque
  (wordmark only).
- **Year axis:** thin ruled line along the bottom with mono tick labels,
  styled like a figure axis from the pvjohnston.com blog ("Fig. 1" register).
  D3's tick heuristics thin the labels naturally on resize.
- **Labels:** first author + year, shown on hover; pinned for selected and
  expanded nodes. Label halo per the grants technique (paint-order: stroke)
  in the background color so labels stay crisp crossing edges.

## Layout & responsive behavior

- Slim header: wordmark + single search field. No masthead chrome.
- Full-bleed graph canvas below the header.
- **Inspector:** at ≥720 px viewport width, a right-hand column (plain,
  separated by a 1 px rule) that shrinks the canvas rather than covering it.
  Below 720 px it becomes a bottom sheet overlaying the lower canvas, with a
  visible close button. Opens on node selection: title, authors, year, venue,
  abstract, citation count, DOI and Semantic Scholar links, expand actions
  ("show references", "show citations", "load more"), and a **textual
  relationships list** (which loaded papers this one cites / is cited by) as
  the non-visual equivalent of the edges.
- One-line status footer: request state, truncation notices, errors, and the
  manual Retry action after retry exhaustion.
- **Empty state:** the canvas is never blank at first load — one sentence of
  instruction ("Search for a paper, then click nodes to trace what it cites
  and who cites it") plus 2–3 plain-text example queries (e.g. "Attention Is
  All You Need", "Hartree 1928", "CRISPR-Cas9"). These are static strings,
  not the curated-trailheads feature deferred to future work.

## Accessibility contract (minimal, binding)

- Search field, results list, nodes, inspector controls all keyboard
  reachable: results navigable by arrow keys; canvas nodes focusable (roving
  tabindex, arrow keys move between adjacent nodes, Enter selects/expands).
- Visible focus indicator on nodes (ring) and all controls.
- `prefers-reduced-motion`: domain rescaling and node entry reposition
  instantly, no animated transitions.
- Selection and expansion state never conveyed by color alone (ring + pinned
  label + inspector).
- The inspector's textual relationships list is the primary screen-reader
  path to edge information. Canvas nodes carry concise `aria-label`s
  (first author, year, title) so keyboard focus is announced; decorative
  edges and axis marks are hidden from the accessibility tree.

## Architecture

Single page, no build step, ES modules loaded directly by `index.html`.
D3 v7 from CDN. Repo layout:

```
index.html      # site root
├── main.js     # controller: search, selection, expand, graph state
├── s2.js       # Semantic Scholar API client + request queue + retry + cache
├── graph.js    # D3 renderer: fixed-x year scale, force-managed y
└── lineage.css # entire theme (self-contained; no shared noprofits theme)
```

### graph.js layout model

- x = linear year scale, domain auto-fit to loaded papers. When expansion
  widens the domain, the rescale **preserves the selected node's screen
  x-position** (translate compensation) so the user keeps their place; a
  brief status-line note marks that the timeline widened. Under
  reduced-motion the rescale is instant.
- Forces manage **y only**: collision + weak y-centering; x is pinned via
  `fx` from the year scale so year positions never drift.
- Undated papers: hollow dots in a visually demarcated "undated" gutter at
  the right edge. Never guess a year. Edges touching the gutter rely on the
  hover directional tick for direction.
- **Node cap 300, partial admission:** if an expansion would exceed the cap,
  admit candidates in rank order until the cap is reached, then stop and
  disclose in the status line ("node cap reached — added 12 of 25"). No
  eviction in v1; the reset action clears the graph.

### s2.js data model

- Nodes keyed by Semantic Scholar `paperId`:

  ```
  { paperId, title, year, authors, venue, abstract?, citationCount,
    referenceCount, externalIds (DOI),
    expansion: { refs: ExpansionState, cites: ExpansionState } }
  ```

- `ExpansionState` (per direction):

  ```
  { status: 'idle' | 'loading' | 'error',
    nextOffset,        // API offset for the next pool page, null if none
    fetchedCount,      // items downloaded into the local pool
    displayedCount,    // items admitted to the graph
    total,             // from the paper's citationCount / referenceCount
    exhausted }        // no further items server-side
  ```

- Edges: `{ citing: paperId, cited: paperId }` — key order encodes citation
  direction (newer → older). Deduplicated on insert.

### Concurrency rules

- An expansion click while that direction's `status === 'loading'` is
  ignored (no queue duplication).
- Graph reset increments a generation counter; responses arriving for a
  stale generation are discarded, and pending queued requests for the old
  generation are dropped from the queue.

## Data flow & the ranking/pagination contract

API facts verified against the live service (2026-07-21): the
`/paper/{id}/citations` and `/references` endpoints accept `limit` up to
1000 with `{offset, data, next?}` responses; a `sort` parameter is
**silently ignored** (no server-side ranking); responses carry **no total
count** — totals come from the parent paper's `citationCount` /
`referenceCount`.

1. **Search:** `GET /graph/v1/paper/search?query=…` → result list → user
   picks the seed paper.
2. **Expand (bounded candidate pool):** one request per direction with
   `limit=500` fetches the pool; the client ranks the pool locally by
   `citationCount` descending and admits the **top 25** to the graph.
3. **Load more:** reveals the next 25 from the already-fetched pool
   (instant, no request). Only when the pool is exhausted and `next` exists
   does it fetch the next 500-item pool page.
4. **Truthful disclosure** in the status line and inspector:
   - total ≤ 500 (pool covers everything): "top 25 of 1,203" style claims
     are globally true → "showing top 25 of 443 citations".
   - total > 500: rank claim is scoped to the pool → "showing top 25 of the
     first 500 fetched (8,412 total)".
5. **Rate limiting:** all requests pass through a 1 req/sec queue (keyless
   shared-pool etiquette) with an in-flight indicator in the status line.
6. **Caching:** responses cached in memory and localStorage under a
   schema-version key with a size cap and LRU eviction. localStorage quota
   errors or corrupt entries degrade silently to memory-only caching (a
   status-line note, never a failure).

Fields requested: `title,year,authors,venue,citationCount,referenceCount,
externalIds` (+ `abstract` on single-paper fetch for the inspector).

## Retry policy

- **Retryable:** 429, transient 5xx, and network errors.
  - Honor `Retry-After` when present; otherwise exponential backoff with
    full jitter, base 1 s, max delay 30 s, **max 4 attempts**.
  - The queue pauses while backing off rather than dropping requests.
- **Not retryable:** 400/404 and other 4xx — surface immediately in the
  status line ("paper not found").
- After retry exhaustion: status-line error + **manual Retry action**; the
  affected direction's `ExpansionState.status = 'error'`.
- The 1 req/sec pace is courtesy, not a guarantee — the shared public pool
  throttles readily (observed live during verification), so the backoff
  path is a first-class flow, not an edge case.

## Errors & edge cases

- Empty search results and zero-citation dead ends: plain-language messages.
- Truncation and node-cap admission are always disclosed in the status
  line — never silently capped.
- Missing abstracts/venues: inspector omits the row rather than showing
  placeholders.
- Same-year and future-dated papers: positioned by their stated year;
  direction remains readable via the hover tick (never inferred from
  position).

## Testing

- **Playwright e2e** (as in grants): local static server + stubbed API
  fixtures. Flows:
  - search → seed → expand references → expand citations → inspector
    content → truncation disclosure
  - "load more" from pool (no network) and across a pool boundary (network)
  - duplicate expansion clicks (ignored) and reset-then-response
    (stale-generation discard)
  - node-cap boundary: partial admission + disclosure
  - 404 vs 429/5xx handling; `Retry-After`; retry exhaustion → manual
    Retry; offline → recovery
  - keyboard-only: search, result selection, node navigation, expansion
  - reduced-motion rescale; inspector at <720 px (bottom sheet)
- **Unit tests** (node test runner, mocked fetch): `s2.js` response mapping,
  pool ranking + disclosure strings, `ExpansionState` transitions, queue
  pacing/backoff/jitter/`Retry-After`, year-scale domain logic incl.
  same-year/future-dated/undated cases, edge deduplication, localStorage
  quota/corruption fallback.

## Future work (explicitly out of scope for v1)

- OpenAlex enrichment (funders, institutions, topics) via the existing CORS
  proxy with a free key.
- Curated trailhead seeds on the landing page.
- Shareable graph-state URLs.
- Node eviction / graph pruning beyond the hard cap.
