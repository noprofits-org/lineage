// Lineage controller + graph model. The pure model lives up top (unit
// tested); DOM wiring is appended below and only runs in the page.

import { S2Client, S2Error, StaleError } from './s2.js'
import { createGraph, nearestInDirection } from './graph.js'

export const NODE_CAP = 300
export const BATCH = 25

export function createState() {
  return {
    gen: 0,
    nodes: new Map(),
    edges: new Map(),
    selected: null,
    seedId: null,
  }
}

export function newExpansion(total) {
  return {
    status: 'idle',
    nextOffset: 0,
    fetchedCount: 0,
    displayedCount: 0,
    total,
    exhausted: false,
    pool: [],
    pagesFetched: 0,
    _seenPaperIds: new Set(),
  }
}

export function addPaper(state, paper) {
  const existing = state.nodes.get(paper.paperId)
  if (existing) return existing

  const node = {
    ...paper,
    expansion: {
      references: newExpansion(paper.referenceCount),
      citations: newExpansion(paper.citationCount),
    },
  }
  state.nodes.set(paper.paperId, node)
  return node
}

export function addEdge(state, citing, cited) {
  if (citing === cited) return false

  const key = `${citing}→${cited}`
  if (state.edges.has(key)) return false

  state.edges.set(key, { citing, cited })
  return true
}

export function rankPool(papers) {
  return [...papers].sort(
    (a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0),
  )
}

export function completeFetch(exp, { papers, next }) {
  const seenPaperIds = exp._seenPaperIds ?? new Set(exp.pool.map(paper => paper.paperId))
  exp._seenPaperIds = seenPaperIds
  const uniquePapers = papers.filter(paper => {
    if (seenPaperIds.has(paper.paperId)) return false
    seenPaperIds.add(paper.paperId)
    return true
  })
  exp.status = 'idle'
  exp.pool = rankPool([...exp.pool, ...uniquePapers])
  exp.fetchedCount += uniquePapers.length
  exp.pagesFetched += 1
  exp.nextOffset = next ?? null
  exp.exhausted = next == null
}

export function admit(state, node, direction, { cap = NODE_CAP } = {}) {
  const exp = node.expansion[direction]
  const requested = Math.min(BATCH, exp.pool.length)
  const admitted = []
  let capped = false

  while (admitted.length < requested && exp.pool.length > 0) {
    const paper = exp.pool[0]
    const isNew = !state.nodes.has(paper.paperId)

    if (isNew && state.nodes.size >= cap) {
      capped = true
      break
    }

    exp.pool.shift()
    const other = addPaper(state, paper)
    if (direction === 'citations') {
      addEdge(state, other.paperId, node.paperId)
    } else {
      addEdge(state, node.paperId, other.paperId)
    }
    admitted.push(other)
    exp.displayedCount += 1
  }

  return { admitted, capped, requested }
}

const formatCount = number => number.toLocaleString('en-US')

export function disclosure(exp, noun) {
  if (exp.pagesFetched > 1) {
    if (exp.exhausted && exp.fetchedCount === exp.total) {
      return `showing ${formatCount(exp.displayedCount)} of ${formatCount(exp.total)} ${noun}`
    }
    if (exp.exhausted) {
      return `showing ${formatCount(exp.displayedCount)} of ${formatCount(exp.fetchedCount)} available papers (${formatCount(exp.total)} ${noun} reported)`
    }
    return `showing ${formatCount(exp.displayedCount)} of the first ${formatCount(exp.fetchedCount)} fetched (${formatCount(exp.total)} total)`
  }
  if (exp.exhausted && exp.fetchedCount === exp.total) {
    return `showing top ${formatCount(exp.displayedCount)} of ${formatCount(exp.total)} ${noun}`
  }
  if (exp.exhausted) {
    return `showing ${formatCount(exp.displayedCount)} of ${formatCount(exp.fetchedCount)} available papers (${formatCount(exp.total)} ${noun} reported)`
  }
  return `showing top ${formatCount(exp.displayedCount)} of the first ${formatCount(exp.fetchedCount)} fetched (${formatCount(exp.total)} total)`
}

