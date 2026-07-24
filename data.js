// Provider-neutral data layer for Lineage.
//
// Crossref supplies search and bibliographic metadata. OpenCitations supplies
// citation edges and DOI-less metadata fallback. The browser talks to both
// services directly, so pacing, retries, caching, and stale-generation checks
// live here rather than in the controller.

export const CROSSREF_BASE = 'https://api.crossref.org'
export const OC_INDEX_BASE = 'https://api.opencitations.net/index/v2'
export const OC_META_BASE = 'https://api.opencitations.net/meta/v1'

export const MAX_ATTEMPTS = 4
export const CROSSREF_SEARCH_PACE_MS = 1000
export const CROSSREF_DETAIL_PACE_MS = 200
export const OC_PACE_MS = 334
export const META_BATCH_MAX = 10

const META_URL_MAX = 1800
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30000
const MAX_TIMER_MS = 2_147_483_647
const CACHE_PREFIX = 'lineage.v2.'
const CACHE_INDEX_KEY = 'lineage.v2.__index'
const CACHE_MAX_BYTES = 2_000_000
// OpenCitations PID bundles are whitespace-separated. Do not treat semicolons
// as separators: they (along with +, <, and >) can legitimately occur inside
// a DOI and must survive through URL encoding.
const PID_PATTERN = /(?:^|\s)(?:\[[^\]]+\]\s*=>\s*)?(doi|omid|pmid|pmcid|openalex):(\S+)/gi

export function normalizeDoi(raw) {
  if (raw == null) return null
  let value = String(raw).trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
  try { value = decodeURIComponent(value) } catch {}
  value = value.trim().toLowerCase()
  return /^10\.\d{4,9}\/\S+$/i.test(value) ? value : null
}

function normalizeAlias(prefix, value) {
  const kind = String(prefix).toLowerCase()
  const raw = String(value).trim()
  if (kind === 'doi') {
    const doi = normalizeDoi(raw)
    return doi ? `doi:${doi}` : null
  }
  if (kind === 'omid') return raw ? `omid:${raw.toLowerCase()}` : null
  if (kind === 'pmid') return /^\d+$/.test(raw) ? `pmid:${raw}` : null
  if (kind === 'pmcid') return raw ? `pmcid:${raw.toLowerCase()}` : null
  if (kind === 'openalex') return raw ? `openalex:${raw.toLowerCase()}` : null
  return null
}

function identifiersFromAliases(aliases) {
  const values = [...new Set(aliases.filter(Boolean))]
  const dois = values
    .filter(alias => alias.startsWith('doi:'))
    .map(alias => alias.slice(4))
    .sort()
  const omidAlias = values.find(alias => alias.startsWith('omid:'))
  const pmidAlias = values.find(alias => alias.startsWith('pmid:'))
  const paperId = dois[0]
    ? `doi:${dois[0]}`
    : omidAlias || pmidAlias || null
  return {
    paperId,
    doi: dois[0] || null,
    dois,
    omid: omidAlias || null,
    pmid: pmidAlias || null,
    aliases: values.sort(),
  }
}

export function parsePidBundle(raw) {
  const aliases = []
  const text = String(raw || '')
  for (const match of text.matchAll(PID_PATTERN)) {
    const alias = normalizeAlias(match[1], match[2])
    if (alias) aliases.push(alias)
  }
  return identifiersFromAliases(aliases)
}

export const parsePidAliases = parsePidBundle

export function canonicalPaperId(aliases) {
  return identifiersFromAliases(Array.isArray(aliases) ? aliases : []).paperId
}

function mergeIdentifiers(...sources) {
  return identifiersFromAliases(sources.flatMap(source => source?.aliases || []))
}

