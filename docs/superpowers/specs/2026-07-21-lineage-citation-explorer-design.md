# Lineage — Citation Explorer: Design

**Date:** 2026-07-21
**Status:** Approved (brainstorming session with Peter)
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
- No mobile-first optimization beyond basic responsiveness; desktop is primary.
- Not a replica of Connected Papers/Litmaps similarity maps — this is a strict
  citation-edge explorer with a temporal reading.

## Identity

- **Name:** Lineage. Wordmark set in Bricolage Grotesque.
- **Domain:** lineage.pvjohnston.com (CNAME → GitHub Pages; new repo, sibling
  of `grants`).
- **Follow-up (separate PR in pvjohnston.com repo, not part of the app):**
  replace the noprofits.org flagship card on the index with Lineage.

## Visual design

Ink on paper; deliberately the inversion of Grant Flows' cream/sky/rounded
tool chrome. Not flashy, not over-stylized.

- **Surface:** plain white background, near-black ink. No cream, no canvas
  tint, no shadows, no gradients, no pills. Square corners, 1 px borders.
- **Nodes:** small filled dots, 3–6 px radius, scaled gently by citation
  count. Undated papers render as hollow dots.
- **Edges:** hairline (~0.75 px) grey-black lines, **no arrowheads** —
  direction is legible from the time axis (influence flows left → right).
- **Single accent color:** pvjohnston.com indigo `#465C9B`, used ONLY for the
  selected node, its direct edges, and hyperlinks. Everything else is
  monochrome.
- **Type (the "hint back" to pvjohnston.com):** Hanken Grotesk (UI),
  JetBrains Mono (years, counts, metadata, axis ticks), Bricolage Grotesque
  (wordmark only).
- **Year axis:** thin ruled line along the bottom with mono tick labels,
  styled like a figure axis from the pvjohnston.com blog ("Fig. 1" register).
- **Labels:** first author + year, shown on hover; pinned for selected and
  expanded nodes. Label halo per the grants technique (paint-order: stroke)
  in the background color so labels stay crisp crossing edges.

## Layout

- Slim header: wordmark + single search field. No masthead chrome.
- Full-bleed graph canvas below the header.
- Right-hand inspector column (plain, separated by a 1 px rule) opens on node
  selection: title, authors, year, venue, abstract, citation count, DOI and
  Semantic Scholar links, expand actions ("show references", "show
  citations", "load more").
- One-line status footer: request state, truncation notices, errors.

## Architecture

Single page, no build step, ES modules loaded directly by `index.html`.
D3 v7 from CDN. Repo layout:

```
index.html      # site root
├── main.js     # controller: search, selection, expand, graph state
├── s2.js       # Semantic Scholar API client + request queue + cache
├── graph.js    # D3 renderer: fixed-x year scale, force-managed y
└── lineage.css # entire theme (self-contained; no shared noprofits theme)
```

### graph.js layout model

- x = linear year scale, domain auto-fit to loaded papers, rescaling smoothly
  (animated transition) as expansion widens the year range.
- Forces manage **y only**: collision + weak y-centering. Link force acts
  vertically (or with x-pinning via fx) so the year positions never drift.
- Undated papers: hollow dots in a visually demarcated "undated" gutter at
  the right edge. Never guess a year.
- Node cap ~300 with a status-line notice before performance degrades.

### s2.js data model

- Nodes keyed by Semantic Scholar `paperId`:
  `{ paperId, title, year, authors, venue, abstract?, citationCount,
     externalIds (DOI), expanded: {refs, cites} }`
- Edges: `{ from: citingPaperId, to: citedPaperId }` (deduplicated).
- Fields requested: `title,year,authors,venue,citationCount,externalIds`
  (+ `abstract` on single-paper fetch for the inspector).

## Data flow

1. **Search:** `GET /graph/v1/paper/search?query=…` → result list → user picks
   the seed paper.
2. **Expand:** `GET /paper/{id}/references` and `/paper/{id}/citations`.
   Add the **top 25 by citationCount** per direction, with "load more" and a
   status note ("showing 25 of 1,203 citations").
3. **Rate limiting:** all requests pass through a 1 req/sec queue (keyless
   shared-pool etiquette) with an in-flight indicator in the status line.
4. **Caching:** responses cached in memory and localStorage (with a version
   key + LRU/size cap) so re-expanding and revisits are free.

## Errors & edge cases

- 429 / network failure: status-line message, automatic exponential backoff
  and retry; queue pauses rather than dropping requests.
- Empty search results and zero-citation dead ends: plain-language messages.
- Truncation is always disclosed in the status line — never silently capped.
- Missing abstracts/venues: inspector omits the row rather than showing
  placeholders.

## Testing

- **Playwright e2e** (as in grants): local static server + stubbed API
  fixtures; flows: search → seed → expand references → expand citations →
  inspector content → status-line truncation notice.
- **Unit tests** (node test runner, mocked fetch): `s2.js` response mapping,
  request queue/backoff behavior, year-scale domain logic, undated-gutter
  assignment, edge deduplication.

## Future work (explicitly out of scope for v1)

- OpenAlex enrichment (funders, institutions, topics) via the existing CORS
  proxy with a free key.
- Curated trailhead seeds on the landing page.
- Shareable graph-state URLs.
