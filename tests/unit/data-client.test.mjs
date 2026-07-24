import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LineageClient,
  ProviderError,
  StaleError,
  MAX_ATTEMPTS,
  CROSSREF_SEARCH_PACE_MS,
  CROSSREF_DETAIL_PACE_MS,
  OC_PACE_MS,
  META_BATCH_MAX,
} from '../../data.js'

const ok = json => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => json,
})

const err = (status, retryAfter = null) => ({
  ok: false,
  status,
  headers: { get: header => (header === 'Retry-After' ? retryAfter : null) },
  json: async () => ({}),
})

const crossrefWork = (doi, title = doi, citedBy = 0) => ({
  DOI: doi,
  title: [title],
  published: { 'date-parts': [[2000]] },
  author: [{ given: 'Test', family: 'Author' }],
  'is-referenced-by-count': citedBy,
})

const crossrefSearch = works => ({ message: { items: works } })
const crossrefDetail = work => ({ message: work })

function makeClient(fetchFn, { delays = [], statuses = [], storage = null } = {}) {
  const calls = []
  const client = new LineageClient({
    fetchFn: async (...args) => {
      calls.push(args[0])
      return fetchFn(...args)
    },
    storage,
    onStatus: status => statuses.push(status),
    delay: async ms => { delays.push(ms) },
  })
  return { client, calls, delays, statuses }
}

function fakeStorage() {
  const values = new Map()
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values,
  }
}

test('search uses Crossref title search and maps message.items', async () => {
  const { client, calls } = makeClient(async () => ok(crossrefSearch([
    crossrefWork('10.1000/A', 'Alpha', 7),
  ])))
  const output = await client.search('alpha beta')

  assert.equal(output[0].paperId, 'doi:10.1000/a')
  const url = new URL(calls[0])
  assert.equal(url.hostname, 'api.crossref.org')
  assert.equal(url.pathname.replace(/^\/v1/, ''), '/works')
  assert.equal(
    url.searchParams.get('query.title') || url.searchParams.get('query.bibliographic'),
    'alpha beta',
  )
  assert.ok(Number(url.searchParams.get('rows')) > 0)
  assert.equal(
    url.searchParams.get('select'),
    'DOI,title,author,published,container-title,is-referenced-by-count,score',
  )
})

test('DOI-shaped search goes directly to a singleton lookup and year queries use bibliographic search', async () => {
  const { client, calls } = makeClient(async url => {
    if (url.includes('/works/')) {
      return ok(crossrefDetail(crossrefWork('10.1000/direct', 'Direct result')))
    }
    return ok(crossrefSearch([]))
  })

  const direct = await client.search('https://doi.org/10.1000/DIRECT')
  assert.equal(direct[0].title, 'Direct result')
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/works\/10\.1000%2Fdirect$/)

  await client.search('Hartree 1928')
  const query = new URL(calls[1])
  assert.equal(query.searchParams.get('query.bibliographic'), 'Hartree 1928')
})

test('paper accepts a normalized Paper or paperId and URL-encodes a DOI lookup', async () => {
  const { client, calls } = makeClient(async () => ok(
    crossrefDetail(crossrefWork('10.1000/A+B', 'Detail')),
  ))
  const output = await client.paper({
    paperId: 'doi:10.1000/a+b',
    doi: '10.1000/a+b',
    aliases: ['doi:10.1000/a+b'],
  })

  assert.equal(output.title, 'Detail')
  assert.match(calls[0], /\/works\/10\.1000%2Fa%2Bb$/i)
})

test('connectionCount uses direction-specific OpenCitations count endpoints', async () => {
  const { client, calls } = makeClient(async url => (
    ok([{ count: url.includes('citation-count') ? '31' : '7' }])
  ))
  const paper = { paperId: 'doi:10.1000/seed', doi: '10.1000/seed' }

  assert.equal(await client.connectionCount(paper, 'citations'), 31)
  assert.equal(await client.connectionCount(paper, 'references'), 7)
  assert.match(calls[0], /\/citation-count\/doi:10\.1000\/seed$/)
  assert.match(calls[1], /\/reference-count\/doi:10\.1000\/seed$/)
  await assert.rejects(() => client.connectionCount(paper, 'incoming'), RangeError)
})