function numberOrNull(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function decodeCodePoint(value, radix) {
  const codePoint = Number.parseInt(value, radix)
  if (
    !Number.isInteger(codePoint)
    || codePoint < 0
    || codePoint > 0x10FFFF
    || (codePoint >= 0xD800 && codePoint <= 0xDFFF)
  ) return '\uFFFD'
  return String.fromCodePoint(codePoint)
}

export function stripMarkup(value) {
  if (value == null) return null
  const text = String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => decodeCodePoint(hex, 16))
    .replace(/&#(\d+);/g, (_, decimal) => decodeCodePoint(decimal, 10))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return text || null
}

function firstText(value) {
  if (Array.isArray(value)) return stripMarkup(value.find(item => String(item || '').trim()))
  return stripMarkup(value)
}

function crossrefYear(raw) {
  for (const key of ['published', 'published-print', 'published-online', 'issued']) {
    const year = Number(raw?.[key]?.['date-parts']?.[0]?.[0])
    if (Number.isInteger(year) && year > 0) return year
  }
  return null
}

function crossrefAuthors(raw) {
  if (!Array.isArray(raw)) return []
  return raw.map(author => {
    if (!author) return null
    if (author.literal) return stripMarkup(author.literal)
    if (author.name) return stripMarkup(author.name)
    const name = [author.given, author.family].filter(Boolean).join(' ').trim()
    return stripMarkup(name)
  }).filter(Boolean)
}

export function mapCrossrefWork(raw) {
  const doi = normalizeDoi(raw?.DOI)
  if (!doi) return null
  const identifiers = identifiersFromAliases([`doi:${doi}`])
  return {
    ...identifiers,
    title: firstText(raw.title) || 'Untitled',
    year: crossrefYear(raw),
    yearSource: crossrefYear(raw) == null ? null : 'metadata',
    authors: crossrefAuthors(raw.author),
    venue: firstText(raw['container-title']) || firstText(raw['short-container-title']),
    abstract: stripMarkup(raw.abstract),
    crossrefCitedByCount: numberOrNull(raw['is-referenced-by-count']),
    openCitationCount: null,
    openReferenceCount: null,
    metadataSource: 'crossref',
    metadataIncomplete: false,
    metadataRetryable: false,
    detailsLoaded: false,
  }
}

function stripIdentifierAnnotation(value) {
  return stripMarkup(String(value || '').replace(/\s*\[[^\]]*\]\s*$/g, ''))
}

function metaAuthorName(value) {
  const name = stripIdentifierAnnotation(value)
  if (!name || !name.includes(',')) return name
  const [family, ...given] = name.split(',').map(part => part.trim())
  return [...given, family].filter(Boolean).join(' ')
}

function parsePartialDate(value) {
  const match = String(value || '').trim().match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/)
  if (!match) return null
  const year = Number(match[1])
  const month = match[2] == null ? null : Number(match[2])
  const day = match[3] == null ? null : Number(match[3])
  if (!Number.isInteger(year) || year <= 0) return null
  if (month != null && (!Number.isInteger(month) || month < 1 || month > 12)) return null
  if (day != null) {
    const lastOfMonth = new Date(0)
    lastOfMonth.setUTCHours(0, 0, 0, 0)
    lastOfMonth.setUTCFullYear(year, month, 0)
    if (!Number.isInteger(day) || day < 1 || day > lastOfMonth.getUTCDate()) return null
  }
  return { year, month, day }
}

function partialDateYear(value) {
  return parsePartialDate(value)?.year ?? null
}

export function mapMetaRecord(raw) {
  const identifiers = parsePidBundle(raw?.id)
  if (!identifiers.paperId) return null
  const year = partialDateYear(raw?.pub_date)
  return {
    ...identifiers,
    title: stripMarkup(raw?.title) || 'Untitled',
    year,
    yearSource: year == null ? null : 'metadata',
    authors: String(raw?.author || '')
      .split(';')
      .map(metaAuthorName)
      .filter(Boolean),
    venue: stripIdentifierAnnotation(raw?.venue),
    abstract: null,
    crossrefCitedByCount: null,
    openCitationCount: null,
    openReferenceCount: null,
    metadataSource: 'opencitations-meta',
    metadataIncomplete: false,
    metadataRetryable: false,
    detailsLoaded: true,
  }
}

const parseCreation = parsePartialDate