export function doiHref(doi) {
  const path = String(doi).split('/').map(encodeURIComponent).join('/')
  return `https://doi.org/${path}`
}

// ---------------------------------------------------------------- DOM layer

let state
let client
let graph
let elements
let lastDirectionByNode = new Map()
let pendingRetries = new Map()
let operationSequence = 0
let searchSequence = 0
let selectionSequence = 0
let timelineTimer = null

const byId = id => document.getElementById(id)

export function setStatus(text) {
  if (timelineTimer != null) clearTimeout(timelineTimer)
  timelineTimer = null
  elements.status.textContent = text
}

function configuredNodeCap() {
  const raw = new URLSearchParams(location.search).get('cap')
  if (raw == null) return NODE_CAP
  const value = Number(raw)
  return Number.isInteger(value) && value > 0
    ? Math.min(value, NODE_CAP)
    : NODE_CAP
}

function nextOperationId(prefix) {
  operationSequence += 1
  return `${prefix}:${operationSequence}`
}

function updateRetryButton() {
  elements.retry.hidden = pendingRetries.size === 0
}

function clearRetry(operationId) {
  pendingRetries.delete(operationId)
  updateRetryButton()
}

function clearRetriesMatching(prefix) {
  for (const operationId of pendingRetries.keys()) {
    if (operationId.startsWith(prefix)) pendingRetries.delete(operationId)
  }
  updateRetryButton()
}

function hasRetryMatching(prefix) {
  for (const operationId of pendingRetries.keys()) {
    if (operationId.startsWith(prefix)) return true
  }
  return false
}

function queueRetry(operationId, action) {
  // Reinsert so the most recently failed form of this operation sits at the
  // end of the manual-retry queue without disturbing unrelated failures.
  pendingRetries.delete(operationId)
  pendingRetries.set(operationId, action)
  updateRetryButton()
}

function directionFor(node) {
  return lastDirectionByNode.get(node.paperId) || 'citations'
}

// The direction "load more" should act on: the most recently expanded one if
// it still has undisplayed papers, otherwise the other one. Null when neither
// direction has anything left to show.
function directionWithRemainder(node) {
  const preferred = directionFor(node)
  const other = preferred === 'citations' ? 'references' : 'citations'
  for (const direction of [preferred, other]) {
    const expansion = node.expansion[direction]
    if (
      expansion.pagesFetched > 0
      && (expansion.pool.length > 0 || !expansion.exhausted)
    ) return direction
  }
  return null
}

function refreshSelectedInspector(node) {
  if (state.selected === node.paperId && !elements.inspector.hidden) {
    showInspector(node)
  }
}

export function init(options = {}) {
  state = createState()
  elements = {
    form: byId('search-form'),
    search: byId('search'),
    results: byId('results'),
    canvas: byId('canvas'),
    empty: byId('empty'),
    inspector: byId('inspector'),
    status: byId('status'),
    retry: byId('retry'),
    reset: byId('reset'),
    close: byId('inspector-close'),
  }

  client = new S2Client({
    onStatus: status => {
      if (status.state === 'loading') setStatus('fetching…')
      else if (status.state === 'backoff' || status.state === 'note') setStatus(status.message)
      else if (status.state === 'error') showError(status)
      else if (elements.status.textContent === 'fetching…') setStatus('ready')
    },
    ...options.clientOpts,
  })

  graph = createGraph(elements.canvas, {
    onSelect: select,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  })

  elements.form.addEventListener('submit', event => {
    event.preventDefault()
    runSearch(elements.search.value)
  })
  document.querySelectorAll('.example-query').forEach(button => {
    button.addEventListener('click', () => {
      elements.search.value = button.textContent.trim()
      runSearch(button.textContent)
    })
  })
  elements.close.addEventListener('click', () => {
    selectionSequence += 1
    clearRetriesMatching('paper:')
    elements.inspector.hidden = true
    if (state.selected) graph.focusNode(state.selected)
  })
  elements.reset.addEventListener('click', () => {
    reset()
    elements.search.focus()
  })
  elements.retry.addEventListener('click', () => {
    const entry = pendingRetries.entries().next().value
    if (!entry) return
    const [operationId, action] = entry
    pendingRetries.delete(operationId)
    updateRetryButton()
    action()
  })
  elements.canvas.addEventListener('keydown', handleCanvasKeydown)
  wireInspector()

  if (typeof ResizeObserver !== 'undefined') {
    let resizeFrame = null
    const observer = new ResizeObserver(() => {
      if (resizeFrame != null) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null
        render()
      })
    })
    observer.observe(elements.canvas)
  }

  render()
}

