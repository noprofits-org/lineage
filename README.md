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