test('connections fetches one full edge array, compacts/dedupes it, and reports total links', async () => {
  const storage = fakeStorage()
  const rows = [
    {
      citing: 'doi:10.1000/c1 omid:br/061',
      cited: 'doi:10.1000/seed',
      creation: '2020',
      timespan: 'P20Y',
    },
    {
      citing: 'omid:br/061 doi:10.1000/C1',
      cited: 'doi:10.1000/seed',
      creation: '2020',
      timespan: 'P20Y',
    },
    {
      citing: 'omid:br/062',
      cited: 'doi:10.1000/seed',
      creation: '',
      timespan: '',
    },
  ]
  const { client, calls } = makeClient(async () => ok(rows), { storage })
  const result = await client.connections('doi:10.1000/seed', 'citations')

  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/citations\/doi:10\.1000\/seed$/)
  assert.equal(result.totalLinks, 3)
  assert.equal(result.candidates.length, 2)
  assert.deepEqual(
    new Set(result.candidates.map(value => value.paperId)),
    new Set(['doi:10.1000/c1', 'omid:br/062']),
  )
  // Full raw edge arrays can be megabytes and must never be persisted.
  assert.ok(![...storage.values.values()].some(value => value.includes('timespan')))
})

test('hydrate uses Crossref singleton metadata for DOI candidates and one Meta batch for OMIDs', async () => {
  const callsByHost = { crossref: [], meta: [] }
  const candidates = [
    { paperId: 'doi:10.1000/a', doi: '10.1000/a', aliases: ['doi:10.1000/a'] },
    { paperId: 'doi:10.1000/b', doi: '10.1000/b', aliases: ['doi:10.1000/b'] },
    { paperId: 'omid:br/061', doi: null, omid: 'omid:br/061', aliases: ['omid:br/061'] },
    { paperId: 'omid:br/062', doi: null, omid: 'omid:br/062', aliases: ['omid:br/062'] },
  ]
  const { client } = makeClient(async url => {
    const parsed = new URL(url)
    if (parsed.hostname === 'api.crossref.org') {
      callsByHost.crossref.push(url)
      const doi = decodeURIComponent(parsed.pathname.split('/works/')[1])
      return ok(crossrefDetail(crossrefWork(doi, `Crossref ${doi}`)))
    }
    callsByHost.meta.push(url)
    return ok([
      { id: 'omid:br/062', title: 'Meta 62', author: '', pub_date: '1962', venue: '' },
      { id: 'omid:br/061', title: 'Meta 61', author: '', pub_date: '1961', venue: '' },
    ])
  })

  const papers = await client.hydrate(candidates)
  assert.equal(callsByHost.crossref.length, 2)
  assert.equal(callsByHost.meta.length, 1)
  assert.match(callsByHost.meta[0], /omid:br%2F061__omid:br%2F062|omid:br%2F062__omid:br%2F061/)
  assert.deepEqual(
    new Set(papers.map(value => value.paperId)),
    new Set(candidates.map(value => value.paperId)),
  )
})

test('Meta hydration batches at ten identifiers and preserves literal separators', async () => {
  const candidates = Array.from({ length: 11 }, (_, index) => ({
    paperId: `omid:br/06${index}`,
    doi: null,
    omid: `omid:br/06${index}`,
    aliases: [`omid:br/06${index}`],
  }))
  const metaCalls = []
  const { client } = makeClient(async url => {
    metaCalls.push(url)
    const ids = new URL(url).pathname.split('/metadata/')[1].split('__').map(decodeURIComponent)
    return ok(ids.map(id => ({ id, title: id, author: '', pub_date: '', venue: '' })))
  })
  const papers = await client.hydrate(candidates)

  assert.equal(papers.length, 11)
  assert.equal(metaCalls.length, 2)
  assert.ok(metaCalls.every(url => url.includes('__') || url.endsWith('omid:br%2F0610')))
  assert.ok(metaCalls.every(url => (
    new URL(url).pathname.split('/metadata/')[1].split('__').length <= META_BATCH_MAX
  )))
})

