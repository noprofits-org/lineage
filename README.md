# Lineage

A citation explorer, served at **lineage.pvjohnston.com**. Search any paper
through [Crossref](https://www.crossref.org/), then expand what it cites and
who cites it through the [OpenCitations Index](https://opencitations.net/index).
Papers are pinned to a year axis, so citation lineage reads left-to-right as a
genealogy of ideas.

Edges encode citation, from the citing paper to the cited paper — usually,
but not always, newer to older. Read the graph left-to-right as intellectual
influence.

## Architecture

Single page, no build step. `index.html` loads ES modules directly:

```
index.html       # site root
├── main.js      # controller + graph model (state, sampling, disclosure)
├── data.js      # Crossref + OpenCitations clients, queues, retry, cache
├── graph.js     # D3 renderer: year-pinned x, force-managed y
└── lineage.css  # the entire theme (ink on paper)
```

- D3 v7 from the CDN with Subresource Integrity.
- Crossref provides search and DOI metadata. OpenCitations provides known open
  citation/reference links; its Meta API is used only for DOI-less OMID nodes.
- Both sources are keyless and called directly from the browser. Independent
  paced queues honor each public service's limits and retry transient errors.
- Neighbor batches are selected deterministically across the available time
  range before metadata hydration. “Representative” never means globally top
  cited, and Crossref's cited-by proxy is kept separate from OpenCitations link
  totals.
- Papers stay pinned to their publication year but can be dragged vertically.
  A node-spacing control adjusts automatic collision separation, and reflow
  restores the automatic vertical layout.
- Expansions above 5,000 links require a second activation; expansions above
  25,000 stop at a browser-safety boundary. Raw edge arrays are never written
  to `localStorage`.
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
