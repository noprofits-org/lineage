# Lineage Citation Explorer — Crossref + OpenCitations Migration Plan

**Date:** 2026-07-22
**Design:** `docs/superpowers/specs/2026-07-21-lineage-citation-explorer-design.md` rev 4
**Goal:** Replace the implemented Semantic Scholar data path with Crossref
search/metadata and OpenCitations graph data while preserving the shipped
temporal renderer, accessibility contract, inspector behavior, retries, stale
generation protection, and 300-node cap.

## Baseline

The repository already contains the complete static application and green unit
and Playwright suites. This is a migration, not a rebuild. Preserve `index.html`,
`lineage.css`, and the established graph interaction unless a task below names a
specific change.

Current provider-specific surfaces:

- `s2.js`: response mapping, cache, paced queue, retry, and S2 endpoints.
- `main.js`: `paperId`, count-ranked pools, offsets, S2 totals, and inspector
  links.
- `graph.js`: assumes `paperId` and numeric `citationCount`.
- `tests/unit/s2-*.test.mjs`, `tests/e2e/fixtures.mjs`, and
  `tests/e2e/helpers.mjs`: S2-shaped fixtures/routes.
- `README.md`: S2 architecture and rate-limit copy.

## Binding migration constraints

- Crossref handles search and `/works/{doi}` direct metadata.
- OpenCitations Index v2 handles direction counts and citation/reference edges.
- DOI candidates hydrate through Crossref singleton requests.
- Only DOI-less OMID candidates hydrate through OpenCitations Meta. Meta
  batches contain at most 10 independently encoded identifiers, preserve
  literal `__` separators, and split further before exceeding the tested safe
  URL length.
- `paperId` is provider-neutral and canonicalized in this order: normalized
  `doi:`, then `omid:`, then `pmid:`. Preserve all normalized aliases.
- Incoming neighbor year comes directly from `creation`. Outgoing neighbor year
  may be derived from `creation - timespan` only when the result's year is
  unambiguous; hydration later confirms or replaces it.
- Select deterministic, time-stratified batches of 25 before hydration. Never
  claim global “top” ordering.
- Preflight every expansion. Require a second activation above 5,000 links and
  hard-stop above 25,000. Do not fetch the edge array after a hard stop.
- Never persist raw or normalized edge/candidate arrays in localStorage.
- Crossref: 1 request/second search, 5 requests/second singleton, concurrency 1.
  OpenCitations Index + Meta: one shared scheduler, 180 requests/minute/IP.
- OpenCitations totals and nullable Crossref citation proxies remain distinct.
- Load more hydrates another local candidate batch and never refetches edges.
- Preserve the existing retry policy, manual Retry, generation discard,
  duplicate-click protection, node cap, keyboard navigation, reduced motion,
  and responsive inspector.

## Target module interfaces

`data.js` replaces `s2.js` and exports provider-neutral interfaces:

```js
class DataClient {
  search(query, isStale?)
  directPaper(paperId, isStale?)
  connectionCount(paperId, direction, isStale?)
  connections(paperId, direction, isStale?)
  hydrateCandidates(candidates, isStale?)
}

class SourceError extends Error {
  provider
  status
  retryable
}

class StaleError extends Error {}
```

Pure exports must cover:

```js
normalizeDoi(value)
parsePidAliases(value)
canonicalPaperId(aliases)
mapCrossrefWork(raw)
mapOpenCitationsCount(json)
mapOpenCitationsEdges(json, direction, subjectPaper)
deriveReferenceYear(creation, timespan)
timeStratifiedOrder(candidates, batchSize = 25)
createCache(storage, options?)
isRetryable(status)
backoffDelay(attempt, retryAfter, rand?)
```

The façade may expose additional testable helpers, but `main.js` must not build
provider URLs or parse raw provider records.

---

## Task 1: Replace S2 fixtures with live-contract-shaped fixtures

**Files**

- Modify: `tests/e2e/fixtures.mjs`
- Modify: `tests/e2e/helpers.mjs`
- Create: `tests/unit/data-pure.test.mjs`

### Work

- Represent Crossref search as `{ message: { items: [...] } }` and direct works
  as `{ message: {...} }`.
- Include DOI arrays/strings, Crossref date-parts, author names,
  `container-title`, nullable `abstract`, `is-referenced-by-count`, and
  missing values without treating absent counts as zero.
