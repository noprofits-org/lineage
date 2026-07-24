import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createState,
  addPaper,
  addEdge,
  newExpansion,
  completeFetch,
  admit,
  reconcileMetadataRetries,
  reconcileRetriedExpansion,
  disclosure,
  doiHref,
  NODE_CAP,
  BATCH,
} from '../../main.js'

const paper = (id, year, crossrefCitedByCount = null, openReferenceCount = null) => ({
  paperId: `doi:10.1000/${id}`,
  aliases: [`doi:10.1000/${id}`],
  doi: `10.1000/${id}`,
  omid: null,
  pmid: null,
  title: `T${id}`,
  year,
  yearSource: year == null ? null : 'crossref',
  authors: ['A'],
  venue: null,
  abstract: null,
  crossrefCitedByCount,
  openCitationCount: null,
  openReferenceCount,
  metadataSource: 'crossref',
  metadataIncomplete: false,
  detailsLoaded: true,
})

const candidate = (id, year) => ({
  paperId: `doi:10.1000/${id}`,
  doi: `10.1000/${id}`,
  aliases: [`doi:10.1000/${id}`],
  year,
  yearSource: year == null ? null : 'edge',
})

test('model constants match the graph limits', () => {
  assert.equal(NODE_CAP, 300)
  assert.equal(BATCH, 25)
})

test('createState returns an isolated empty graph', () => {
  const first = createState()
  const second = createState()
  assert.equal(first.gen, 0)
  assert.equal(first.selected, null)
  assert.equal(first.seedId, null)
  assert.equal(first.nodes.size, 0)
  assert.equal(first.edges.size, 0)
  assert.notEqual(first.nodes, second.nodes)
  assert.notEqual(first.edges, second.edges)
})

test('addPaper is idempotent and seeds provider-separated expansion totals', () => {
  const state = createState()
  const input = {
    ...paper('a', 1990, 10, 3),
    openCitationCount: 12,
  }
  const first = addPaper(state, input)
  const second = addPaper(state, input)

  assert.equal(first, second)
  assert.equal(state.nodes.size, 1)
  assert.equal(first.expansion.citations.preflightCount, 12)
  assert.equal(first.expansion.references.preflightCount, 3)
  assert.equal(first.expansion.references.status, 'idle')
})

test('addPaper merges alias collisions and upgrades identity to DOI priority', () => {
  const state = createState()
  const omidOnly = {
    ...paper('placeholder', 1990),
    paperId: 'omid:br/06123',
    doi: null,
    omid: 'omid:br/06123',
    aliases: ['omid:br/06123'],
    title: 'Identifier-only record',
    metadataSource: null,
    metadataIncomplete: true,
    detailsLoaded: false,
  }
  const crossref = {
    ...paper('canonical', 1991, 42),
    aliases: ['doi:10.1000/canonical', 'omid:br/06123'],
    omid: 'omid:br/06123',
    title: 'Hydrated title',
  }

  const first = addPaper(state, omidOnly)
  const merged = addPaper(state, crossref)
  assert.equal(first, merged)
  assert.equal(state.nodes.size, 1)
  assert.ok(state.nodes.has('doi:10.1000/canonical'))
  assert.equal(merged.paperId, 'doi:10.1000/canonical')
  assert.equal(merged.title, 'Hydrated title')
})

test('a late bridging alias merge rewires edges and preserves selection', () => {
  const state = createState()
  const doiNode = addPaper(state, paper('a', 2000))
  const omidNode = addPaper(state, {
    ...paper('b', 2001),
    paperId: 'omid:br/06222',
    doi: null,
    omid: 'omid:br/06222',
    aliases: ['omid:br/06222'],
  })
  state.selected = omidNode.paperId
  state.seedId = omidNode.paperId
  addEdge(state, doiNode.paperId, omidNode.paperId)

  const merged = addPaper(state, {
    ...paper('a', 2000),
    omid: 'omid:br/06222',
    aliases: ['doi:10.1000/a', 'omid:br/06222'],
  })

  assert.equal(state.nodes.size, 1)
  assert.equal(merged.paperId, 'doi:10.1000/a')
  assert.equal(state.selected, merged.paperId)
  assert.equal(state.seedId, merged.paperId)
  assert.equal(state.edges.size, 0, 'rewired self-edge is removed')
})

