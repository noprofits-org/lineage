import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeDoi,
  parsePidBundle,
  mapCrossrefWork,
  mapOpenCitationsEdges,
  mapMetaRecord,
  mapOpenCitationsCount,
  deriveReferencedYear,
  temporalOrder,
  isRetryable,
  backoffDelay,
  MAX_ATTEMPTS,
  CROSSREF_SEARCH_PACE_MS,
  CROSSREF_DETAIL_PACE_MS,
  OC_PACE_MS,
  META_BATCH_MAX,
} from '../../data.js'

test('normalizeDoi removes common wrappers and canonicalizes case', () => {
  assert.equal(normalizeDoi(' DOI:10.1000/ABC.Def '), '10.1000/abc.def')
  assert.equal(normalizeDoi('https://doi.org/10.1000/A%2FB'), '10.1000/a/b')
  assert.equal(normalizeDoi('not-a-doi'), null)
  assert.equal(normalizeDoi(null), null)
})

test('parsePidBundle prefers DOI, then OMID, then PMID and preserves aliases', () => {
  const withDoi = parsePidBundle(
    'omid:br/06123 DOI:10.1000/ABC openalex:W1 pmid:42 doi:10.1000/abc',
  )
  assert.equal(withDoi.paperId, 'doi:10.1000/abc')
  assert.equal(withDoi.doi, '10.1000/abc')
  assert.deepEqual(withDoi.dois, ['10.1000/abc'])
  assert.equal(withDoi.omid, 'omid:br/06123')
  assert.equal(withDoi.pmid, 'pmid:42')
  assert.deepEqual(withDoi.aliases, [
    'doi:10.1000/abc',
    'omid:br/06123',
    'openalex:w1',
    'pmid:42',
  ])

  assert.equal(parsePidBundle('omid:br/0699 pmid:7').paperId, 'omid:br/0699')
  assert.equal(parsePidBundle('pmid:7').paperId, 'pmid:7')
  assert.equal(
    parsePidBundle(
      'doi:10.1002/(SICI)1097-0142(19991201)86:11<2481::AID-CNCR7>3.0.CO;2-A omid:br/0700',
    ).doi,
    '10.1002/(sici)1097-0142(19991201)86:11<2481::aid-cncr7>3.0.co;2-a',
  )
  assert.equal(parsePidBundle('').paperId, null)
})

test('mapCrossrefWork normalizes arrays, date-parts, JATS abstract, and proxy counts', () => {
  const paper = mapCrossrefWork({
    DOI: '10.1038/ABC',
    title: ['A paper'],
    author: [
      { given: 'Jane Q.', family: 'Doe' },
      { name: 'Consortium Name' },
      { family: 'Solo' },
    ],
    published: { 'date-parts': [[1953, 4, 25]] },
    'container-title': ['Nature'],
    abstract: '<jats:p>A <jats:italic>double</jats:italic> helix.</jats:p>',
    'is-referenced-by-count': 443,
    'reference-count': 6,
  })

  assert.equal(paper.paperId, 'doi:10.1038/abc')
  assert.equal(paper.doi, '10.1038/abc')
  assert.equal(paper.title, 'A paper')
  assert.equal(paper.year, 1953)
  assert.deepEqual(paper.authors, ['Jane Q. Doe', 'Consortium Name', 'Solo'])
  assert.equal(paper.venue, 'Nature')
  assert.equal(paper.abstract, 'A double helix.')
  assert.equal(paper.crossrefCitedByCount, 443)
  assert.equal(paper.openCitationCount, null)
  assert.equal(paper.openReferenceCount, null)
  assert.deepEqual(paper.aliases, ['doi:10.1038/abc'])
  assert.equal(mapCrossrefWork({
    DOI: '10.1000/entity',
    title: ['Safe &#999999999; title'],
  }).title, 'Safe � title')
})

test('mapCrossrefWork uses safe nullable defaults and rejects records without a DOI', () => {
  const paper = mapCrossrefWork({ DOI: '10.1000/x', title: [] })
  assert.equal(paper.title, 'Untitled')
  assert.equal(paper.year, null)
  assert.deepEqual(paper.authors, [])
  assert.equal(paper.venue, null)
  assert.equal(paper.abstract, null)
  assert.equal(paper.crossrefCitedByCount, null)
  assert.equal(paper.openCitationCount, null)
  assert.equal(paper.openReferenceCount, null)
  assert.equal(mapCrossrefWork({
    DOI: '10.1000/null-counts',
    'is-referenced-by-count': null,
    'reference-count': '',
  }).crossrefCitedByCount, null)
  assert.equal(mapCrossrefWork({ title: ['No identifier'] }), null)
  assert.equal(mapCrossrefWork(null), null)
})