- Represent Index counts as `[{ count: "…" }]` and edges with `citing`, `cited`,
  `creation`, and `timespan` strings.
- Include whitespace-separated PID aliases, DOI-less OMID rows, PMID aliases,
  duplicate aliases, same-year, future-dated, and undated rows.
- Add OpenCitations Meta records for DOI-less OMID fallback.
- Route and stub all three origins:
  - `https://api.crossref.org/**`
  - `https://api.opencitations.net/index/v2/**`
  - `https://api.opencitations.net/meta/v1/**`
- Keep the D3 CDN stub. Any unmatched provider request should fail the test
  loudly instead of reaching the network.

### Tests first

- DOI normalization strips URL/`doi:` prefixes and lowercases the value.
- PID parsing tolerates order/whitespace and preserves known aliases.
- Canonical priority is DOI → OMID → PMID.
- Crossref mapping handles title arrays, author gaps, date precision, JATS
  abstract text, and nullable counts.
- Incoming edges use `creation`; outgoing edges do not mistake `creation` for
  the cited neighbor's year.
- Reference-year derivation accepts only unambiguous supported inputs.
- Count strings map to finite non-negative integers; malformed counts fail
  safely.

### Gate

The new pure tests should fail because `data.js` does not exist; existing
tests should still describe the baseline until their owning tasks migrate them.

---

## Task 2: Implement provider clients, schedulers, retry, and cache

**Files**

- Create: `data.js`
- Create: `tests/unit/data-client.test.mjs`
- Create: `tests/unit/data-cache.test.mjs`
- Delete after migration: `s2.js`, `tests/unit/s2-pure.test.mjs`,
  `tests/unit/s2-client.test.mjs`, `tests/unit/s2-cache.test.mjs`

### Work

1. Reuse the proven retry behavior: network/429/transient-5xx only, accessible
   `Retry-After`, otherwise full-jitter exponential backoff (base 1 second,
   30-second cap, 4 attempts), then a retryable `SourceError`.
2. Implement a Crossref scheduler with shared concurrency 1 and endpoint-aware
   start intervals:
   - list/search: at least 1,000 ms between search starts;
   - singleton works: at least 200 ms between singleton starts;
   - search and singleton work never overlap.
3. Implement one OpenCitations scheduler shared by Index and Meta with at least
   334 ms between request starts.
4. Backoff pauses only the affected provider scheduler. Aggregate request state
   so an idle event cannot hide another provider's loading/backoff message.
5. Detect DOI-shaped search input and use direct Crossref lookup; otherwise use
   a focused Crossref works search, preferring `query.title`, `rows=10`, and a
   minimal `select` list.
6. Implement Index v2 direction-count and direction-edge requests using the
   best supported normalized alias.
7. Hydrate DOI candidates one at a time through Crossref. Hydrate only DOI-less
   OMID candidates through Meta:
   - maximum 10 IDs;
   - percent-encode each identifier independently;
   - keep `__` separators literal;
   - split on the URL-length ceiling before sending;
   - tolerate arbitrary result order and duplicates;
   - recursively isolate only an exhausted HTTP 500 batch-shape failure;
   - never split provider-wide 502/503/504 outages after their normal retry
     budget.
8. Admit PMID-only candidates as minimal records; do not silently route them
   through an unspecified metadata provider.
9. Bump the cache namespace. Cache successful Crossref records, Meta records,
   and count responses under the existing 2,000,000-byte LRU policy. Edge
   requests bypass persistent cache; normalize and discard their raw JSON.
10. Preserve memory-only fallback and one-time cache-unavailable notice.

### Tests

- Exact URL construction and identifier encoding for all endpoint types.
- Crossref search pacing, singleton pacing, and shared concurrency 1.
- One shared 180/minute OpenCitations pace across Index and Meta.
- Independent provider progress/backoff and aggregate status.
- 404 immediate failure versus 429/5xx/network retries, `Retry-After`, retry
  exhaustion, and queue recovery.
- Stale work is rejected before start, after fetch, and between Meta sub-batches.
- Meta batch count/URL splitting, duplicate results, partial misses, and 5xx
  recursive splitting.
- Persistent-cache round trip, LRU, corruption/quota fallback, namespace bump,
  and an assertion that edge arrays never reach `storage.setItem`.

### Gate