export function deriveReferencedYear(creation, timespan) {
  const date = parseCreation(creation)
  const duration = String(timespan || '').trim().match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?$/,
  )
  if (!date || !duration) return null

  const years = Number(duration[1] || 0)
  const months = Number(duration[2] || 0)
  const days = Number(duration[3] || 0)
  if (![years, months, days].every(Number.isSafeInteger)) return null

  if (date.month == null) {
    const year = date.year - years
    return months === 0 && days === 0 && year > 0 ? year : null
  }

  if (date.day == null) {
    if (days !== 0) return null
    const monthIndex = date.year * 12 + date.month - 1 - (years * 12 + months)
    const year = Math.floor(monthIndex / 12)
    return year > 0 ? year : null
  }

  const result = new Date(0)
  result.setUTCHours(0, 0, 0, 0)
  result.setUTCFullYear(date.year, date.month - 1, date.day)
  result.setUTCFullYear(result.getUTCFullYear() - years)
  result.setUTCMonth(result.getUTCMonth() - months)
  result.setUTCDate(result.getUTCDate() - days)
  const year = result.getUTCFullYear()
  return Number.isInteger(year) && year > 0 ? year : null
}

function aliasOverlap(left, right) {
  const rightSet = new Set(right || [])
  return (left || []).some(alias => rightSet.has(alias))
}

export function mapOpenCitationsEdges(rows, direction, root = null) {
  if (direction !== 'citations' && direction !== 'references') {
    throw new RangeError(`Unknown connection direction: ${direction}`)
  }

  const rootIds = typeof root === 'string'
    ? parsePidBundle(root)
    : identifiersFromAliases(root?.aliases || [root?.paperId].filter(Boolean))
  const grouped = new Map()

  for (const row of Array.isArray(rows) ? rows : []) {
    const citingIds = parsePidBundle(row?.citing)
    const citedIds = parsePidBundle(row?.cited)
    const neighborIds = direction === 'citations' ? citingIds : citedIds
    if (!neighborIds.paperId || aliasOverlap(neighborIds.aliases, rootIds.aliases)) continue

    const groupKey = neighborIds.omid
      ? neighborIds.omid
      : neighborIds.doi
        ? `doi:${neighborIds.doi}`
        : neighborIds.paperId
    const edgeYear = direction === 'citations'
      ? partialDateYear(row?.creation)
      : deriveReferencedYear(row?.creation, row?.timespan)
    const existing = grouped.get(groupKey)
    if (existing) {
      const merged = mergeIdentifiers(existing, neighborIds)
      Object.assign(existing, merged)
      if (existing.year == null && edgeYear != null) existing.year = edgeYear
      continue
    }

    grouped.set(groupKey, {
      ...neighborIds,
      creation: row?.creation || null,
      timespan: row?.timespan || null,
      year: edgeYear,
      yearSource: edgeYear == null
        ? null
        : direction === 'citations' ? 'edge' : 'derived',
      direction,
    })
  }

  return [...grouped.values()].map(candidate => {
    const identifiers = identifiersFromAliases(candidate.aliases)
    return { ...candidate, ...identifiers }
  })
}

export function temporalOrder(candidates, batchSize = 25) {
  const size = Math.max(1, Math.floor(Number(batchSize) || 1))
  let dated = [...(candidates || [])]
    .filter(candidate => candidate.year != null)
    .sort((left, right) => (
      left.year - right.year || String(left.paperId).localeCompare(String(right.paperId))
    ))
  const undated = [...(candidates || [])]
    .filter(candidate => candidate.year == null)
    .sort((left, right) => String(left.paperId).localeCompare(String(right.paperId)))
  const ordered = []

  const takeEvenly = count => {
    const take = Math.min(count, dated.length)
    if (take <= 0) return []
    const positions = new Set()
    for (let index = 0; index < take; index += 1) {
      positions.add(take === 1
        ? Math.floor((dated.length - 1) / 2)
        : Math.round(index * (dated.length - 1) / (take - 1)))
    }
    const selected = dated.filter((_, index) => positions.has(index))
    dated = dated.filter((_, index) => !positions.has(index))
    return selected
  }

  while (dated.length > 0 || undated.length > 0) {
    const hasBoth = dated.length > 0 && undated.length > 0
    const datedSlots = hasBoth && size > 1
      ? size - 1
      : undated.length > 0 && dated.length === 0 ? 0 : size
    const batch = takeEvenly(datedSlots)
    if (undated.length > 0 && batch.length < size) {
      // Keep the reserved undated representative early enough to survive a
      // partial node-cap admission without making it the first temporal cue.
      batch.splice(Math.min(2, batch.length), 0, undated.shift())
    }
    while (dated.length === 0 && undated.length > 0 && batch.length < size) {
      batch.push(undated.shift())
    }
    ordered.push(...batch)
  }

  return ordered
}