test('deriveReferencedYear handles partial creation dates and ISO durations defensively', () => {
  assert.equal(deriveReferencedYear('2021-03-10', 'P6Y0M1D'), 2015)
  assert.equal(deriveReferencedYear('1953-04', 'P3Y2M'), 1950)
  assert.equal(deriveReferencedYear('1953', 'P4Y'), 1949)
  assert.equal(deriveReferencedYear('1953', 'P4Y1M'), null)
  assert.equal(deriveReferencedYear('1953-04', 'P3Y2M1D'), null)
  assert.equal(deriveReferencedYear('1953-04-25', '-P1Y'), null)
  assert.equal(deriveReferencedYear('2021-02-31', 'P1Y'), null)
  assert.equal(deriveReferencedYear('2021-99-01', 'P1Y'), null)
  assert.equal(deriveReferencedYear('1953-04-25', 'PT1H'), null)
  assert.equal(deriveReferencedYear('', 'P4Y'), null)
  assert.equal(deriveReferencedYear('1953', ''), null)
  assert.equal(deriveReferencedYear('bad', 'also-bad'), null)
})

test('mapOpenCitationsEdges selects the connected PID, dedupes, and derives time hints', () => {
  const rows = [
    {
      citing: 'doi:10.1000/c1 omid:br/061',
      cited: 'doi:10.1000/seed omid:br/060',
      creation: '2021-03-10',
      timespan: 'P6Y0M1D',
    },
    {
      citing: 'omid:br/061 doi:10.1000/C1',
      cited: 'doi:10.1000/seed',
      creation: '2021',
      timespan: 'P6Y',
    },
    {
      citing: 'doi:10.1000/seed',
      cited: 'omid:br/062',
      creation: '1953-04-25',
      timespan: 'P4Y0M0D',
    },
    { citing: '', cited: '', creation: '', timespan: '' },
  ]

  const citations = mapOpenCitationsEdges(rows.slice(0, 2), 'citations')
  assert.equal(citations.length, 1)
  assert.equal(citations[0].paperId, 'doi:10.1000/c1')
  assert.equal(citations[0].year, 2021)
  assert.equal(citations[0].yearSource, 'edge')

  const references = mapOpenCitationsEdges(rows.slice(2), 'references')
  assert.equal(references.length, 1)
  assert.equal(references[0].paperId, 'omid:br/062')
  assert.equal(references[0].year, 1949)
  assert.equal(references[0].yearSource, 'derived')
  assert.throws(() => mapOpenCitationsEdges([], 'incoming'), RangeError)
})

test('edge dedupe merges DOI aliases through a shared OMID and chooses a canonical DOI', () => {
  const candidates = mapOpenCitationsEdges([
    {
      citing: 'omid:br/061 doi:10.1000/V2',
      cited: 'doi:10.1000/seed',
      creation: '2020',
      timespan: 'P1Y',
    },
    {
      citing: 'doi:10.1000/v1 omid:br/061',
      cited: 'doi:10.1000/seed',
      creation: '2020',
      timespan: 'P1Y',
    },
  ], 'citations')

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].paperId, 'doi:10.1000/v1')
  assert.deepEqual(candidates[0].dois, ['10.1000/v1', '10.1000/v2'])
  assert.ok(candidates[0].aliases.includes('omid:br/061'))
})

test('edge mapping removes aliases that resolve back to the selected root', () => {
  const root = {
    paperId: 'doi:10.1000/seed',
    aliases: ['doi:10.1000/seed', 'omid:br/060'],
  }
  const candidates = mapOpenCitationsEdges([
    {
      citing: 'omid:br/060',
      cited: 'doi:10.1000/seed',
      creation: '2000',
      timespan: 'P0Y',
    },
    {
      citing: 'doi:10.1000/other omid:br/061',
      cited: 'doi:10.1000/seed',
      creation: '2001',
      timespan: 'P1Y',
    },
  ], 'citations', root)

  assert.deepEqual(candidates.map(value => value.paperId), ['doi:10.1000/other'])
})

test('temporalOrder handles batch boundaries without loss or duplication', () => {
  for (const count of [0, 1, 24, 25, 26, 51]) {
    const candidates = Array.from({ length: count }, (_, index) => ({
      paperId: `doi:10.2/${String(index).padStart(2, '0')}`,
      year: index % 8 === 0 ? null : 1900 + index,
    }))
    const ordered = temporalOrder([...candidates].reverse(), 25)
    assert.equal(ordered.length, count, `count ${count}`)
    assert.equal(new Set(ordered.map(value => value.paperId)).size, count, `count ${count}`)
    assert.deepEqual(
      new Set(ordered.map(value => value.paperId)),
      new Set(candidates.map(value => value.paperId)),
      `count ${count}`,
    )
  }
})