```sh
npm test
```

Provider unit suites pass. `s2.js` remains until `main.js` imports the new
façade; remove the old files only in the same change that removes the import.

---

## Task 3: Migrate graph identity and expansion model

**Files**

- Modify: `main.js` pure model section
- Modify: `graph.js`
- Rewrite: `tests/unit/model.test.mjs`
- Modify: `tests/unit/layout.test.mjs`

### Work

- Change renderer and model identity from S2 IDs to canonical `paperId` values
  with an alias index.
- Merge duplicate works discovered through aliases. Preserve selection,
  expansion state, and incident edges; rewire and deduplicate edge keys.
- Make Crossref proxy counts nullable. Minimum node radius is the visual
  fallback, not evidence of zero citations.
- Replace offset/pool state (`nextOffset`, `fetchedCount`, `pagesFetched`) with
  the rev 4 `ExpansionState`.
- Replace `rankPool`/`completeFetch` with:
  - edge-candidate normalization and dedupe;
  - the exact deterministic time-stratified ordering from the design;
  - cursor-based batches of 25;
  - candidate-count and exhaustion transitions.
- Preserve citing → cited edge order, self-edge handling, partial admission,
  and the 300-node cap.
- Replace disclosure strings with exact representative/known-open wording.

### Tests

- Canonical priority, alias collision before admission, late alias merge, edge
  rewiring, and selected-node preservation.
- Exact batch ordering for 0, 1, 24, 25, 26, and multi-batch candidate sets;
  tied years; mixed dated/undated; undated-only; repeatability under shuffled
  input.
- Hydration year correction does not reorder the stored candidate order.
- Incoming/outgoing edge direction, duplicates, self-citations, and count/edge
  mismatch.
- Nullable radius and node-cap partial admission.
- Exact disclosure strings:
  - `showing 7 of 7 known open references`
  - `showing 25 representative citations from 11,144 known open citation links`
  - later displayed totals and node-cap suffix.

### Gate

```sh
npm test
```

All model/layout/provider tests pass without provider-shaped data in graph
functions.

---

## Task 4: Migrate search, expansion, inspector, and stale work

**Files**

- Modify: `main.js` DOM/controller section
- Modify: `index.html` only if source-labelled inspector copy needs a semantic
  hook; do not redesign the shell
- Delete: `s2.js` after the final import is removed

### Search and seed

- Instantiate `DataClient` and translate `SourceError` into existing status
  and Retry behavior.
- Crossref results seed normalized nodes. Results without an Index-supported
  DOI/OMID/PMID remain inspectable but expose disabled expansion actions with a
  plain-language reason.
- Replace Semantic Scholar outbound links with DOI and applicable Crossref/
  OpenCitations source links.
- Convert Crossref JATS/XML abstracts to safe text; never use provider markup as
  `innerHTML`.

### Expansion state machine

Implement one independent state machine per node/direction:

1. `idle → preflighting` on first activation.
2. Count `0`: return to idle/exhausted and disclose the dead end.
3. Count `1..5,000`: continue directly to fetching.
4. Count `5,001..25,000`: enter `confirm`. A second activation of that same
   node/direction and generation continues; another selection, changed count,
   or reset clears confirmation.
5. Count `>25,000`: enter `blocked` with hard-stop copy and no edge request.
6. `fetching`: request one complete direction edge array, compact/dedupe/order
   it, discard the raw response, then hydrate the first batch.
7. `hydrating`: hydrate up to 25 candidates under provider rules, merge aliases,
   admit nodes/edges in stored order, then disclose the outcome.
8. Load more advances the local cursor, hydrates the next batch, and makes zero
   additional direction-edge requests.

An individual metadata miss must not erase a known edge. After its permitted
retry path, admit a minimal node with the best identifier and defensible edge
year and disclose incomplete metadata. If the miss is transient, retain the
failed compact candidates behind manual Retry so recovery rehydrates metadata
without refetching or recounting the edge list.

### Inspector and status

- Keep Crossref's nullable `is-referenced-by-count` copy distinct from
  OpenCitations known citation/reference totals.
- Never render an unavailable count as `0`.
- Keep the textual relationship lists as the screen-reader edge equivalent.
- Announce preflight, confirmation, edge fetch, hydration progress, safety
  stop, representative disclosure, timeline widening, incomplete metadata, and
  node-cap truncation without one status source erasing another.
