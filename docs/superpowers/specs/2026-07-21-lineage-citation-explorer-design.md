# Lineage — Citation Explorer: Design

**Date:** 2026-07-22 (rev 4, Crossref + OpenCitations provider pivot)
**Status:** Approved for implementation
**Role:** Flagship project for pvjohnston.com, succeeding noprofits.org in the flagship card slot.

## Summary

Lineage is a static, single-page interactive citation-graph explorer served at
**lineage.pvjohnston.com**. A visitor searches for a paper through Crossref,
selects a result as the seed, and expands its references (what it cites) and
citations (what cites it) through OpenCitations Index v2. Crossref supplies
direct metadata for DOI-bearing papers; OpenCitations Meta supplies limited
fallback metadata for DOI-less OMID papers.

The distinctive feature is the **time-axis layout**: every dated paper's
x-position is pinned to its publication year, so citation lineage reads
left-to-right as a genealogy of ideas rather than a force-directed hairball.

Architecturally it is a sibling of grants.noprofits.org: one static page, no
build step, browser-native ES modules, D3 v7, and keyless public APIs. It must
remain zero-cost and must not require a proxy or expose a credential.

## Goals

- Combine research-adjacent substance, engineering portfolio signal, and broad
  approachability in one project.
- Remain static-hostable, keyless, proxy-free, and free of server state.
- Represent provider coverage and ranking honestly; never imply that an open
  citation index is exhaustive or that a sampled batch is globally top-ranked.
- Make large citation neighborhoods useful without allowing an unbounded API
  response to overwhelm the browser.

## Non-goals

- No global “top cited” ordering. That would require hydrating or precomputing
  a count for every neighbor and therefore a backend or another data product.
- No OpenAlex/funder/institution enrichment at launch.
- No accounts, server state, or saved graphs. Local storage is only a bounded
  response-metadata cache.
- No similarity graph. Every displayed edge must be an actual citation edge
  returned by OpenCitations.
- Desktop is primary. The responsive behavior below is binding, but mobile is
  not optimized beyond it.

## Identity

- **Name:** Lineage. Wordmark set in Bricolage Grotesque.
- **Domain:** lineage.pvjohnston.com (CNAME → GitHub Pages).
- **Follow-up:** replace the noprofits.org flagship card in the pvjohnston.com
  repository in a separate change.

## Semantic convention: citation vs. influence

The empty state and About text use this exact convention:

> **Edges encode citation, from the citing paper to the cited paper —
> usually, but not always, newer to older. Read the graph left-to-right as
> intellectual influence.**

Position cannot encode direction for same-year citations, future-dated or bad
metadata, or undated papers. On hover and selection, each incident edge gains
a small monochrome half-arrow **cited-end tick**. Resting edges remain
arrowless hairlines.

## Visual design

Ink on paper; deliberately the inversion of Grant Flows' cream/sky/rounded
tool chrome.

- **Surface:** white, near-black ink, square corners, and 1 px rules. No cream,
  shadows, gradients, pills, or rounded controls.
- **Nodes:** filled dots with a 3–6 px radius. Radius is gently scaled by the
  nullable Crossref `is-referenced-by-count` proxy. A missing proxy uses the
  minimum radius and is not represented as zero. Undated papers are hollow.
  Each dot has an invisible approximately 24 px pointer/keyboard hit area.
- **Edges:** approximately 0.75 px grey-black lines, with the selected/hovered
  cited-end tick described above.
- **Accent:** pvjohnston.com indigo `#465C9B`, used only for the selected node,
  its direct edges, and hyperlinks. A ring and pinned label make selection
  non-color-dependent.
- **Type:** Hanken Grotesk for UI, JetBrains Mono/system monospace for years and
  counts, and Bricolage Grotesque for the wordmark only.
- **Axis:** a ruled bottom year axis with mono tick labels and D3 tick thinning.
- **Labels:** first author + year on hover, pinned for selected and expanded
  nodes, with a background-color paint-order halo.

## Layout and responsive behavior

- Slim header with wordmark and one search field; full-bleed graph below.
- **Inspector:** at viewport widths ≥720 px, a right column separated by a 1 px
  rule that shrinks the canvas. Below 720 px, a bottom sheet overlays the lower
  canvas and has a visible close button.
- The inspector shows available title, authors, year, venue, abstract, DOI,
  source links, expansion actions, source-labelled counts, and a **textual
  relationships list** describing loaded outgoing and incoming edges.
- Crossref's citation proxy and OpenCitations known-link totals are displayed as
  separate facts. Missing values are omitted or labelled unavailable, never
  coerced to zero.
- One-line status footer: request state, representative-sample disclosure,
  large-expansion confirmation, safety stops, node-cap notices, errors, and a
  manual Retry action after retry exhaustion.