test('Crossref 404 leaves a DOI candidate minimal without routing it through Meta', async () => {
  const candidate = {
    paperId: 'doi:10.1000/missing',
    doi: '10.1000/missing',
    omid: 'omid:br/0699',
    aliases: ['doi:10.1000/missing', 'omid:br/0699'],
    year: 1999,
    yearSource: 'edge',
  }
  const { client, calls } = makeClient(async url => {
    if (new URL(url).hostname === 'api.crossref.org') return err(404)
    throw new Error(`unexpected Meta request: ${url}`)
  })

  const papers = await client.hydrate([candidate])
  assert.equal(papers[0].paperId, candidate.paperId)
  assert.equal(papers[0].title, 'DOI 10.1000/missing')
  assert.equal(papers[0].year, 1999)
  assert.equal(papers[0].metadataIncomplete, true)
  assert.equal(papers[0].metadataRetryable, false)
  assert.equal(papers[0].detailsLoaded, true)
  assert.equal(calls.length, 1)
})

test('one DOI metadata miss preserves its placeholder and continues the batch', async () => {
  const candidates = ['missing', 'available'].map(id => ({
    paperId: `doi:10.1000/${id}`,
    doi: `10.1000/${id}`,
    aliases: [`doi:10.1000/${id}`],
    year: 1990,
    yearSource: 'edge',
  }))
  const { client, calls } = makeClient(async url => {
    const doi = decodeURIComponent(new URL(url).pathname.split('/works/')[1])
    return doi.endsWith('/missing')
      ? err(404)
      : ok(crossrefDetail(crossrefWork(doi, 'Available metadata')))
  })

  const papers = await client.hydrate(candidates)
  assert.equal(calls.length, 2)
  assert.equal(papers[0].metadataIncomplete, true)
  assert.equal(papers[1].title, 'Available metadata')
  assert.equal(papers[1].metadataIncomplete, false)
})

test('Meta 429 exhaustion does not recursively split or erase candidates', async () => {
  const candidates = Array.from({ length: META_BATCH_MAX }, (_, index) => ({
    paperId: `omid:br/09${index}`,
    doi: null,
    omid: `omid:br/09${index}`,
    aliases: [`omid:br/09${index}`],
  }))
  const { client, calls } = makeClient(async () => err(429, '0'))

  const papers = await client.hydrate(candidates)
  assert.equal(calls.length, MAX_ATTEMPTS)
  assert.equal(papers.length, candidates.length)
  assert.ok(papers.every(paper => (
    paper.metadataIncomplete && paper.metadataRetryable && !paper.detailsLoaded
  )))
})

test('a non-retryable Meta failure becomes a final minimal node without splitting', async () => {
  const candidate = {
    paperId: 'omid:br/0999',
    doi: null,
    omid: 'omid:br/0999',
    aliases: ['omid:br/0999'],
  }
  const { client, calls } = makeClient(async () => err(400))
  const [paper] = await client.hydrate([candidate])

  assert.equal(calls.length, 1)
  assert.equal(paper.metadataIncomplete, true)
  assert.equal(paper.metadataRetryable, false)
  assert.equal(paper.detailsLoaded, true)
})

test('Meta 500 batch-shape failures split recursively instead of dropping the batch', async () => {
  const candidates = Array.from({ length: META_BATCH_MAX }, (_, index) => ({
    paperId: `omid:br/08${index}`,
    doi: null,
    omid: `omid:br/08${index}`,
    aliases: [`omid:br/08${index}`],
  }))
  let oversizedAttempts = 0
  const { client } = makeClient(async url => {
    const ids = new URL(url).pathname.split('/metadata/')[1].split('__').map(decodeURIComponent)
    if (ids.length > META_BATCH_MAX / 2) {
      oversizedAttempts += 1
      return err(500)
    }
    return ok(ids.map(id => ({ id, title: id, author: '', pub_date: '', venue: '' })))
  })

  const papers = await client.hydrate(candidates)
  assert.equal(oversizedAttempts, MAX_ATTEMPTS)
  assert.equal(papers.length, META_BATCH_MAX)
  assert.deepEqual(
    new Set(papers.map(value => value.paperId)),
    new Set(candidates.map(value => value.paperId)),
  )
})

test('provider-wide Meta 503 exhaustion does not recursively amplify requests', async () => {
  const candidates = Array.from({ length: META_BATCH_MAX }, (_, index) => ({
    paperId: `omid:br/07${index}`,
    doi: null,
    omid: `omid:br/07${index}`,
    aliases: [`omid:br/07${index}`],
  }))
  const { client, calls } = makeClient(async () => err(503))

  const papers = await client.hydrate(candidates)

  assert.equal(calls.length, MAX_ATTEMPTS)
  assert.equal(papers.length, candidates.length)
  assert.ok(papers.every(paper => (
    paper.metadataIncomplete && paper.metadataRetryable && !paper.detailsLoaded
  )))
})