test('authoritative metadata resists placeholder and derived-year downgrades', () => {
  const state = createState()
  const rich = addPaper(state, {
    ...paper('rich', 2000, 77),
    title: 'Rich title',
    abstract: 'Authoritative abstract',
    yearSource: 'metadata',
    aliases: ['doi:10.1000/rich', 'omid:br/rich'],
    omid: 'omid:br/rich',
  })

  const merged = addPaper(state, {
    ...paper('placeholder', 1998),
    paperId: 'omid:br/rich',
    doi: null,
    omid: 'omid:br/rich',
    aliases: ['omid:br/rich'],
    title: 'OpenCitations record omid:br/rich',
    yearSource: 'derived',
    metadataSource: null,
    metadataIncomplete: true,
  })

  assert.equal(merged, rich)
  assert.equal(merged.title, 'Rich title')
  assert.equal(merged.year, 2000)
  assert.equal(merged.yearSource, 'metadata')
  assert.equal(merged.abstract, 'Authoritative abstract')
  assert.equal(merged.metadataSource, 'crossref')
  assert.equal(merged.metadataIncomplete, false)
})

test('newExpansion exposes the candidate cursor and large-fetch confirmation state', () => {
  const expansion = newExpansion(null)
  assert.equal(expansion.status, 'idle')
  assert.equal(expansion.preflightCount, null)
  assert.equal(expansion.confirmation, null)
  assert.equal(expansion.displayedCount, 0)
  assert.deepEqual(expansion.candidates, [])
  assert.equal(expansion.cursor, 0)
  assert.equal(expansion.candidateCount, null)
  assert.equal(expansion.exhausted, false)
})

test('addEdge dedupes and rejects self-loops', () => {
  const state = createState()
  assert.equal(addEdge(state, 'x', 'y'), true)
  assert.equal(addEdge(state, 'x', 'y'), false)
  assert.equal(addEdge(state, 'x', 'x'), false)
  assert.deepEqual(state.edges.get('x→y'), { citing: 'x', cited: 'y' })
})

test('completeFetch stores the full, deduped temporal candidate set and known link total', () => {
  const expansion = newExpansion(4)
  completeFetch(expansion, {
    candidates: [
      candidate('new', 2020),
      candidate('old', 1900),
      candidate('undated', null),
      candidate('old', 1900),
    ],
    totalLinks: 3,
  })

  assert.equal(expansion.candidateCount, 3)
  assert.equal(expansion.candidates.length, 3)
  assert.equal(new Set(expansion.candidates.map(value => value.paperId)).size, 3)
  assert.equal(expansion.cursor, 0)
  assert.equal(expansion.exhausted, false)
})

test('completeFetch merges candidates connected by any overlapping alias', () => {
  const expansion = newExpansion(2)
  completeFetch(expansion, {
    candidates: [
      {
        ...candidate('a', 2000),
        aliases: ['doi:10.1000/a', 'doi:10.1000/b'],
      },
      candidate('b', 2001),
    ],
    totalLinks: 2,
  })

  assert.equal(expansion.candidateCount, 1)
  assert.equal(expansion.candidates[0].paperId, 'doi:10.1000/a')
  assert.deepEqual(expansion.candidates[0].aliases, [
    'doi:10.1000/a',
    'doi:10.1000/b',
  ])
})

test('late bridging aliases merge loaded expansion candidates and cursors', () => {
  const state = createState()
  const left = addPaper(state, paper('left', 2000))
  const right = addPaper(state, {
    ...paper('right', 2001),
    paperId: 'omid:br/right',
    doi: null,
    omid: 'omid:br/right',
    aliases: ['omid:br/right'],
    metadataSource: null,
  })
  completeFetch(left.expansion.citations, {
    candidates: [candidate('c1', 1990), candidate('c2', 1991)],
    totalLinks: 2,
  })
  left.expansion.citations.cursor = 1
  left.expansion.citations.displayedCount = 1
  completeFetch(right.expansion.citations, {
    candidates: [candidate('c2', 1991), candidate('c3', 1992)],
    totalLinks: 2,
  })
  right.expansion.citations.cursor = 1
  right.expansion.citations.displayedCount = 1

  const merged = addPaper(state, {
    ...paper('left', 2000),
    omid: 'omid:br/right',
    aliases: ['doi:10.1000/left', 'omid:br/right'],
  })
  const expansion = merged.expansion.citations
  assert.equal(state.nodes.size, 1)
  assert.equal(expansion.candidateCount, 3)
  assert.equal(expansion.cursor, 2)
  assert.equal(expansion.displayedCount, 2)
  assert.equal(expansion.exhausted, false)
  assert.deepEqual(
    new Set(expansion.candidates.map(value => value.paperId)),
    new Set(['doi:10.1000/c1', 'doi:10.1000/c2', 'doi:10.1000/c3']),
  )
})