- **Empty state:** one instruction sentence (“Search for a paper, then click
  nodes to trace what it cites and who cites it”) and 2–3 static examples such
  as “Attention Is All You Need,” “Hartree 1928,” and “CRISPR-Cas9.”

## Accessibility contract (minimal, binding)

- Search, result list, canvas nodes, inspector controls, confirmation, Retry,
  and reset are keyboard reachable.
- Results use arrow-key navigation. Canvas nodes use roving tabindex; an arrow
  key moves focus to the spatially nearest node in that direction independent
  of edge structure. Enter/Space selects a node.
- Nodes and controls have a visible focus indicator.
- `prefers-reduced-motion` makes domain rescaling and node repositioning
  immediate.
- Selection, loading, confirmation, and expansion state never depend on color.
- The textual relationship list is the primary screen-reader path for edges.
  Nodes have concise labels containing first author, year, and title;
  decorative edges and axis marks are hidden from the accessibility tree.
- The “activate again” large-expansion confirmation must also be announced in the
  status region and reflected in the expand control's accessible description.

## Architecture

Single page, no build step, ES modules loaded directly by `index.html`; D3 v7
is pinned and loaded from the CDN with SRI.

```text
index.html      # site root and semantic shell
├── main.js     # controller, graph model, expansion state, disclosures
├── data.js     # Crossref + OpenCitations clients, queues, retry, cache
├── graph.js    # fixed-x year renderer and force-managed y layout
└── lineage.css # self-contained visual theme and responsive inspector
```

`data.js` replaces the Semantic Scholar-specific `s2.js`. Provider details
must not leak into graph identity or edge semantics.

### Provider responsibilities

| Responsibility | Source | Contract |
|---|---|---|
| Search | Crossref REST `/works` list/search | Keyless; minimal `select` fields; normalized results; 1 request/second |
| Seed/direct metadata | Crossref REST `/works/{doi}` | One DOI per request; 5 requests/second, concurrency 1 |
| Edge preflight totals | OpenCitations Index v2 count endpoints | Required before an edge-list request |
| Citation/reference edges | OpenCitations Index v2 `citations` / `references` | Complete known-open-link response for one identifier/direction |
| DOI candidate hydration | Crossref REST `/works/{doi}` | Singleton requests only; progressive status |
| DOI-less fallback hydration | OpenCitations Meta `/metadata/{ids}` | OMID only, batches of at most 10, split again to keep the encoded URL safe |

OpenCitations Index and Meta share one client-side scheduler capped at **180
requests/minute/IP**. Crossref uses one scheduler with concurrency 1 and
endpoint-aware pacing: **1 request/second for list/search** and **5
requests/second for singleton works**. A search request and singleton request
may not run concurrently.

### Paper identity and normalized metadata

Every graph node has a provider-neutral `paperId`. Normalize every available
identifier and choose the first available canonical form in this priority:

1. normalized DOI: `doi:10.…` (lowercase; URL and `doi:` prefixes removed),
2. OpenCitations Meta identifier: `omid:…`,
3. PubMed identifier: `pmid:…`.

Keep every other normalized identifier in `aliases`, and maintain an alias map
so the same work cannot enter the graph twice under different identifiers.
Hydration occurs before admission, so newly discovered DOI aliases participate
in canonicalization. If a later record reveals that two existing IDs are the
same work, merge nodes and deduplicate/rewire their edges without losing the
selected node. Never expose a Crossref- or OpenCitations-specific database key
as graph identity unless it is one of the normalized aliases above.

```js
{
  paperId,                       // doi:… then omid:… then pmid:…
  aliases: string[],
  doi: string | null,
  omid: string | null,
  pmid: string | null,
  title: string | null,
  authors: string[],
  year: number | null,
  yearSource: 'metadata' | 'edge' | 'derived' | null,
  venue: string | null,
  abstract: string | null,
  crossrefCitedByCount: number | null,
  openCitationCount: number | null,
  openReferenceCount: number | null,
  expansion: {
    references: ExpansionState,
    citations: ExpansionState,
  },
}
```

`crossrefCitedByCount` is a node-size/inspector proxy from Crossref.
`openCitationCount` and `openReferenceCount` are OpenCitations known-link
totals. They are not interchangeable, and no count defaults to zero merely
because it is missing.

Edges remain `{ citing: paperId, cited: paperId }`, are deduplicated on insert,
and always encode citing → cited.

### Expansion state

Each node has independent state for references and citations:

```js
{
  status: 'idle' | 'preflighting' | 'confirm' | 'blocked' |
          'fetching' | 'hydrating' | 'error',
  preflightCount: number | null,
  confirmation: { generation: number, count: number } | null,
  candidates: EdgeCandidate[],       // compact, normalized, memory-only
  cursor: number,                    // next candidate in stratified order
  displayedCount: number,
  candidateCount: number | null,     // deduplicated returned links
  exhausted: boolean,
}
```