async function runSearch(query, operationId = null) {
  const normalized = query.trim()
  if (!normalized) return

  if (operationId == null) {
    clearRetriesMatching('search:')
    operationId = nextOperationId('search')
  }
  const sequence = ++searchSequence
  clearRetry(operationId)
  elements.results.hidden = true
  setStatus('searching…')

  let papers
  try {
    papers = await client.search(normalized, () => sequence !== searchSequence)
  } catch (error) {
    if (error instanceof StaleError || sequence !== searchSequence) {
      clearRetry(operationId)
      return
    }
    if (error instanceof S2Error && error.retryable) {
      queueRetry(operationId, () => runSearch(normalized, operationId))
    } else {
      clearRetry(operationId)
    }
    return
  }
  if (sequence !== searchSequence) {
    clearRetry(operationId)
    return
  }

  clearRetry(operationId)
  if (papers.length === 0) {
    elements.results.hidden = true
    setStatus('no papers found for that search')
    return
  }

  elements.results.replaceChildren()
  elements.results.hidden = false
  setStatus(`${papers.length} paper${papers.length === 1 ? '' : 's'} found`)
  papers.forEach((paper, index) => {
    const item = document.createElement('li')
    item.setAttribute('role', 'option')
    item.setAttribute('aria-selected', index === 0 ? 'true' : 'false')
    item.tabIndex = -1
    item.innerHTML = `<span class="yr">${paper.year ?? '—'}</span> ${escapeHtml(paper.title)}`
    item.addEventListener('click', () => seed(paper))
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault()
        seed(paper)
      }
      if (event.key === 'Escape') {
        elements.results.hidden = true
        elements.search.focus()
      }
    })
    elements.results.appendChild(item)
  })
  wireResultArrows()
  elements.results.firstElementChild?.focus()
}

function wireResultArrows() {
  const items = [...elements.results.querySelectorAll('li')]
  items.forEach((item, index) => {
    item.addEventListener('keydown', event => {
      let next = null
      if (event.key === 'ArrowDown') next = items[index + 1]
      if (event.key === 'ArrowUp') next = items[index - 1]
      if (!next) return
      event.preventDefault()
      items.forEach(candidate => candidate.setAttribute('aria-selected', 'false'))
      next.setAttribute('aria-selected', 'true')
      next.focus()
    })
  })
}

function seed(paper) {
  if (state.nodes.size > 0) reset({ showEmpty: false, clearSearch: false })
  elements.results.hidden = true
  elements.empty.hidden = true
  elements.reset.hidden = false
  const node = addPaper(state, paper)
  state.seedId = paper.paperId
  select(node.paperId)
}

export function select(paperId) {
  const node = state.nodes.get(paperId)
  if (!node) return
  if (state.selected !== paperId) {
    selectionSequence += 1
    clearRetriesMatching('paper:')
  }
  state.selected = paperId
  showInspector(node)
  render()
}

function render() {
  if (!graph || !state) return { widened: false }
  return graph.update({
    nodes: [...state.nodes.values()],
    edges: [...state.edges.values()],
    selectedId: state.selected,
    cap: configuredNodeCap(),
  }) || { widened: false }
}

function showError(status) {
  setStatus(status.message || 'request failed')
}

function wireInspector() {
  elements.inspector.querySelector('[data-testid="expand-references"]')
    .addEventListener('click', () => expandSelected('references'))
  elements.inspector.querySelector('[data-testid="expand-citations"]')
    .addEventListener('click', () => expandSelected('citations'))
  elements.inspector.querySelector('[data-testid="load-more"]')
    .addEventListener('click', () => {
      const node = state.nodes.get(state.selected)
      const direction = node && directionWithRemainder(node)
      if (direction) expand(node, direction)
    })
}

