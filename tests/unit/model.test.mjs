import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createState,
  addPaper,
  addEdge,
  newExpansion,
  rankPool,
  completeFetch,
  admit,
  disclosure,
  NODE_CAP,
  BATCH,
} from '../../main.js'

const paper = (id, year, citationCount = 0, referenceCount = 0) => ({
  paperId: id,
  title: `T${id}`,
  year,
  authors: ['A'],
  venue: null,
  abstract: null,
  citationCount,
  referenceCount,
  doi: null,
})

test('model constants match the graph limits', () => {
  assert.equal(NODE_CAP, 300)
  assert.equal(BATCH, 25)
})

test('createState returns an isolated, empty graph state', () => {
  const first = createState()
  const second = createState()

  assert.deepEqual(
    { gen: first.gen, selected: first.selected, seedId: first.seedId },
    { gen: 0, selected: null, seedId: null },
  )
  assert.equal(first.nodes.size, 0)
  assert.equal(first.edges.size, 0)
  assert.notEqual(first.nodes, second.nodes)
  assert.notEqual(first.edges, second.edges)
})

test('addPaper is idempotent and attaches expansion state', () => {
  const state = createState()
  const first = addPaper(state, paper('a', 1990, 10, 3))
  const second = addPaper(state, paper('a', 1990, 10, 3))

  assert.equal(first, second)
  assert.equal(state.nodes.size, 1)
  assert.equal(first.expansion.citations.total, 10)
  assert.equal(first.expansion.references.total, 3)
  assert.equal(first.expansion.references.status, 'idle')
})

test('newExpansion starts at offset zero with a distinct empty pool', () => {
  const first = newExpansion(9)
  const second = newExpansion(4)

  assert.deepEqual(first, {
    status: 'idle',
    nextOffset: 0,
    fetchedCount: 0,
    displayedCount: 0,
    total: 9,
    exhausted: false,
    pool: [],
  })
  assert.notEqual(first.pool, second.pool)
})

test('addEdge dedupes and rejects self-loops', () => {
  const state = createState()

  assert.equal(addEdge(state, 'x', 'y'), true)
  assert.equal(addEdge(state, 'x', 'y'), false)
  assert.equal(addEdge(state, 'x', 'x'), false)
  assert.equal(state.edges.size, 1)
  assert.deepEqual(state.edges.get('x→y'), { citing: 'x', cited: 'y' })
})

test('rankPool sorts by citationCount descending without mutating input', () => {
  const input = [
    paper('low', 2000, 5),
    paper('high', 2000, 500),
    paper('mid', 2000, 50),
  ]
  const output = rankPool(input)

  assert.deepEqual(output.map(item => item.paperId), ['high', 'mid', 'low'])
  assert.equal(input[0].paperId, 'low')
  assert.notEqual(output, input)
})

test('rankPool preserves input order for equal citation counts', () => {
  const input = [paper('first', 2000, 10), paper('second', 2001, 10)]
  assert.deepEqual(rankPool(input).map(item => item.paperId), ['first', 'second'])
})

test('completeFetch merges pages ranked and uses next as completeness authority', () => {
  const expansion = newExpansion(443)

  expansion.status = 'loading'
  completeFetch(expansion, {
    papers: [paper('a', 1990, 1), paper('b', 1990, 100)],
    next: 500,
  })
  assert.equal(expansion.status, 'idle')
  assert.equal(expansion.fetchedCount, 2)
  assert.equal(expansion.exhausted, false)
  assert.equal(expansion.nextOffset, 500)

  completeFetch(expansion, { papers: [paper('c', 1991, 50)], next: null })
  assert.equal(expansion.exhausted, true)
  assert.equal(expansion.nextOffset, null)
  assert.deepEqual(expansion.pool.map(item => item.paperId), ['b', 'c', 'a'])
})

test('completeFetch treats an absent next offset as exhaustion', () => {
  const expansion = newExpansion(1)
  completeFetch(expansion, { papers: [paper('a', 1990)], next: undefined })
  assert.equal(expansion.exhausted, true)
  assert.equal(expansion.nextOffset, null)
})

