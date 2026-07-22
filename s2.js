// Semantic Scholar Academic Graph client for Lineage.
// Pure response helpers, cache, and the paced request client live together so
// the browser can consume this module without a build step.

export const API_BASE = 'https://api.semanticscholar.org/graph/v1'
export const PAPER_FIELDS = 'title,year,authors,venue,citationCount,referenceCount,externalIds'
export const POOL_LIMIT = 500
export const MAX_ATTEMPTS = 4
export const PACE_MS = 1000

const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30000
const CACHE_PREFIX = 'lineage.v1.'
const CACHE_INDEX_KEY = 'lineage.v1.__index'
const CACHE_MAX_BYTES = 2_000_000

export function mapPaper(raw) {
  if (!raw || !raw.paperId) return null

  return {
    paperId: raw.paperId,
    title: raw.title || 'Untitled',
    year: Number.isInteger(raw.year) ? raw.year : null,
    authors: Array.isArray(raw.authors)
      ? raw.authors.map(author => author && author.name).filter(Boolean)
      : [],
    venue: raw.venue || null,
    abstract: raw.abstract || null,
    citationCount: raw.citationCount ?? 0,
    referenceCount: raw.referenceCount ?? 0,
    doi: raw.externalIds?.DOI || null,
  }
}

export function mapConnections(json, direction) {
  if (direction !== 'citations' && direction !== 'references') {
    throw new RangeError(`Unknown connection direction: ${direction}`)
  }

  const key = direction === 'citations' ? 'citingPaper' : 'citedPaper'
  const rows = Array.isArray(json?.data) ? json.data : []
  const papers = rows.map(row => mapPaper(row?.[key])).filter(Boolean)
  return { papers, next: json?.next ?? null }
}

export function isRetryable(status) {
  return status === 0 || status === 429 || status >= 500
}

export function backoffDelay(attempt, retryAfterSeconds, rand = Math.random) {
  const retryAfter = Number(retryAfterSeconds)
  if (
    retryAfterSeconds !== null
    && retryAfterSeconds !== undefined
    && String(retryAfterSeconds).trim() !== ''
    && Number.isFinite(retryAfter)
    && retryAfter >= 0
  ) {
    // Honor the server's Retry-After, but never let one header freeze the
    // whole request queue longer than the retry policy's ceiling.
    return Math.min(retryAfter * 1000, MAX_DELAY_MS)
  }

  const safeAttempt = Math.max(0, Number.isFinite(attempt) ? attempt : 0)
  const cap = Math.min(BASE_DELAY_MS * 2 ** safeAttempt, MAX_DELAY_MS)
  const randomValue = Math.min(1, Math.max(0, Number(rand())))
  return Math.floor(randomValue * cap)
}

function byteLength(value) {
  const text = String(value)
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength
  return text.length * 2
}

export function createCache(storage, { maxBytes = CACHE_MAX_BYTES } = {}) {
  const mem = new Map()
  let disk = storage || null

  const disableDisk = () => {
    disk = null
  }

  const readIndex = () => {
    if (!disk) return null
    try {
      const raw = disk.getItem(CACHE_INDEX_KEY)
      if (raw == null) return []
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new TypeError('invalid cache index')
      return parsed.filter(entry => (
        entry
        && typeof entry.k === 'string'
        && Number.isFinite(entry.n)
        && entry.n >= 0
      ))
    } catch {
      disableDisk()
      return null
    }
  }

  const touch = (key, raw) => {
    if (!disk) return
    const index = readIndex()
    if (!index || !disk) return
    const position = index.findIndex(entry => entry.k === key)
    let entry
    if (position >= 0) {
      entry = index.splice(position, 1)[0]
    } else if (raw !== undefined) {
      entry = { k: key, n: byteLength(raw) + byteLength(key) + 24 }
    } else {
      return
    }
    index.push(entry)
    try {
      disk.setItem(CACHE_INDEX_KEY, JSON.stringify(index))
    } catch {
      disableDisk()
    }
  }

  return {
    get(key) {
      if (mem.has(key)) {
        const value = mem.get(key)
        touch(key)
        return value
      }
      if (!disk) return undefined

      let raw
      try {
        raw = disk.getItem(CACHE_PREFIX + key)
        if (raw == null) return undefined
        const value = JSON.parse(raw)
        mem.set(key, value)
        touch(key, raw)
        return value
      } catch {
        try { disk?.removeItem(CACHE_PREFIX + key) } catch {}
        disableDisk()
        return undefined
      }
    },

    set(key, value) {
      mem.set(key, value)
      if (!disk) return

      try {
        const raw = JSON.stringify(value)
        if (raw === undefined) return

        const index = readIndex()
        if (!index || !disk) return

        const nextIndex = index.filter(entry => entry.k !== key)
        nextIndex.push({ k: key, n: byteLength(raw) + byteLength(key) + 24 })
        let total = nextIndex.reduce((sum, entry) => sum + entry.n, 0)
        const evicted = []

        while (total > maxBytes && nextIndex.length > 0) {
          const entry = nextIndex.shift()
          evicted.push(entry.k)
          total -= entry.n
        }

        for (const evictedKey of evicted) {
          disk.removeItem(CACHE_PREFIX + evictedKey)
        }
        if (nextIndex.some(entry => entry.k === key)) {
          disk.setItem(CACHE_PREFIX + key, raw)
        }
        disk.setItem(CACHE_INDEX_KEY, JSON.stringify(nextIndex))
      } catch {
        disableDisk()
      }
    },

    diskDisabled() {
      return disk == null
    },
  }
}