- Existing Retry should replay precisely the failed search, count, edge,
  hydration, or detail operation.

### Staleness

Carry generation/selection checks through count, confirmation, edge fetch,
every singleton hydration, every Meta sub-batch, detail enrichment, and manual
Retry. Reset must release in-memory candidates and prevent queued old-generation
work from starting.

### Gate

Run unit tests and the search/expand/reset Playwright specs after their fixtures
are migrated in Task 5.

---

## Task 5: Rewrite browser contracts around the new providers

**Files**

- Rewrite: `tests/e2e/search.spec.mjs`
- Rewrite: `tests/e2e/expand.spec.mjs`
- Rewrite: `tests/e2e/errors.spec.mjs`
- Rewrite: `tests/e2e/reset.spec.mjs`
- Modify as needed: `tests/e2e/render.spec.mjs`
- Preserve and adapt: `tests/e2e/a11y.spec.mjs`,
  `tests/e2e/shell.spec.mjs`

### Required flows

- Text search and DOI-direct search use Crossref and seed the graph.
- Citation and reference expansions preflight, fetch exactly one edge request,
  hydrate from the permitted source, and render correct edge direction.
- Load more performs metadata requests as needed but no second edge request.
- Representative disclosure never contains “top.”
- Exact threshold boundaries:
  - 5,000 proceeds once;
  - 5,001 requires a second activation;
  - 25,000 can be confirmed;
  - 25,001 hard-stops with no edge request.
- Confirmation clears on reset/selection and is keyboard operable/announced.
- DOI-less OMID fallback batches at most 10; PMID-only minimal nodes survive.
- Crossref count proxy and OpenCitations totals can disagree without being
  conflated.
- Incoming `creation`, outgoing derived/confirmed year, same-year,
  future-dated, and undated gutter behavior.
- Duplicate clicks while busy, stale count/edge/hydration responses, and queued
  work dropped after reset.
- Provider-specific 404/429/5xx/network errors, independent provider backoff,
  Retry-After, retry exhaustion, and manual recovery.
- Partial metadata failure, localStorage quota/corruption fallback, node-cap
  partial admission, reduced motion, keyboard navigation, visible focus, and
  narrow-width inspector.

### Gate

```sh
npm test
npm run test:e2e
```

Both suites pass with all provider/CDN traffic stubbed and no live-network
dependency.

---

## Task 6: Remove S2 artifacts and document the data contract

**Files**

- Modify: `README.md`
- Verify: `index.html`, `robots.txt`, `CNAME`, `.github/workflows/test.yml`
- Delete if still present: `s2.js`, `tests/unit/s2-*.test.mjs`

### Work

- Document Crossref search/direct metadata, OpenCitations Index v2 edges/counts,
  and Meta's DOI-less OMID fallback.
- Document representative sampling, “known open” coverage wording, nullable
  Crossref proxy counts, 5,000 confirmation, 25,000 hard stop, provider pacing,
  and the browser-only privacy/cost model.
- Update the repository tree to `data.js` and remove every Semantic Scholar,
  S2, offset pool, and global-top reference.
- Verify the localStorage schema was bumped and legacy entries cannot be parsed
  as normalized records.

### Final verification

```sh
rg -n "Semantic Scholar|semanticscholar|S2Client|S2Error|nextOffset|POOL_LIMIT|showing top" \
  --glob '!docs/superpowers/**' .
npm test
npm run test:e2e
git diff --check
git status --short
```

The `rg` command must return no application/test/documentation matches outside
historical git data. Inspect the final diff to confirm no unrelated visual or
deployment changes entered the migration.

## Definition of done

- Search and DOI-direct lookup use Crossref only.
- Every expansion is count-preflighted and respects both safety thresholds.
- Each direction fetches its OpenCitations edge list at most once per graph
  generation; load more consumes the local deterministic order.
- DOI/OMID/PMID aliases prevent duplicate graph nodes.
- DOI nodes use Crossref singleton hydration; only DOI-less OMID nodes use Meta
  batches of at most 10.
- Crossref proxy counts remain nullable and separate from OpenCitations totals.
- No edge/candidate array is written to localStorage.
- Representative, accessibility, retry, reset, node-cap, and responsive
  contracts pass in Playwright.
- Unit and e2e suites are green with no live service dependency.
