import test from 'node:test'
import assert from 'node:assert/strict'
import { PACE_MS, S2Client, S2Error, StaleError } from '../../s2.js'

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

function makeClient(responses, { delays = [], statuses = [] } = {}) {
  const calls = []
  const client = new S2Client({
    fetchFn: async url => {
      calls.push(url)
      const response = responses.shift()
      if (response === 'network') throw new TypeError('fetch failed')
      return response
    },
    storage: null,
    onStatus: status => statuses.push(status),
    delay: async ms => { delays.push(ms) },
  })
  return { client, calls, delays, statuses }
}

test('search maps results', async () => {
  const { client } = makeClient([ok({ data: [{ paperId: 'p1', title: 'A' }] })])
  const output = await client.search('dna')
  assert.equal(output[0].paperId, 'p1')
})

test('responses are cached so an identical request does not refetch', async () => {
  const { client, calls } = makeClient([ok({ data: [] })])
  await client.search('q')
  await client.search('q')
  assert.equal(calls.length, 1)
})

test('concurrent identical requests coalesce after waiting in the queue', async () => {
  const { client, calls } = makeClient([ok({ data: [] })])
  const first = client.search('q')
  const second = client.search('q')
  await Promise.all([first, second])
  assert.equal(calls.length, 1)
})

test('requests are paced via the injected delay', async () => {
  const { client, delays } = makeClient([ok({ data: [] }), ok({ data: [] })])
  await client.search('a')
  await client.search('b')
  assert.ok(
    delays.some(ms => ms > 0 && ms <= PACE_MS),
    `expected a pacing delay, got ${delays}`,
  )
})

test('429 retries with Retry-After honored, then succeeds', async () => {
  const { client, calls, delays, statuses } = makeClient([err(429, '3'), ok({ data: [] })])
  await client.search('q')
  assert.equal(calls.length, 2)
  assert.ok(delays.includes(3000), `expected 3000ms Retry-After delay in ${delays}`)
  assert.ok(statuses.some(status => status.state === 'backoff'))
})

test('404 fails immediately without retry', async () => {
  const { client, calls } = makeClient([err(404)])
  await assert.rejects(
    () => client.paper('nope'),
    error => error instanceof S2Error && error.status === 404 && error.retryable === false,
  )
  assert.equal(calls.length, 1)
})

test('network errors retry and exhaustion yields a retryable S2Error', async () => {
  const { client, calls } = makeClient(['network', 'network', 'network', 'network'])
  await assert.rejects(
    () => client.search('q'),
    error => error instanceof S2Error && error.status === 0 && error.retryable === true,
  )
  assert.equal(calls.length, 4)
})

test('retry exhaustion preserves the final HTTP status', async () => {
  const { client } = makeClient([err(503), err(503), err(503), err(503)])
  await assert.rejects(
    () => client.search('q'),
    error => error instanceof S2Error && error.status === 503 && error.retryable === true,
  )
})

test('a failed request does not wedge the queue', async () => {
  const { client } = makeClient([err(400), ok({ data: [] })])
  await assert.rejects(() => client.search('bad'))
  const output = await client.search('good')
  assert.deepEqual(output, [])
})

test('stale check before fetch drops a queued request', async () => {
  const { client, calls } = makeClient([ok({ data: [] })])
  await assert.rejects(
    () => client.connections('p1', 'citations', 0, () => true),
    error => error instanceof StaleError,
  )
  assert.equal(calls.length, 0)
})

test('a response that becomes stale while in flight is discarded', async () => {
  let resolveFetch
  let stale = false
  const client = new S2Client({
    fetchFn: () => new Promise(resolve => { resolveFetch = resolve }),
    storage: null,
    onStatus: () => {},
    delay: async () => {},
  })

  const request = client.connections('p1', 'references', 0, () => stale)
  await Promise.resolve()
  stale = true
  resolveFetch(ok({ data: [] }))

  await assert.rejects(request, error => error instanceof StaleError)
})

test('paper ids are URL encoded and invalid connection directions are rejected', async () => {
  const { client, calls } = makeClient([ok({ paperId: 'p1', title: 'A' })])
  await client.paper('DOI:10.1/a b')
  assert.match(calls[0], /DOI%3A10\.1%2Fa%20b/)
  await assert.rejects(() => client.connections('p1', 'incoming'), RangeError)
  assert.equal(calls.length, 1)
})

test('memory-only cache note is emitted once', async () => {
  const { client, statuses } = makeClient([ok({ data: [] }), ok({ data: [] })])
  await client.search('a')
  await client.search('b')
  assert.equal(
    statuses.filter(status => status.state === 'note').length,
    1,
  )
})