test('alias merges cancel transient expansion work while preserving settled progress', () => {
  const state = createState()
  const canonical = addPaper(state, paper('canonical', 2000))
  const duplicate = addPaper(state, {
    ...paper('duplicate', 2001),
    paperId: 'omid:br/transient',
    doi: null,
    omid: 'omid:br/transient',
    aliases: ['omid:br/transient'],
    metadataSource: null,
  })
  const canonicalToken = {}
  const duplicateToken = {}
  canonical.expansion.citations._workToken = canonicalToken
  canonical.expansion.citations.status = 'hydrating'
  duplicate.expansion.citations._workToken = duplicateToken
  duplicate.expansion.citations.status = 'preflighting'
  duplicate.expansion.citations.preflightCount = 9
  duplicate.expansion.citations._metadataRetryCandidates = [candidate('retry', 1999)]

  const merged = addPaper(state, {
    ...paper('canonical', 2000),
    omid: 'omid:br/transient',
    aliases: ['doi:10.1000/canonical', 'omid:br/transient'],
  })

  assert.equal(state.nodes.size, 1)
  assert.equal(merged.expansion.citations.status, 'idle')
  assert.equal(merged.expansion.citations._workToken, null)
  assert.equal(duplicate.expansion.citations._workToken, null)
  assert.equal(merged.expansion.citations.confirmation, null)
  assert.equal(merged.expansion.citations.preflightCount, 9)
  assert.equal(merged.expansion.citations._metadataRetryCandidates.length, 1)
})

test('admit consumes at most one hydrated batch and wires both edge directions', () => {
  const state = createState()
  const seed = addPaper(state, paper('seed', 1953, 443, 6))
  seed.expansion.citations.pool = Array.from(
    { length: 30 },
    (_, index) => paper(`c${index}`, 1960 + index, 30 - index),
  )

  const citationResult = admit(state, seed, 'citations')
  assert.equal(citationResult.admitted.length, BATCH)
  assert.equal(citationResult.requested, BATCH)
  assert.equal(seed.expansion.citations.displayedCount, BATCH)
  assert.ok(state.edges.has('doi:10.1000/c0→doi:10.1000/seed'))

  seed.expansion.references.pool = [paper('r0', 1949, 9)]
  admit(state, seed, 'references')
  assert.ok(state.edges.has('doi:10.1000/seed→doi:10.1000/r0'))
})

test('hydration-time aliases collapse same-batch candidates before counting them', () => {
  const state = createState()
  const seed = addPaper(state, paper('seed', 1953))
  const first = {
    paperId: 'omid:br/first',
    aliases: ['omid:br/first'],
    doi: null,
    omid: 'omid:br/first',
    year: 1960,
    yearSource: 'edge',
  }
  const second = {
    ...first,
    paperId: 'omid:br/second',
    aliases: ['omid:br/second'],
    omid: 'omid:br/second',
    year: 1961,
  }
  completeFetch(seed.expansion.citations, {
    candidates: [first, second],
    totalLinks: 2,
  })
  const hydrated = [first, second].map((value, index) => ({
    ...paper('shared', 1960 + index),
    omid: value.omid,
    aliases: ['doi:10.1000/shared', value.omid],
  }))

  const result = admit(state, seed, 'citations', hydrated)
  const expansion = seed.expansion.citations

  assert.equal(result.requested, 1)
  assert.equal(result.admitted.length, 1)
  assert.equal(state.nodes.size, 2)
  assert.equal(state.edges.size, 1)
  assert.equal(expansion.candidates.length, 1)
  assert.equal(expansion.candidateCount, 1)
  assert.equal(expansion.cursor, 1)
  assert.equal(expansion.displayedCount, 1)
  assert.equal(expansion.exhausted, true)
  assert.equal(seed.openCitationCount, 1)
  const neighbor = state.nodes.get('doi:10.1000/shared')
  assert.ok(neighbor.aliases.includes('omid:br/first'))
  assert.ok(neighbor.aliases.includes('omid:br/second'))
  assert.equal(disclosure(expansion, 'citations'), 'showing 1 of 1 known open citations')
})