The raw OpenCitations edge response is normalized immediately into compact
candidate descriptors and discarded. Neither raw edge arrays nor normalized
candidate arrays are persisted in localStorage. Reset releases them.

## Time data contract

OpenCitations `creation` is the citing work's publication date in either
direction.

- For an incoming citation, the neighboring work is the citing work, so
  `creation` directly supplies its provisional date/year.
- For an outgoing reference, the neighboring work is the cited work.
  `creation` therefore describes the current/citing node, not the neighbor.
  Derive a provisional cited date from `creation - timespan` only when both
  values have enough calendar precision to determine an unambiguous year.
  Ambiguous year-only/month-only arithmetic, malformed or negative durations,
  and unsupported duration components produce no derived year.
- Crossref or OpenCitations Meta hydration confirms or replaces any provisional
  date. Metadata wins. A failed hydration may leave a defensible provisional
  year; otherwise the node goes to the undated gutter.
- Same-year and future-dated edges retain the supplied dates. Direction is
  never inferred from x-position.

## Deterministic representative ordering

OpenCitations edge rows do not contain a globally comparable citation count for
each neighbor. Lineage therefore does not claim global “top” results.

After edge normalization and deduplication, but **before metadata hydration**,
the controller computes one deterministic candidate order:

1. Split dated and undated candidates; sort dated candidates by provisional
   year then `paperId`, and undated candidates by `paperId`.
2. Build each batch of at most **25** from the remaining candidates. While both
   sets remain, reserve one slot for the next undated candidate and take the
   remaining slots at evenly spaced quantiles across the dated candidates.
   When only one set remains, fill from that set using the same stable ordering
   or dated quantiles.
3. Remove selected candidates and repeat until the complete order is built.

This makes every batch reproducible, spreads dated work across the visible time
range, and prevents metadata availability or response timing from biasing
selection. Hydration may correct a node's year after selection but does not
reorder an already computed expansion.

## Expansion flow and browser safety

For one node and one direction:

1. **Preflight:** request the OpenCitations Index v2 count. Preflight is
   required; a failed preflight follows the retry policy and does not fetch the
   edge array.
2. **Safety decision:**
   - `0` → disclose the dead end; do not request edges.
   - `1–5,000` → continue on the first click.
   - `5,001–25,000` → set `status = 'confirm'` and disclose, for example,
     “11,144 known open citations — activate show citations again to load.” Only a
     second activation of that same node/direction in the same graph generation
     proceeds. Selecting another node, reset, or a changed total clears it.
   - `>25,000` → hard browser safety stop. Do not request the edge array, and
     explain that the neighborhood exceeds Lineage's browser-only limit.
3. **Fetch edges:** issue exactly one Index v2 request for that direction,
   normalize aliases/dates, deduplicate candidates, compute the deterministic
   order, and discard the raw response. The deduplicated returned candidate
   count becomes the truthful expansion total even if it differs from the
   preflight count.
4. **Hydrate batch:** take the next 25 candidates. DOI-bearing candidates use
   Crossref singleton metadata. Only DOI-less candidates with an OMID use
   OpenCitations Meta, in batches of at most 10 and additionally split before
   the encoded request URL approaches the implementation's tested safe limit.
   PMID-only candidates remain minimal identifier/date nodes if no permitted
   hydration path exists.
5. **Admit:** merge aliases, add nodes and citation edges in candidate order,
   and stop at the existing 300-node cap. Individual missing metadata does not
   erase a known edge; admit a minimal labelled node and disclose incomplete
   metadata after retry exhaustion. A transient per-paper hydration failure
   admits the placeholder immediately and exposes a focused manual metadata
   Retry without refetching the edge array.
6. **Load more:** hydrate and admit the next local candidate batch. It never
   refetches the direction's edge array. It may make metadata requests for the
   new batch.

Truthful disclosure examples:

- Complete small set: “showing 7 of 7 known open references.”
- Partial representative set: “showing 25 representative citations from
  11,144 known open citation links.”
- Later batch: “showing 50 representative citations from 11,144 known open
  citation links.”
- Node cap suffix: “node cap reached — added 12 of 25.”

Never use “top,” conflate the Crossref proxy with OpenCitations totals, or imply
that “known open” means all citations in existence.

## Graph layout model

- x is a linear year scale auto-fit to loaded papers. When expansion widens the
  domain, rescaling minimizes displacement of the selected node while keeping
  the full dated domain visible. Preserve its exact screen x-position when the
  constraints permit; otherwise move only as far as needed. Announce “timeline
  widened.” Reduced motion makes the rescale immediate.