export class S2Error extends Error {
  constructor(status, retryable) {
    super(`S2 request failed (${status})`)
    this.name = 'S2Error'
    this.status = status
    this.retryable = retryable
  }
}

export class StaleError extends Error {
  constructor() {
    super('request superseded by graph reset')
    this.name = 'StaleError'
  }
}

function defaultStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function retryAfterSeconds(headers) {
  if (!headers || typeof headers.get !== 'function') return null
  const raw = headers.get('Retry-After')
  if (raw == null) return null
  const text = String(raw).trim()
  if (!text) return null

  const numeric = Number(text)
  if (Number.isFinite(numeric) && numeric >= 0) return numeric

  const date = Date.parse(text)
  if (Number.isNaN(date)) return null
  return Math.max(0, (date - Date.now()) / 1000)
}

export class S2Client {
  constructor({ fetchFn, storage, onStatus, delay } = {}) {
    this.fetchFn = fetchFn || ((...args) => fetch(...args))
    this.cache = createCache(storage === undefined ? defaultStorage() : storage)
    this.onStatus = onStatus || (() => {})
    this.delay = delay || (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.chain = Promise.resolve()
    this.lastStart = 0
    this.cacheNoteSent = false
  }

  request(path, isStale = () => false) {
    const url = API_BASE + path
    if (isStale()) return Promise.reject(new StaleError())

    const cached = this.cache.get(url)
    if (cached !== undefined) return Promise.resolve(cached)

    const run = this.chain.then(async () => {
      if (isStale()) throw new StaleError()

      // A request ahead of this one may have populated the same URL while it
      // waited in the queue. Rechecking coalesces concurrent identical reads.
      const queuedCacheHit = this.cache.get(url)
      if (queuedCacheHit !== undefined) return queuedCacheHit
      return this.#fetchWithRetry(url, isStale)
    })

    // Both branches resolve so one rejected request cannot wedge later work.
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  async #fetchWithRetry(url, isStale) {
    let lastStatus = 0

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (isStale()) throw new StaleError()

      const paceWait = this.lastStart + PACE_MS - Date.now()
      if (paceWait > 0) await this.delay(paceWait)
      if (isStale()) throw new StaleError()

      this.lastStart = Date.now()
      this.#emit({ state: 'loading' })

      let response
      try {
        response = await this.fetchFn(url)
      } catch {
        response = null
      }

      if (isStale()) {
        this.#emit({ state: 'idle' })
        throw new StaleError()
      }

      if (response?.ok) {
        let json
        try {
          json = await response.json()
        } catch {
          response = null
        }

        if (response) {
          if (isStale()) {
            this.#emit({ state: 'idle' })
            throw new StaleError()
          }
          this.cache.set(url, json)
          if (this.cache.diskDisabled() && !this.cacheNoteSent) {
            this.cacheNoteSent = true
            this.#emit({ state: 'idle' })
            this.#emit({ state: 'note', message: 'local cache unavailable — using memory only' })
          } else {
            this.#emit({ state: 'idle' })
          }
          return json
        }
      }

      const status = Number.isInteger(response?.status) ? response.status : 0
      lastStatus = status

      if (!isRetryable(status)) {
        this.#emit({
          state: 'error',
          message: status === 404 ? 'paper not found' : `request failed (${status})`,
          retryable: false,
        })
        throw new S2Error(status, false)
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        const ms = backoffDelay(attempt, retryAfterSeconds(response?.headers))
        const message = status === 429
          ? `rate limited — retrying in ${Math.max(1, Math.round(ms / 1000))}s`
          : `request interrupted — retrying in ${Math.max(1, Math.round(ms / 1000))}s`
        this.#emit({ state: 'backoff', message })
        await this.delay(ms)
      }
    }

    const exhaustedMessage = lastStatus === 429
      ? 'Semantic Scholar is still rate limiting requests'
      : 'Semantic Scholar is temporarily unavailable'
    this.#emit({ state: 'error', message: exhaustedMessage, retryable: true })
    throw new S2Error(lastStatus, true)
  }

  #emit(status) {
    try { this.onStatus(status) } catch {}
  }

  search(query, isStale = () => false) {
    return this
      .request(
        `/paper/search?query=${encodeURIComponent(query)}&fields=${PAPER_FIELDS}&limit=10`,
        isStale,
      )
      .then(json => (Array.isArray(json?.data) ? json.data : []).map(mapPaper).filter(Boolean))
  }

  paper(id, isStale = () => false) {
    return this
      .request(
        `/paper/${encodeURIComponent(id)}?fields=${PAPER_FIELDS},abstract`,
        isStale,
      )
      .then(mapPaper)
  }

  connections(id, direction, offset = 0, isStale = () => false) {
    if (direction !== 'citations' && direction !== 'references') {
      return Promise.reject(new RangeError(`Unknown connection direction: ${direction}`))
    }
    return this
      .request(
        `/paper/${encodeURIComponent(id)}/${direction}?fields=${PAPER_FIELDS}&offset=${offset}&limit=${POOL_LIMIT}`,
        isStale,
      )
      .then(json => mapConnections(json, direction))
  }
}