test('candidate aliases already mapped to one graph node count as one identity', () => {
  const state = createState()
  const seed = addPaper(state, paper('seed', 1953))
  addPaper(state, {
    ...paper('known-neighbor', 1960),
    paperId: 'omid:br/known-a',
    doi: null,
    omid: 'omid:br/known-a',
    aliases: ['omid:br/known-a', 'omid:br/known-b'],
  })
  const candidates = ['a', 'b'].map(id => ({
    paperId: `omid:br/known-${id}`,
    doi: null,
    omid: `omid:br/known-${id}`,
    aliases: [`omid:br/known-${id}`],
    year: 1960,
    yearSource: 'edge',
  }))
  completeFetch(seed.expansion.citations, { candidates, totalLinks: 2 })
  const hydrated = candidates.map((value, index) => ({
    ...value,
    title: `Known variant ${index}`,
    authors: [],
    metadataSource: 'opencitations-meta',
    metadataIncomplete: false,
    metadataRetryable: false,
    detailsLoaded: true,
  }))

  const result = admit(state, seed, 'citations', hydrated)

  assert.equal(result.requested, 1)
  assert.equal(result.admitted.length, 1)
  assert.equal(seed.expansion.citations.candidateCount, 1)
  assert.equal(seed.expansion.citations.cursor, 1)
  assert.equal(seed.expansion.citations.displayedCount, 1)
  assert.equal(state.nodes.size, 2)
  assert.equal(state.edges.size, 1)
})

test('a hydrated alias bridge coalesces every graph node before admission', () => {
  const state = createState()
  const seed = addPaper(state, paper('seed', 1953))
  addPaper(state, {
    ...paper('existing-x', 1960),
    omid: 'omid:br/x',
    aliases: ['doi:10.1000/existing-x', 'omid:br/x'],
  })
  addPaper(state, {
    ...paper('existing-y', 1961),
    omid: 'omid:br/y1',
    aliases: [
      'doi:10.1000/existing-y',
      'omid:br/y1',
      'omid:br/y2',
    ],
  })
  const candidates = ['a', 'b'].map(id => ({
    paperId: `omid:br/candidate-${id}`,
    doi: null,
    omid: `omid:br/candidate-${id}`,
    aliases: [`omid:br/candidate-${id}`],
    year: 1962,
    yearSource: 'edge',
  }))
  completeFetch(seed.expansion.citations, { candidates, totalLinks: 2 })
  const hydrated = [
    {
      ...paper('bridge-a', 1962),
      omid: 'omid:br/x',
      aliases: [
        'doi:10.1000/bridge-a',
        'omid:br/x',
        'omid:br/y1',
      ],
    },
    {
      ...paper('bridge-b', 1962),
      omid: 'omid:br/y2',
      aliases: ['doi:10.1000/bridge-b', 'omid:br/y2'],
    },
  ]

  const result = admit(state, seed, 'citations', hydrated)
  const expansion = seed.expansion.citations

  assert.equal(result.requested, 1)
  assert.equal(result.admitted.length, 1)
  assert.equal(expansion.candidateCount, 1)
  assert.equal(expansion.cursor, 1)
  assert.equal(expansion.displayedCount, 1)
  assert.equal(expansion.exhausted, true)
  assert.equal(state.nodes.size, 2)
  assert.equal(state.edges.size, 1)
})

test('a later hydrated alias collapse does not advance an already displayed identity twice', () => {
  const state = createState()
  const seed = addPaper(state, paper('seed', 1953))
  const first = {
    paperId: 'omid:br/later-first',
    aliases: ['omid:br/later-first'],
    doi: null,
    omid: 'omid:br/later-first',
    year: 1960,
    yearSource: 'edge',
  }
  const second = {
    ...first,
    paperId: 'omid:br/later-second',
    aliases: ['omid:br/later-second'],
    omid: 'omid:br/later-second',
    year: 1961,
  }
  completeFetch(seed.expansion.citations, {
    candidates: [first, second],
    totalLinks: 2,
  })
  admit(state, seed, 'citations', [{
    ...paper('later-shared', 1960),
    omid: first.omid,
    aliases: ['doi:10.1000/later-shared', first.omid],
  }])
  assert.equal(seed.expansion.citations.cursor, 1)

  const result = admit(state, seed, 'citations', [{
    ...paper('later-shared', 1961),
    omid: second.omid,
    aliases: ['doi:10.1000/later-shared', second.omid],
  }])

  assert.equal(result.requested, 0)
  assert.equal(result.admitted.length, 0)
  assert.equal(seed.expansion.citations.candidateCount, 1)
  assert.equal(seed.expansion.citations.cursor, 1)
  assert.equal(seed.expansion.citations.displayedCount, 1)
  assert.equal(state.nodes.size, 2)
  assert.equal(state.edges.size, 1)
})