test('mapMetaRecord maps bracketed Meta strings and preserves DOI-or-OMID identity', () => {
  const paper = mapMetaRecord({
    id: 'omid:br/069 doi:10.1000/META pmid:9',
    title: 'Meta title',
    author: 'Doe, Jane [orcid:1 omid:ra/1]; Consortium [omid:ra/2]',
    pub_date: '2009-06',
    venue: 'Journal Name [issn:1234-5678 omid:br/060]',
  })
  assert.equal(paper.paperId, 'doi:10.1000/meta')
  assert.equal(paper.doi, '10.1000/meta')
  assert.deepEqual(paper.authors, ['Jane Doe', 'Consortium'])
  assert.equal(paper.year, 2009)
  assert.equal(paper.venue, 'Journal Name')
  assert.equal(paper.crossrefCitedByCount, null)
  assert.equal(paper.openCitationCount, null)
  assert.equal(paper.openReferenceCount, null)
  assert.ok(paper.aliases.includes('omid:br/069'))

  assert.equal(mapMetaRecord({ id: 'omid:br/070', title: 'OMID only' }).paperId, 'omid:br/070')
  assert.equal(mapMetaRecord({
    id: 'omid:br/071',
    title: 'Invalid date',
    pub_date: '2020-99-99',
  }).year, null)
  assert.equal(mapMetaRecord({ id: '', title: 'No id' }), null)
})

test('OpenCitations counts must be non-negative integers', () => {
  assert.equal(mapOpenCitationsCount([{ count: '12' }]), 12)
  assert.equal(mapOpenCitationsCount([{ count: '1.5' }]), null)
  assert.equal(mapOpenCitationsCount([{ count: '9007199254740992' }]), null)
  assert.equal(mapOpenCitationsCount([{ count: '' }]), null)
  assert.equal(mapOpenCitationsCount([{ count: '-1' }]), null)
})

test('temporalOrder is input-order independent, spans time, retains undated, and is lossless', () => {
  const candidates = [
    { paperId: 'doi:10.1/1900', year: 1900 },
    { paperId: 'doi:10.1/1910', year: 1910 },
    { paperId: 'doi:10.1/1950', year: 1950 },
    { paperId: 'doi:10.1/2000', year: 2000 },
    { paperId: 'doi:10.1/2020', year: 2020 },
    { paperId: 'omid:br/undated', year: null },
  ]
  const first = temporalOrder(candidates, 4)
  const shuffled = temporalOrder(
    [candidates[4], candidates[1], candidates[5], candidates[0], candidates[3], candidates[2]],
    4,
  )

  assert.deepEqual(first.map(value => value.paperId), shuffled.map(value => value.paperId))
  assert.equal(new Set(first.map(value => value.paperId)).size, candidates.length)
  assert.deepEqual(
    new Set(first.map(value => value.paperId)),
    new Set(candidates.map(value => value.paperId)),
  )
  assert.deepEqual(first.map(value => value.paperId), [
    'doi:10.1/1900',
    'doi:10.1/1950',
    'omid:br/undated',
    'doi:10.1/2020',
    'doi:10.1/1910',
    'doi:10.1/2000',
  ])
  const opening = first.slice(0, 4)
  assert.ok(opening.some(value => value.year <= 1910))
  assert.ok(opening.some(value => value.year >= 2000))
  assert.ok(opening.some(value => value.year == null))
})

test('retry policy and provider pacing constants match the public contracts', () => {
  assert.equal(isRetryable(0), true)
  assert.equal(isRetryable(429), true)
  assert.equal(isRetryable(503), true)
  assert.equal(isRetryable(501), false)
  assert.equal(isRetryable(505), false)
  assert.equal(isRetryable(400), false)
  assert.equal(isRetryable(404), false)
  assert.equal(backoffDelay(0, 7), 7000)
  assert.equal(backoffDelay(0, 90), 90000)
  assert.equal(backoffDelay(2, null, () => 0.5), 2000)
  assert.equal(MAX_ATTEMPTS, 4)
  assert.equal(CROSSREF_SEARCH_PACE_MS, 1000)
  assert.equal(CROSSREF_DETAIL_PACE_MS, 200)
  assert.equal(OC_PACE_MS, 334)
  assert.equal(META_BATCH_MAX, 10)
})