test('identical requests are cached and concurrent Crossref reads coalesce', async () => {
  let fetches = 0
  const { client } = makeClient(async () => {
    fetches += 1
    return ok(crossrefSearch([]))
  })
  const first = client.search('same')
  const second = client.search('same')
  await Promise.all([first, second])
  await client.search('same')
  assert.equal(fetches, 1)
})

test('429 honors Retry-After, then succeeds without wedging later work', async () => {
  const responses = [err(429, '3'), ok(crossrefSearch([])), err(400), ok(crossrefSearch([]))]
  const { client, calls, delays, statuses } = makeClient(async () => responses.shift())

  await client.search('retry')
  assert.ok(delays.includes(3000))
  assert.ok(statuses.some(status => status.state === 'backoff'))
  await assert.rejects(() => client.search('bad'), error => (
    error instanceof ProviderError && error.status === 400 && error.retryable === false
  ))
  assert.deepEqual(await client.search('good'), [])
  assert.equal(calls.length, 4)
})

test('retry exhaustion preserves provider/status and remains manually retryable', async () => {
  let calls = 0
  const { client } = makeClient(async () => {
    calls += 1
    return err(503)
  })
  await assert.rejects(
    () => client.connectionCount('doi:10.1000/seed', 'citations'),
    error => (
      error instanceof ProviderError
      && error.status === 503
      && error.retryable === true
      && /open.?citations/i.test(error.provider || error.message)
    ),
  )
  assert.equal(calls, MAX_ATTEMPTS)
})

test('stale checks drop queued work and discard responses that become stale in flight', async () => {
  let calls = 0
  const queued = makeClient(async () => {
    calls += 1
    return ok(crossrefSearch([]))
  }).client
  await assert.rejects(
    () => queued.search('superseded', () => true),
    error => error instanceof StaleError,
  )
  assert.equal(calls, 0)

  let resolveFetch
  let stale = false
  const inFlight = makeClient(() => new Promise(resolve => { resolveFetch = resolve })).client
  const request = inFlight.connections('doi:10.1000/seed', 'references', () => stale)
  await Promise.resolve()
  stale = true
  resolveFetch(ok([]))
  await assert.rejects(request, error => error instanceof StaleError)
})

test('separate provider queues apply their public pacing ceilings', async () => {
  const { client, delays } = makeClient(async url => {
    if (url.includes('/works?')) return ok(crossrefSearch([]))
    if (url.includes('/works/')) return ok(crossrefDetail(crossrefWork('10.1000/x')))
    return ok([{ count: '0' }])
  })

  await client.search('a')
  await client.search('b')
  await client.paper('doi:10.1000/x')
  await client.paper('doi:10.1000/y')
  await client.connectionCount('doi:10.1000/x', 'citations')
  await client.connectionCount('doi:10.1000/y', 'citations')

  assert.ok(delays.some(ms => ms > 0 && ms <= CROSSREF_SEARCH_PACE_MS))
  assert.ok(delays.some(ms => ms > 0 && ms <= CROSSREF_DETAIL_PACE_MS))
  assert.ok(delays.some(ms => ms > 0 && ms <= OC_PACE_MS))
})

test('an in-flight Crossref request does not block the OpenCitations scheduler', async () => {
  let releaseCrossref
  let markCrossrefStarted
  const crossrefGate = new Promise(resolve => { releaseCrossref = resolve })
  const crossrefStarted = new Promise(resolve => { markCrossrefStarted = resolve })
  const { client } = makeClient(async url => {
    if (new URL(url).hostname === 'api.crossref.org') {
      markCrossrefStarted()
      await crossrefGate
      return ok(crossrefDetail(crossrefWork('10.1000/seed')))
    }
    return ok([{ count: '12' }])
  })

  const detail = client.paper('doi:10.1000/seed')
  await crossrefStarted
  const count = await client.connectionCount('doi:10.1000/seed', 'citations')
  assert.equal(count, 12)
  releaseCrossref()
  await detail
})