test('metadata retry reconciliation keeps older failures across healthy later batches', () => {
  const failedA = {
    ...candidate('a', 2000),
    aliases: ['doi:10.1000/a', 'omid:br/a'],
  }
  const healthyB = candidate('b', 2001)
  const aliasDuplicate = {
    ...candidate('alias', 2000),
    aliases: ['omid:br/a'],
    paperId: 'omid:br/a',
    doi: null,
    omid: 'omid:br/a',
  }

  const first = reconcileMetadataRetries([], [failedA], [failedA, aliasDuplicate])
  const afterLoadMore = reconcileMetadataRetries(first, [healthyB], [])
  const afterRecovery = reconcileMetadataRetries(afterLoadMore, [failedA], [])

  assert.equal(first.length, 1)
  assert.equal(afterLoadMore.length, 1)
  assert.equal(afterLoadMore[0].paperId, 'doi:10.1000/a')
  assert.deepEqual(afterRecovery, [])
})

test('manual metadata repair reconciles newly discovered aliases into expansion totals', () => {
  const state = createState()
  const seed = addPaper(state, paper('seed', 1953))
  const candidates = ['retry-a', 'retry-b'].map(id => ({
    paperId: `omid:br/${id}`,
    doi: null,
    omid: `omid:br/${id}`,
    aliases: [`omid:br/${id}`],
    year: 1960,
    yearSource: 'edge',
  }))
  completeFetch(seed.expansion.citations, { candidates, totalLinks: 2 })
  const placeholders = candidates.map(value => ({
    ...value,
    title: `OpenCitations record ${value.omid}`,
    authors: [],
    metadataSource: null,
    metadataIncomplete: true,
    metadataRetryable: true,
    detailsLoaded: false,
  }))
  admit(state, seed, 'citations', placeholders)
  const repaired = candidates.map((value, index) => ({
    ...paper('retry-shared', 1960 + index),
    omid: value.omid,
    aliases: ['doi:10.1000/retry-shared', value.omid],
  }))
  for (const repairedPaper of repaired) addPaper(state, repairedPaper)

  reconcileRetriedExpansion(
    state,
    seed,
    'citations',
    candidates,
    repaired,
  )

  assert.equal(seed.expansion.citations.candidateCount, 1)
  assert.equal(seed.expansion.citations.cursor, 1)
  assert.equal(seed.expansion.citations.displayedCount, 1)
  assert.equal(seed.expansion.citations.exhausted, true)
  assert.equal(seed.openCitationCount, 1)
  assert.equal(state.nodes.size, 2)
  assert.equal(state.edges.size, 1)
})

test('admit partially admits at the node cap without charging existing nodes', () => {
  const state = createState()
  const seed = addPaper(state, paper('seed', 1953))
  addPaper(state, paper('existing', 1960))
  seed.expansion.citations.pool = [
    paper('existing', 1960),
    ...Array.from({ length: 25 }, (_, index) => paper(`new${index}`, 1970 + index)),
  ]

  const result = admit(state, seed, 'citations', { cap: 4 })
  assert.equal(result.admitted.length, 3)
  assert.equal(result.capped, true)
  assert.ok(state.edges.has('doi:10.1000/existing→doi:10.1000/seed'))
  assert.equal(state.nodes.size, 4)
})

test('disclosure distinguishes known open links from reported count and never claims top rank', () => {
  const complete = newExpansion(7)
  Object.assign(complete, {
    candidateCount: 7,
    displayedCount: 7,
    cursor: 7,
    exhausted: true,
  })
  assert.equal(disclosure(complete, 'references'), 'showing 7 of 7 known open references')

  const representative = newExpansion(11_144)
  Object.assign(representative, {
    candidateCount: 11_144,
    displayedCount: 25,
    cursor: 25,
    exhausted: false,
  })
  assert.equal(
    disclosure(representative, 'citations'),
    'showing 25 representative citations from 11,144 known open citation links',
  )
  assert.doesNotMatch(disclosure(representative, 'citations'), /top/i)
})

test('doiHref preserves DOI slashes while escaping query and fragment delimiters', () => {
  assert.equal(
    doiHref('10.1234/a?b#c%25'),
    'https://doi.org/10.1234/a%3Fb%23c%2525',
  )
})
