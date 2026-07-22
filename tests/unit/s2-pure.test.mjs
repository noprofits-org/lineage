import test from 'node:test'
import assert from 'node:assert/strict'
import {
  backoffDelay,
  mapConnections,
  mapPaper,
  isRetryable,
  MAX_ATTEMPTS,
  POOL_LIMIT,
} from '../../s2.js'

test('mapPaper normalizes a raw record', () => {
  const paper = mapPaper({
    paperId: 'abc',
    title: 'T',
    year: 1953,
    authors: [{ name: 'J. Watson' }, { name: null }],
    venue: 'Nature',
    citationCount: 443,
    referenceCount: 6,
    externalIds: { DOI: '10.1038/171737a0' },
  })

  assert.deepEqual(paper, {
    paperId: 'abc',
    title: 'T',
    year: 1953,
    authors: ['J. Watson'],
    venue: 'Nature',
    abstract: null,
    citationCount: 443,
    referenceCount: 6,
    doi: '10.1038/171737a0',
  })
})

test('mapPaper uses safe defaults and rejects records without an id', () => {
  assert.equal(mapPaper({ paperId: 'x', title: 'T' }).year, null)
  assert.equal(mapPaper({ paperId: 'x', title: 'T' }).citationCount, 0)
  assert.deepEqual(mapPaper({ paperId: 'x', title: '', authors: {} }).authors, [])
  assert.equal(mapPaper({ paperId: null, title: 'T' }), null)
  assert.equal(mapPaper(null), null)
})

test('mapConnections unwraps citingPaper/citedPaper and next', () => {
  const citations = mapConnections({
    offset: 0,
    data: [{ citingPaper: { paperId: 'c1', title: 'C' } }],
    next: 500,
  }, 'citations')
  assert.equal(citations.papers[0].paperId, 'c1')
  assert.equal(citations.next, 500)

  const references = mapConnections({
    offset: 0,
    data: [{ citedPaper: { paperId: 'r1', title: 'R' } }],
  }, 'references')
  assert.equal(references.papers[0].paperId, 'r1')
  assert.equal(references.next, null)
})

test('mapConnections drops tombstones and tolerates a missing data array', () => {
  const output = mapConnections({
    data: [{ citedPaper: null }, { citedPaper: { paperId: 'ok', title: 'T' } }],
  }, 'references')
  assert.equal(output.papers.length, 1)
  assert.deepEqual(mapConnections(null, 'citations'), { papers: [], next: null })
})

test('mapConnections rejects an unknown direction', () => {
  assert.throws(() => mapConnections({ data: [] }, 'incoming'), RangeError)
})

test('isRetryable accepts 429, 5xx, and network errors, but not ordinary 4xx', () => {
  assert.equal(isRetryable(429), true)
  assert.equal(isRetryable(500), true)
  assert.equal(isRetryable(503), true)
  assert.equal(isRetryable(0), true)
  assert.equal(isRetryable(400), false)
  assert.equal(isRetryable(404), false)
})

test('backoffDelay honors Retry-After and otherwise uses capped full jitter', () => {
  assert.equal(backoffDelay(0, 7), 7000)
  assert.equal(backoffDelay(0, 90), 30000)
  assert.equal(backoffDelay(0, null, () => 0.5), 500)
  assert.equal(backoffDelay(2, null, () => 0.5), 2000)
  assert.equal(backoffDelay(10, null, () => 0.999), 29970)
  assert.equal(backoffDelay(0, -4, () => 0.5), 500)
})

test('constants match the API contract', () => {
  assert.equal(POOL_LIMIT, 500)
  assert.equal(MAX_ATTEMPTS, 4)
})