test('admit takes the top batch in rank order and wires both edge directions', () => {
  const state = createState()
  const seed = addPaper(state, paper('seed', 1953, 443, 6))
  const citations = seed.expansion.citations

  completeFetch(citations, {
    papers: Array.from(
      { length: 30 },
      (_, index) => paper(`c${index}`, 1960, 30 - index),
    ),
    next: null,
  })
  const { admitted, capped, requested } = admit(state, seed, 'citations')

  assert.equal(admitted.length, BATCH)
  assert.equal(requested, BATCH)
  assert.equal(capped, false)
  assert.equal(citations.displayedCount, BATCH)
  assert.equal(citations.pool.length, 5)
  assert.ok(state.edges.has('c0→seed'))

  const references = seed.expansion.references
  completeFetch(references, {
    papers: [paper('r0', 1949, 9)],
    next: null,
  })
  admit(state, seed, 'references')
  assert.ok(state.edges.has('seed→r0'))
})

test('admit at node cap partially admits in rank order', () => {
  const state = createState()
  const seed = addPaper(state, paper('seed', 1953, 443, 6))
  const expansion = seed.expansion.citations

  completeFetch(expansion, {
    papers: Array.from(
      { length: 25 },
      (_, index) => paper(`c${index}`, 1960, 25 - index),
    ),
    next: null,
  })
  const { admitted, capped, requested } = admit(
    state,
    seed,
    'citations',
    { cap: 11 },
  )

  assert.equal(admitted.length, 10)
  assert.equal(capped, true)
  assert.equal(requested, 25)
  assert.deepEqual(
    admitted.map(node => node.paperId),
    Array.from({ length: 10 }, (_, index) => `c${index}`),
  )
})

test('cap disclosure request count is one batch, not the entire fetched pool', () => {
  const state = createState()
  const seed = addPaper(state, paper('seed', 1953))
  completeFetch(seed.expansion.citations, {
    papers: Array.from(
      { length: 80 },
      (_, index) => paper(`c${index}`, 1960, 80 - index),
    ),
    next: null,
  })

  const result = admit(state, seed, 'citations', { cap: 4 })
  assert.equal(result.admitted.length, 3)
  assert.equal(result.requested, BATCH)
  assert.equal(result.capped, true)
})

test('papers already in the graph do not consume cap and still gain edges', () => {
  const state = createState()
  const seed = addPaper(state, paper('seed', 1953, 443, 6))
  addPaper(state, paper('c0', 1960, 99))
  const expansion = seed.expansion.citations

  completeFetch(expansion, {
    papers: [paper('c0', 1960, 99)],
    next: null,
  })
  const { admitted, capped } = admit(state, seed, 'citations', { cap: 2 })

  assert.equal(admitted.length, 1)
  assert.equal(capped, false)
  assert.ok(state.edges.has('c0→seed'))
})

test('disclosure returns the three exact truthfulness tiers', () => {
  const completeAndMatching = newExpansion(443)
  completeFetch(completeAndMatching, {
    papers: Array.from(
      { length: 443 },
      (_, index) => paper(`p${index}`, 1960, index),
    ),
    next: null,
  })
  completeAndMatching.displayedCount = 25
  assert.equal(
    disclosure(completeAndMatching, 'citations'),
    'showing top 25 of 443 citations',
  )

  const completeButMismatched = newExpansion(443)
  completeFetch(completeButMismatched, {
    papers: Array.from(
      { length: 431 },
      (_, index) => paper(`p${index}`, 1960, index),
    ),
    next: null,
  })
  completeButMismatched.displayedCount = 25
  assert.equal(
    disclosure(completeButMismatched, 'citations'),
    'showing 25 of 431 available papers (443 citations reported)',
  )

  const incomplete = newExpansion(8412)
  completeFetch(incomplete, {
    papers: Array.from(
      { length: 500 },
      (_, index) => paper(`p${index}`, 1960, index),
    ),
    next: 500,
  })
  incomplete.displayedCount = 25
  assert.equal(
    disclosure(incomplete, 'citations'),
    'showing top 25 of the first 500 fetched (8,412 total)',
  )
})