function expandSelected(direction) {
  const node = state.nodes.get(state.selected)
  if (node) expand(node, direction)
}

export async function expand(node, direction, operationId = null) {
  if (direction !== 'references' && direction !== 'citations') return
  if (state.nodes.get(node.paperId) !== node) return

  lastDirectionByNode.set(node.paperId, direction)
  const expansion = node.expansion[direction]
  if (expansion.status === 'loading') return

  const retryPrefix = `expand:${node.paperId}:${direction}:`
  if (operationId == null) {
    clearRetriesMatching(retryPrefix)
    operationId = nextOperationId(`expand:${node.paperId}:${direction}`)
  }
  clearRetry(operationId)

  if (expansion.pool.length === 0 && !expansion.exhausted) {
    expansion.status = 'loading'
    refreshSelectedInspector(node)
    const generation = state.gen
    let page
    try {
      page = await client.connections(
        node.paperId,
        direction,
        expansion.nextOffset ?? 0,
        () => generation !== state.gen,
      )
    } catch (error) {
      if (error instanceof StaleError || generation !== state.gen) {
        clearRetry(operationId)
        return
      }
      expansion.status = 'error'
      if (error instanceof S2Error && error.retryable) {
        queueRetry(operationId, () => {
          expansion.status = 'idle'
          expand(node, direction, operationId)
        })
      } else {
        clearRetry(operationId)
      }
      refreshSelectedInspector(node)
      return
    }
    if (generation !== state.gen) {
      clearRetry(operationId)
      return
    }
    completeFetch(expansion, page)
  }

  clearRetry(operationId)
  if (
    expansion.pool.length === 0
    && expansion.exhausted
    && expansion.displayedCount === 0
    && expansion.total === 0
  ) {
    setStatus(direction === 'citations' ? 'no citations recorded' : 'no references recorded')
    refreshSelectedInspector(node)
    return
  }

  const result = admit(state, node, direction, { cap: configuredNodeCap() })
  let message = disclosure(expansion, direction)
  if (result.capped) {
    message += ` — node cap reached — added ${result.admitted.length} of ${result.requested}`
  }

  refreshSelectedInspector(node)
  const { widened } = render()
  setOutcomeStatus(message, widened)
}

function setOutcomeStatus(message, widened) {
  if (timelineTimer != null) clearTimeout(timelineTimer)
  timelineTimer = null
  if (!widened) {
    elements.status.textContent = message
    return
  }
  elements.status.textContent = `timeline widened — ${message}`
  timelineTimer = setTimeout(() => {
    timelineTimer = null
    elements.status.textContent = message
  }, 700)
}

function showInspector(node) {
  elements.inspector.hidden = false
  const field = name => elements.inspector.querySelector(`[data-testid="${name}"]`)
  field('insp-title').textContent = node.title
  field('insp-meta').textContent = [
    node.authors.join(', '),
    node.year ?? 'undated',
    node.venue,
  ].filter(Boolean).join(' · ')
  field('insp-counts').textContent =
    `${node.citationCount.toLocaleString('en-US')} citations · ${node.referenceCount.toLocaleString('en-US')} references`

  const abstract = field('insp-abstract')
  abstract.textContent = node.abstract ?? ''
  abstract.hidden = !node.abstract
  fillInspectorLinks(field('insp-links'), node)
  fillRelationships(field, node)

  for (const direction of ['references', 'citations']) {
    const expansion = node.expansion[direction]
    const status = field(`${direction}-status`)
    if (expansion.status === 'loading') {
      status.textContent = `fetching ${direction}…`
      status.hidden = false
    } else if (expansion.status === 'error') {
      const retryable = hasRetryMatching(`expand:${node.paperId}:${direction}:`)
      status.textContent = retryable
        ? `${direction} request failed — retry available`
        : `${direction} request failed`
      status.hidden = false
    } else if (expansion.pagesFetched > 0) {
      status.textContent = disclosure(expansion, direction)
      status.hidden = false
    } else {
      status.hidden = true
      status.textContent = ''
    }
  }

  field('load-more').hidden = !(
    directionWithRemainder(node)
    && state.nodes.size < configuredNodeCap()
  )

  loadAbstract(node)
}