export const timeStratifiedOrder = temporalOrder

export function mapOpenCitationsCount(json) {
  return numberOrNull(json?.[0]?.count)
}

export function isRetryable(status) {
  return status === 0
    || status === 429
    || status === 500
    || status === 502
    || status === 503
    || status === 504
}

export function backoffDelay(attempt, retryAfterSeconds, rand = Math.random) {
  const retryAfter = Number(retryAfterSeconds)
  if (
    retryAfterSeconds !== null
    && retryAfterSeconds !== undefined
    && String(retryAfterSeconds).trim() !== ''
    && Number.isFinite(retryAfter)
    && retryAfter >= 0
  ) return Math.min(retryAfter * 1000, MAX_TIMER_MS)

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

  const disableDisk = () => { disk = null }
  const readIndex = () => {
    if (!disk) return null
    try {
      const raw = disk.getItem(CACHE_INDEX_KEY)
      if (raw == null) return []
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new TypeError('invalid cache index')
      return parsed.filter(entry => (
        entry && typeof entry.k === 'string' && Number.isFinite(entry.n) && entry.n >= 0
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
    if (position >= 0) entry = index.splice(position, 1)[0]
    else if (raw !== undefined) entry = { k: key, n: byteLength(raw) + byteLength(key) + 24 }
    else return
    index.push(entry)
    try { disk.setItem(CACHE_INDEX_KEY, JSON.stringify(index)) } catch { disableDisk() }
  }

  return {
    get(key) {
      if (mem.has(key)) {
        const value = mem.get(key)
        touch(key)
        return value
      }
      if (!disk) return undefined
      try {
        const raw = disk.getItem(CACHE_PREFIX + key)
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
        for (const evictedKey of evicted) disk.removeItem(CACHE_PREFIX + evictedKey)
        if (nextIndex.some(entry => entry.k === key)) disk.setItem(CACHE_PREFIX + key, raw)
        disk.setItem(CACHE_INDEX_KEY, JSON.stringify(nextIndex))
      } catch {
        disableDisk()
      }
    },
    diskDisabled() { return disk == null },
  }
}

export class SourceError extends Error {
  constructor(provider, status, retryable, message = null) {
    super(message || `${provider} request failed (${status})`)
    this.name = 'SourceError'
    this.provider = provider
    this.status = status
    this.retryable = retryable
  }
}

export const ProviderError = SourceError

export class StaleError extends Error {
  constructor() {
    super('request superseded by newer work')
    this.name = 'StaleError'
  }
}

function defaultStorage() {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function retryAfterSeconds(headers) {
  if (!headers || typeof headers.get !== 'function') return null
  const raw = headers.get('Retry-After')
  if (raw == null || String(raw).trim() === '') return null
  const numeric = Number(raw)
  if (Number.isFinite(numeric) && numeric >= 0) return numeric
  const date = Date.parse(raw)
  return Number.isNaN(date) ? null : Math.max(0, (date - Date.now()) / 1000)
}

class RequestScheduler {
  constructor({ provider, fetchFn, cache, onStatus, delay, paceMs }) {
    this.provider = provider
    this.fetchFn = fetchFn
    this.cache = cache
    this.onStatus = onStatus
    this.delay = delay
    this.paceMs = paceMs
    this.memory = new Map()
    this.chain = Promise.resolve()
    this.lastStart = 0
    this.cacheNoteSent = false
  }

  request(url, { isStale = () => false, cacheMode = 'persistent', paceMs = this.paceMs } = {}) {
    if (isStale()) return Promise.reject(new StaleError())
    const cache = cacheMode === 'persistent' ? this.cache : this.memory
    if (cacheMode !== 'none') {
      const cached = cache.get(url)
      if (cached !== undefined) return Promise.resolve(cached)
    }

    const run = this.chain.then(async () => {
      if (isStale()) throw new StaleError()
      if (cacheMode !== 'none') {
        const queued = cache.get(url)
        if (queued !== undefined) return queued
      }
      const json = await this.#fetchWithRetry(url, isStale, paceMs)
      if (cacheMode !== 'none') cache.set(url, json)
      if (
        cacheMode === 'persistent'
        && this.cache.diskDisabled()
        && !this.cacheNoteSent
      ) {
        this.cacheNoteSent = true
        this.#emit({ state: 'note', message: 'local cache unavailable — using memory only' })
      }
      return json
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  async #fetchWithRetry(url, isStale, paceMs) {
    let lastStatus = 0
    this.#emit({ state: 'loading', message: `fetching from ${this.provider}…` })
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        if (isStale()) throw new StaleError()
        const paceWait = this.lastStart + paceMs - Date.now()
        if (paceWait > 0) await this.delay(paceWait)
        if (isStale()) throw new StaleError()

        this.lastStart = Date.now()
        let response
        try { response = await this.fetchFn(url) } catch { response = null }
        if (isStale()) throw new StaleError()

        if (response?.ok) {
          try {
            const json = await response.json()
            if (isStale()) throw new StaleError()
            return json
          } catch (error) {
            if (error instanceof StaleError) throw error
            response = null
          }
        }

        const status = Number.isInteger(response?.status) ? response.status : 0
        lastStatus = status
        if (!isRetryable(status)) {
          const message = status === 404 && this.provider === 'Crossref'
            ? 'paper not found'
            : `${this.provider} request failed (${status})`
          throw new SourceError(this.provider, status, false, message)
        }

        if (attempt < MAX_ATTEMPTS - 1) {
          const ms = backoffDelay(attempt, retryAfterSeconds(response?.headers))
          this.#emit({
            state: 'backoff',
            message: status === 429
              ? `${this.provider} rate limited — retrying in ${Math.max(1, Math.round(ms / 1000))}s`
              : `${this.provider} request interrupted — retrying in ${Math.max(1, Math.round(ms / 1000))}s`,
          })
          await this.delay(ms)
        }
      }

      throw new SourceError(
        this.provider,
        lastStatus,
        true,
        lastStatus === 429
          ? `${this.provider} is still rate limiting requests`
          : `${this.provider} is temporarily unavailable`,
      )
    } finally {
      this.#emit({ state: 'idle' })
    }
  }

  #emit(status) {
    try { this.onStatus({ ...status, provider: this.provider }) } catch {}
  }
}

function identifierFor(value) {
  if (value && typeof value === 'object') {
    const doi = normalizeDoi(value.doi)
    if (doi) return `doi:${doi}`
    if (value.omid) return identifierFor(value.omid)
    if (value.pmid) return identifierFor(value.pmid)
    if (value.paperId) return identifierFor(value.paperId)
  }
  const text = String(value || '').trim()
  if (/^(doi|omid|pmid):/i.test(text)) return parsePidBundle(text).paperId
  const doi = normalizeDoi(text)
  return doi ? `doi:${doi}` : null
}

function encodePidPath(identifier) {
  const separator = identifier.indexOf(':')
  const prefix = identifier.slice(0, separator)
  const value = identifier.slice(separator + 1)
  return `${prefix}:${value.split('/').map(encodeURIComponent).join('/')}`
}

function encodeMetaId(identifier) {
  const separator = identifier.indexOf(':')
  return `${identifier.slice(0, separator)}:${encodeURIComponent(identifier.slice(separator + 1))}`
}

function metaChunks(identifiers) {
  const chunks = []
  let current = []
  let length = OC_META_BASE.length + '/metadata/'.length
  for (const identifier of identifiers) {
    const encoded = encodeMetaId(identifier)
    const extra = encoded.length + (current.length > 0 ? 2 : 0)
    if (current.length >= META_BATCH_MAX || (current.length > 0 && length + extra > META_URL_MAX)) {
      chunks.push(current)
      current = []
      length = OC_META_BASE.length + '/metadata/'.length
    }
    current.push(identifier)
    length += encoded.length + (current.length > 1 ? 2 : 0)
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function placeholderPaper(
  candidate,
  { detailsLoaded = true, metadataIncomplete = true } = {},
) {
  const identifier = candidate.doi || candidate.omid || candidate.pmid || candidate.paperId
  return {
    paperId: candidate.paperId,
    doi: candidate.doi || null,
    dois: candidate.dois || [],
    omid: candidate.omid || null,
    pmid: candidate.pmid || null,
    aliases: [...(candidate.aliases || [])],
    title: candidate.doi ? `DOI ${candidate.doi}` : `OpenCitations record ${identifier}`,
    year: candidate.year ?? null,
    yearSource: candidate.yearSource ?? null,
    authors: [],
    venue: null,
    abstract: null,
    crossrefCitedByCount: null,
    openCitationCount: null,
    openReferenceCount: null,
    metadataSource: null,
    metadataIncomplete,
    metadataRetryable: false,
    detailsLoaded,
  }
}

function mergeCandidatePaper(candidate, metadata, { trustMetadataAliases = true } = {}) {
  const identifiers = trustMetadataAliases
    ? mergeIdentifiers(candidate, metadata)
    : identifiersFromAliases(candidate.aliases || [])
  return {
    ...placeholderPaper(candidate),
    ...(metadata || {}),
    ...identifiers,
    paperId: candidate.paperId,
    aliases: [...new Set([
      ...(candidate.aliases || []),
      ...(trustMetadataAliases ? metadata?.aliases || [] : []),
    ])].sort(),
    doi: candidate.doi || metadata?.doi || null,
    omid: candidate.omid || (trustMetadataAliases ? metadata?.omid : null) || null,
    pmid: candidate.pmid || (trustMetadataAliases ? metadata?.pmid : null) || null,
    year: metadata?.year ?? candidate.year ?? null,
    yearSource: metadata?.year != null ? 'metadata' : candidate.yearSource ?? null,
    metadataIncomplete: metadata ? false : true,
    metadataRetryable: false,
  }
}

function recordCompleteness(record) {
  if (!record) return -1
  return (
    (record.title && record.title !== 'Untitled' ? 8 : 0)
    + (record.year != null ? 4 : 0)
    + (record.authors?.length || 0)
    + (record.venue ? 2 : 0)
    + (record.doi ? 1 : 0)
  )
}

function mostCompleteRecord(records) {
  return [...(records || [])].sort((left, right) => (
    recordCompleteness(right) - recordCompleteness(left)
    || String(left.paperId).localeCompare(String(right.paperId))
  ))[0] || null
}

export class DataClient {
  constructor({ fetchFn, storage, onStatus, delay } = {}) {
    const resolvedFetch = fetchFn || ((...args) => fetch(...args))
    const resolvedDelay = delay || (ms => new Promise(resolve => setTimeout(resolve, ms)))
    const cache = createCache(storage === undefined ? defaultStorage() : storage)
    const report = onStatus || (() => {})
    const activeProviders = new Set()
    let cacheNoteSeen = false
    const status = event => {
      if (event.state === 'note' && event.message?.startsWith('local cache unavailable')) {
        if (cacheNoteSeen) return
        cacheNoteSeen = true
      }
      if (event.state === 'loading') activeProviders.add(event.provider)
      if (event.state === 'idle') {
        activeProviders.delete(event.provider)
        if (activeProviders.size > 0) return
      }
      report(event)
    }
    this.crossref = new RequestScheduler({
      provider: 'Crossref', fetchFn: resolvedFetch, cache, onStatus: status,
      delay: resolvedDelay, paceMs: CROSSREF_DETAIL_PACE_MS,
    })
    this.openCitations = new RequestScheduler({
      provider: 'OpenCitations', fetchFn: resolvedFetch, cache, onStatus: status,
      delay: resolvedDelay, paceMs: OC_PACE_MS,
    })
  }

  async search(query, isStale = () => false) {
    const normalized = String(query || '').trim()
    if (!normalized) return []
    const doi = normalizeDoi(normalized)
    if (doi) {
      const paper = await this.#crossrefPaper(doi, isStale)
      return paper ? [paper] : []
    }

    const queryField = /\b(?:18|19|20)\d{2}\b/.test(normalized)
      ? 'query.bibliographic'
      : 'query.title'
    const params = new URLSearchParams({
      [queryField]: normalized,
      rows: '10',
      // These are the only search-result fields Lineage maps. Full abstracts
      // and reference arrays arrive later from a selected work's singleton.
      select: [
        'DOI',
        'title',
        'author',
        'published',
        'container-title',
        'is-referenced-by-count',
        'score',
      ].join(','),
    })
    const url = `${CROSSREF_BASE}/works?${params}`
    const json = await this.crossref.request(url, {
      isStale,
      paceMs: CROSSREF_SEARCH_PACE_MS,
    })
    return (Array.isArray(json?.message?.items) ? json.message.items : [])
      .map(mapCrossrefWork)
      .filter(Boolean)
  }

  async #crossrefPaper(doi, isStale) {
    const url = `${CROSSREF_BASE}/works/${encodeURIComponent(doi)}`
    const json = await this.crossref.request(url, {
      isStale,
      paceMs: CROSSREF_DETAIL_PACE_MS,
    })
    const paper = mapCrossrefWork(json?.message)
    return paper ? { ...paper, detailsLoaded: true } : null
  }

  async paper(value, isStale = () => false) {
    const identifier = identifierFor(value)
    if (!identifier) return null
    if (identifier.startsWith('doi:')) {
      return this.#crossrefPaper(identifier.slice(4), isStale)
    }
    if (!identifier.startsWith('omid:')) return null
    return mostCompleteRecord(await this.#metaRecords([identifier], isStale))
  }

  directPaper(value, isStale = () => false) {
    return this.paper(value, isStale)
  }

  async connectionCount(value, direction, isStale = () => false) {
    if (direction !== 'citations' && direction !== 'references') {
      throw new RangeError(`Unknown connection direction: ${direction}`)
    }
    const identifier = identifierFor(value)
    if (!identifier) return 0
    const operation = direction === 'citations' ? 'citation-count' : 'reference-count'
    const url = `${OC_INDEX_BASE}/${operation}/${encodePidPath(identifier)}`
    const json = await this.openCitations.request(url, { isStale })
    const count = mapOpenCitationsCount(json)
    if (count == null) {
      throw new SourceError('OpenCitations', 200, false, 'OpenCitations returned an invalid count')
    }
    return count
  }

  async connections(value, direction, isStale = () => false) {
    if (direction !== 'citations' && direction !== 'references') {
      throw new RangeError(`Unknown connection direction: ${direction}`)
    }
    const identifier = identifierFor(value)
    if (!identifier) return { candidates: [], totalLinks: 0 }
    const url = `${OC_INDEX_BASE}/${direction}/${encodePidPath(identifier)}`
    // Full edge arrays can be several megabytes. The controller retains only
    // compact candidates, so raw responses deliberately bypass persistent and
    // memory caches.
    const json = await this.openCitations.request(url, { isStale, cacheMode: 'none' })
    const candidates = temporalOrder(mapOpenCitationsEdges(json, direction, value))
    return { candidates, totalLinks: Array.isArray(json) ? json.length : 0 }
  }

  async hydrate(candidates, isStale = () => false) {
    const papers = new Map()
    const fallbacks = []
    let crossrefUnavailable = false
    for (const candidate of candidates || []) {
      if (isStale()) throw new StaleError()
      if (!candidate.doi) {
        if (candidate.omid) fallbacks.push(candidate)
        else papers.set(candidate.paperId, placeholderPaper(candidate))
        continue
      }
      if (crossrefUnavailable) {
        papers.set(candidate.paperId, {
          ...placeholderPaper(candidate, { detailsLoaded: false }),
          metadataRetryable: true,
        })
        continue
      }
      try {
        const metadata = await this.#crossrefPaper(candidate.doi, isStale)
        papers.set(candidate.paperId, mergeCandidatePaper(candidate, metadata))
      } catch (error) {
        if (error instanceof StaleError || isStale()) throw new StaleError()
        if (!(error instanceof ProviderError)) throw error
        papers.set(candidate.paperId, {
          ...placeholderPaper(candidate, { detailsLoaded: !error.retryable }),
          metadataRetryable: error.retryable,
        })
        // One exhausted transient failure is enough evidence that repeating
        // four attempts for every remaining DOI would amplify an outage.
        if (error.retryable) crossrefUnavailable = true
      }
    }

    for (const chunk of metaChunks(fallbacks.map(candidate => (
      candidate.omid
    )))) {
      if (isStale()) throw new StaleError()
      const { records, retryableFailed } = await this.#settledMetaRecords(chunk, isStale)
      for (const candidate of fallbacks) {
        if (papers.has(candidate.paperId)) continue
        const expected = candidate.omid
        if (!chunk.includes(expected)) continue
        const matches = records.filter(item => item.aliases.includes(expected))
        const record = mostCompleteRecord(matches)
        if (record) {
          papers.set(candidate.paperId, mergeCandidatePaper(candidate, record))
        } else {
          papers.set(candidate.paperId, placeholderPaper(candidate, {
            detailsLoaded: !retryableFailed.includes(expected),
          }))
          if (retryableFailed.includes(expected)) {
            papers.get(candidate.paperId).metadataRetryable = true
          }
        }
      }
    }

    return (candidates || []).map(candidate => (
      papers.get(candidate.paperId) || placeholderPaper(candidate)
    ))
  }

  hydrateCandidates(candidates, isStale = () => false) {
    return this.hydrate(candidates, isStale)
  }

  async #metaRecords(identifiers, isStale) {
    const encoded = identifiers.map(encodeMetaId).join('__')
    const url = `${OC_META_BASE}/metadata/${encoded}`
    const json = await this.openCitations.request(url, { isStale })
    return (Array.isArray(json) ? json : []).map(mapMetaRecord).filter(Boolean)
  }

  async #settledMetaRecords(identifiers, isStale) {
    try {
      return {
        records: await this.#metaRecords(identifiers, isStale),
        failed: [],
        retryableFailed: [],
      }
    } catch (error) {
      if (error instanceof StaleError || isStale()) throw new StaleError()
      const canSplit = (
        error instanceof ProviderError
        && error.retryable
        // Meta uses 500 for malformed/oversized identifier bundles. Isolate
        // those records, but never multiply provider-wide 502/503/504
        // outages into a recursive request storm.
        && error.status === 500
        && identifiers.length > 1
      )
      if (!canSplit) {
        return {
          records: [],
          failed: [...identifiers],
          retryableFailed: error instanceof ProviderError && error.retryable
            ? [...identifiers]
            : [],
        }
      }

      const middle = Math.ceil(identifiers.length / 2)
      const left = await this.#settledMetaRecords(identifiers.slice(0, middle), isStale)
      const right = await this.#settledMetaRecords(identifiers.slice(middle), isStale)
      return {
        records: [...left.records, ...right.records],
        failed: [...left.failed, ...right.failed],
        retryableFailed: [...left.retryableFailed, ...right.retryableFailed],
      }
    }
  }
}

export const LineageClient = DataClient
