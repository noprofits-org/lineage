import test from 'node:test'
import assert from 'node:assert/strict'
import { createCache } from '../../data.js'

function fakeStorage() {
  const values = new Map()
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    _map: values,
  }
}

const entryKey = (disk, suffix) => [...disk._map.keys()].find(key => key.endsWith(`.${suffix}`))
const indexKey = disk => [...disk._map.keys()].find(key => key.endsWith('.__index'))

test('set/get round-trips via memory and disk', () => {
  const disk = fakeStorage()
  const cache = createCache(disk)
  cache.set('u1', { a: 1 })
  assert.deepEqual(cache.get('u1'), { a: 1 })

  const freshCache = createCache(disk)
  assert.deepEqual(freshCache.get('u1'), { a: 1 })
})

test('legacy Semantic Scholar cache entries are ignored', () => {
  const disk = fakeStorage()
  disk.setItem('lineage.v1.same-url', JSON.stringify({ legacy: true }))
  const cache = createCache(disk)
  assert.equal(cache.get('same-url'), undefined)
})

test('a corrupt disk entry becomes a miss and disables disk caching', () => {
  const disk = fakeStorage()
  const first = createCache(disk)
  first.set('bad', { valid: true })
  disk.setItem(entryKey(disk, 'bad'), '{not json')
  const cache = createCache(disk)

  assert.equal(cache.get('bad'), undefined)
  assert.equal(cache.diskDisabled(), true)
})

test('a corrupt LRU index degrades to memory-only caching', () => {
  const disk = fakeStorage()
  const first = createCache(disk)
  first.set('seed', 1)
  disk.setItem(indexKey(disk), '{not json')
  const cache = createCache(disk)

  cache.set('u1', { a: 1 })
  assert.equal(cache.diskDisabled(), true)
  assert.deepEqual(cache.get('u1'), { a: 1 })
})

test('quota errors flip to memory-only and memory keeps working', () => {
  const disk = fakeStorage()
  disk.setItem = () => { throw new Error('QuotaExceededError') }
  const cache = createCache(disk)

  cache.set('u1', { a: 1 })
  assert.equal(cache.diskDisabled(), true)
  assert.deepEqual(cache.get('u1'), { a: 1 })
})

test('LRU evicts the oldest entries beyond the byte cap', () => {
  const disk = fakeStorage()
  const cache = createCache(disk, { maxBytes: 50 })
  cache.set('a', 'xxxxxxxxxxxxxxxxxxxx')
  cache.set('b', 'yyyyyyyyyyyyyyyyyyyy')
  cache.set('c', 'zzzzzzzzzzzzzzzzzzzz')

  assert.equal(disk.getItem(entryKey(disk, 'a')), null)
  assert.notEqual(disk.getItem(entryKey(disk, 'c')), null)
})

test('cache reads refresh LRU recency', () => {
  const disk = fakeStorage()
  const cache = createCache(disk, { maxBytes: 100 })
  cache.set('a', 'xxxxxxxxxxxxxxxxxxxx')
  cache.set('b', 'yyyyyyyyyyyyyyyyyyyy')
  cache.get('a')
  cache.set('c', 'zzzzzzzzzzzzzzzzzzzz')

  assert.notEqual(disk.getItem(entryKey(disk, 'a')), null)
  assert.equal(disk.getItem(entryKey(disk, 'b')), null)
  assert.notEqual(disk.getItem(entryKey(disk, 'c')), null)
})

test('an entry larger than the disk cap remains available from memory', () => {
  const disk = fakeStorage()
  const cache = createCache(disk, { maxBytes: 10 })
  cache.set('large', 'a value too large for disk')

  assert.equal(entryKey(disk, 'large'), undefined)
  assert.equal(cache.get('large'), 'a value too large for disk')
  assert.equal(cache.diskDisabled(), false)
})

test('null storage means memory-only from the start', () => {
  const cache = createCache(null)
  cache.set('k', 1)
  assert.equal(cache.get('k'), 1)
  assert.equal(cache.diskDisabled(), true)
})