function loadAbstract(node, operationId = null) {
  if (node.abstract != null || state.nodes.get(node.paperId) !== node) return

  const retryPrefix = `paper:${node.paperId}:`
  if (operationId == null && hasRetryMatching(retryPrefix)) return

  const requestKey = `${state.gen}:${selectionSequence}`
  if (node._abstractRequested === requestKey) return
  if (operationId == null) {
    clearRetriesMatching(retryPrefix)
    operationId = nextOperationId(`paper:${node.paperId}`)
  }
  clearRetry(operationId)
  node._abstractRequested = requestKey

  const generation = state.gen
  const selection = selectionSequence
  const isStale = () => (
    generation !== state.gen
    || selection !== selectionSequence
    || state.selected !== node.paperId
    || elements.inspector.hidden
  )

  client.paper(node.paperId, isStale).then(full => {
    clearRetry(operationId)
    if (
      !isStale()
      && full?.abstract
      && state.nodes.get(node.paperId) === node
    ) {
      node.abstract = full.abstract
      const abstract = elements.inspector.querySelector('[data-testid="insp-abstract"]')
      abstract.textContent = full.abstract
      abstract.hidden = false
    }
  }).catch(error => {
    if (node._abstractRequested === requestKey) {
      delete node._abstractRequested
    }
    if (error instanceof StaleError || isStale()) {
      clearRetry(operationId)
      return
    }
    if (error instanceof S2Error && error.retryable) {
      queueRetry(operationId, () => {
        if (isStale()) {
          clearRetry(operationId)
          return
        }
        loadAbstract(node, operationId)
      })
    } else {
      clearRetry(operationId)
    }
  })
}

function fillInspectorLinks(container, node) {
  container.replaceChildren()
  const links = []
  if (node.doi) links.push(['DOI', doiHref(node.doi)])
  links.push([
    'Semantic Scholar',
    `https://www.semanticscholar.org/paper/${encodeURIComponent(node.paperId)}`,
  ])
  links.forEach(([label, href], index) => {
    if (index > 0) container.append(' · ')
    const link = document.createElement('a')
    link.textContent = label
    link.href = href
    link.target = '_blank'
    link.rel = 'noopener'
    container.append(link)
  })
}

function fillRelationships(field, node) {
  const cites = []
  const citedBy = []
  for (const edge of state.edges.values()) {
    if (edge.citing === node.paperId) cites.push(state.nodes.get(edge.cited))
    if (edge.cited === node.paperId) citedBy.push(state.nodes.get(edge.citing))
  }

  const fill = (name, papers) => {
    const list = field(name)
    list.replaceChildren()
    papers.filter(Boolean).forEach(paper => {
      const item = document.createElement('li')
      item.textContent = `${paper.title} (${paper.year ?? 'undated'})`
      list.append(item)
    })
  }
  fill('rel-cites', cites)
  fill('rel-citedby', citedBy)
}

function reset({ showEmpty = true, clearSearch = true } = {}) {
  state.gen += 1
  searchSequence += 1
  state.nodes.clear()
  state.edges.clear()
  state.selected = null
  state.seedId = null
  selectionSequence += 1
  pendingRetries.clear()
  lastDirectionByNode.clear()
  if (timelineTimer != null) clearTimeout(timelineTimer)
  timelineTimer = null
  elements.results.hidden = true
  elements.inspector.hidden = true
  elements.empty.hidden = !showEmpty
  elements.reset.hidden = true
  updateRetryButton()
  if (clearSearch) elements.search.value = ''
  setStatus('ready')
  render()
}

function handleCanvasKeydown(event) {
  const direction = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
  }[event.key]
  if (!direction) return

  const fromId = document.activeElement?.getAttribute?.('data-id') || state.selected
  if (!fromId) return
  event.preventDefault()
  const next = nearestInDirection(graph.positions(), fromId, direction)
  if (next) graph.focusNode(next)
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character],
  )
}