- Forces manage y only: collision plus weak centering; x remains pinned via
  `fx`.
- Undated papers are hollow dots in a demarcated right gutter. Never guess a
  year.
- **Node cap 300, partial admission:** admit in deterministic candidate order
  until the cap is reached, disclose the partial batch, and do not evict nodes.
  Reset clears the graph.

## Concurrency, retries, and cache

- A click while that direction is preflighting, fetching, or hydrating is
  ignored. A click in `confirm` is the explicit second-click confirmation.
- Reset increments a generation counter. Every queued, in-flight, hydration,
  and retry continuation checks it; stale work is dropped and cannot mutate UI
  or cache-derived graph state.
- An identity merge cancels work tokens on both pre-merge node objects,
  preserves only settled expansion progress on the canonical survivor, and
  requires an explicit activation to resume canceled work.
- Each scheduler pauses its own queue during backoff; one provider's backoff
  does not freeze the other provider.
- Retry only network errors, 429, and transient 5xx. Honor `Retry-After` when
  accessible; otherwise use full-jitter exponential backoff with base 1 second,
  cap 30 seconds, and at most 4 attempts.
- Other 4xx responses fail immediately with provider-appropriate copy. After
  exhaustion, expose manual Retry for the failed operation.
- OpenCitations Meta may recursively isolate a multi-identifier batch only
  after an exhausted HTTP 500 batch-shape failure. Never split 502, 503, or 504
  outages: doing so would amplify one provider outage into many requests.
- Metadata repair has a stable per-paper/direction retry backlog. Loading a
  later display batch neither clears nor replaces unresolved earlier repairs.
- Cache successful Crossref metadata, OpenCitations Meta metadata, and small
  count responses in memory and localStorage under a new schema-version prefix
  with a 2,000,000-byte LRU cap. Corruption/quota errors degrade to memory-only
  with a status note. Never persist edge or candidate arrays.
- Request status is aggregated across schedulers so an idle event from one
  provider cannot hide another provider's loading/backoff state.

## Errors and edge cases

- Empty search and zero-link expansions use plain-language messages.
- A result without an OpenCitations-supported DOI/OMID/PMID can be inspected
  but its expansion controls are disabled with an explanation.
- Missing title/authors/venue/abstract/counts are nullable. Omit unavailable
  inspector rows; use a safe identifier-derived label for a minimal node.
- Crossref abstracts may contain JATS/XML. Convert them to text; never inject
  provider markup into the page.
- Malformed identifiers, duplicate aliases, self-citations, duplicate edge
  rows, count/edge mismatches, same-year, future-dated, and undated records have
  explicit unit coverage.
- Coverage copy says “known open citation links,” not “all citations.”

## Testing

### Unit tests

- Crossref search/direct-record mapping, nullable fields, JATS-to-text, and DOI
  normalization.
- OpenCitations count, citation/reference edge, identifier-alias, creation, and
  timespan mapping.
- DOI/OMID/PMID canonical priority, alias merge, edge rewiring, and dedupe.
- Exact deterministic time-stratified ordering, including fewer than 25,
  multiple batches, tied years, undated-only, and mixed dated/undated pools.
- `ExpansionState` transitions: preflight, confirm, blocked safety stop, fetch,
  hydrate, load more, exhaustion, error, and reset.
- Thresholds at 5,000/5,001 and 25,000/25,001; second-click generation binding.
- Separate pacing/concurrency, backoff/jitter/`Retry-After`, queue independence,
  and aggregate status.
- Cache versioning, LRU, corruption/quota fallback, and proof that edge arrays
  are never persisted.
- Existing year-domain, same/future/undated edge, node-cap, and dedupe coverage.

### Playwright end-to-end tests

- Crossref search → seed → Index preflight → citations/references → Crossref or
  Meta hydration → graph/inspector/relationships.
- Representative disclosure and load-more metadata calls without another edge
  request.
- 5,001-link confirmation, cancellation/reset, and >25,000 hard stop.
- Duplicate clicks, stale response after reset, partial hydration failure, and
  manual recovery.
- Provider-specific 404/429/5xx/network behavior and independent queues.
- Node-cap partial admission, metadata gaps, count mismatch, same/future/
  undated edges, and alias collision.
- Existing keyboard-only, roving-tabindex, visible-focus, reduced-motion, and
  narrow-inspector coverage.

All browser tests stub Crossref, OpenCitations Index v2, OpenCitations Meta, and
the D3 CDN; CI never depends on the live services.

## Future work

- A backend/precomputed ranking index if true global “top cited” ordering ever
  becomes a product requirement.
- OpenAlex enrichment for funders, institutions, and topics.
- Curated trailhead seeds, shareable graph-state URLs, and graph pruning beyond
  the hard cap.
