// Lineage controller + graph model. The pure model lives up top (unit
// tested); DOM wiring is appended below and only runs in the page.

import {
  DataClient,
  SourceError,
  StaleError,
  canonicalPaperId,
  timeStratifiedOrder,
} from './data.js'
import {
  createGraph,
  nearestInDirection,
  DEFAULT_NODE_SPACING,
} from './graph.js'

export const NODE_CAP = 300
export const BATCH = 25
export const CONFIRM_LINKS = 5000
export const BLOCK_LINKS = 25000

export function createState() {
  return {
    gen: 0,
    nodes: new Map(),
    aliases: new Map(),
    edges: new Map(),
    selected: null,
    seedId: null,
  }
}

export function newExpansion(preflightCount = null) {
  return {
    status: 'idle',
    preflightCount,
    confirmation: null,
    candidates: [],
    cursor: 0,
    displayedCount: 0,
    candidateCount: null,
    totalLinks: null,
    exhausted: false,
    pool: [],
    _metadataRetryCandidates: [],
    _workToken: null,
  }
}

function paperAliases(paper) {
  return [...new Set([
    ...(paper.aliases || []),
    paper.paperId,
    paper.doi && `doi:${String(paper.doi).toLowerCase()}`,
    paper.omid,
    paper.pmid,
  ].filter(Boolean))].sort()
}

function metadataRank(paper) {
  if (paper?.metadataSource === 'crossref') return 2
  if (paper?.metadataSource === 'opencitations-meta') return 1
  return 0
}

function yearRank(source) {
  if (source === 'metadata' || source === 'crossref') return 3
  if (source === 'edge') return 2
  if (source === 'derived') return 1
  return 0
}

function isPlaceholderTitle(value) {
  return !value
    || value === 'Untitled'
    || /^DOI 10\./i.test(value)
    || /^OpenCitations record /i.test(value)
}

function mergePaperFields(target, source) {
  const targetMetadataRank = metadataRank(target)
  const sourceMetadataRank = metadataRank(source)
  const detailsUpgrade = (
    sourceMetadataRank === targetMetadataRank
    && source.detailsLoaded === true
    && target.detailsLoaded !== true
  )
  const contentUpgrade = sourceMetadataRank > targetMetadataRank || detailsUpgrade

  if (
    source.title
    && (
      !target.title
      || (isPlaceholderTitle(target.title) && !isPlaceholderTitle(source.title))
      || (contentUpgrade && !isPlaceholderTitle(source.title))
    )
  ) target.title = source.title

  if (
    Array.isArray(source.authors)
    && source.authors.length > 0
    && ((target.authors?.length || 0) === 0 || contentUpgrade)
  ) target.authors = [...source.authors]

  for (const key of ['venue', 'abstract']) {
    if (source[key] && (!target[key] || contentUpgrade)) target[key] = source[key]
  }

  if (
    source.year != null
    && (
      target.year == null
      || yearRank(source.yearSource) > yearRank(target.yearSource)
      || (
        yearRank(source.yearSource) === yearRank(target.yearSource)
        && sourceMetadataRank > targetMetadataRank
      )
      || (yearRank(source.yearSource) === yearRank(target.yearSource) && detailsUpgrade)
    )
  ) {
    target.year = source.year
    target.yearSource = source.yearSource
  }

  if (
    source.crossrefCitedByCount != null
    && (target.crossrefCitedByCount == null || contentUpgrade)
  ) target.crossrefCitedByCount = source.crossrefCitedByCount
  for (const key of ['openCitationCount', 'openReferenceCount']) {
    if (source[key] != null) target[key] = source[key]
  }
  for (const key of ['doi', 'omid', 'pmid']) {
    if (!target[key] && source[key]) target[key] = source[key]
  }

  if (sourceMetadataRank > targetMetadataRank) target.metadataSource = source.metadataSource
  if (sourceMetadataRank > 0 && source.metadataIncomplete === false) {
    target.metadataIncomplete = false
    target.metadataRetryable = false
  } else if (targetMetadataRank === 0 && source.metadataIncomplete === true) {
    target.metadataIncomplete = true
    target.metadataRetryable = source.metadataRetryable === true
  }
  if (source.detailsLoaded === true) target.detailsLoaded = true
}

function mergeCandidateEntries(entries) {
  const groups = new Set()
  const aliasGroups = new Map()

  for (const entry of entries) {
    const candidate = entry.candidate
    const aliases = paperAliases(candidate)
    const matches = new Set(aliases.map(alias => aliasGroups.get(alias)).filter(Boolean))
    let group = matches.values().next().value
    if (!group) {
      group = {
        ...candidate,
        aliases: [],
        processed: false,
      }
      groups.add(group)
    }

    for (const duplicate of matches) {
      if (duplicate === group) continue
      if (
        duplicate.year != null
        && (group.year == null || yearRank(duplicate.yearSource) > yearRank(group.yearSource))
      ) {
        group.year = duplicate.year
        group.yearSource = duplicate.yearSource
      }
      group.aliases.push(...(duplicate.aliases || []))
      group.processed ||= duplicate.processed
      groups.delete(duplicate)
    }

    if (
      candidate.year != null
      && (group.year == null || yearRank(candidate.yearSource) > yearRank(group.yearSource))
    ) {
      group.year = candidate.year
      group.yearSource = candidate.yearSource
    }
    group.aliases = [...new Set([...group.aliases, ...aliases])].sort()
    group.processed ||= entry.processed === true
    group.paperId = canonicalPaperId(group.aliases) || group.paperId
    group.doi = group.paperId.startsWith('doi:') ? group.paperId.slice(4) : null
    group.omid = group.aliases.find(alias => alias.startsWith('omid:')) || null
    group.pmid = group.aliases.find(alias => alias.startsWith('pmid:')) || null
    for (const alias of group.aliases) aliasGroups.set(alias, group)
  }

  return [...groups]
}

function mergedCandidates(candidates) {
  return mergeCandidateEntries((candidates || []).map(candidate => ({
    candidate,
    processed: false,
  }))).map(candidate => {
    delete candidate.processed
    return candidate
  })
}

export function reconcileMetadataRetries(existing, attempted, stillRetryable) {
  const attemptedAliases = new Set(
    (attempted || []).flatMap(candidate => paperAliases(candidate)),
  )
  const unresolved = (existing || []).filter(candidate => (
    !paperAliases(candidate).some(alias => attemptedAliases.has(alias))
  ))
  return mergedCandidates([...unresolved, ...(stillRetryable || [])])
}

function copyExpansion(target, source) {
  const { _workToken: ignoredWorkToken, ...stableSource } = source
  Object.assign(target, stableSource, {
    candidates: [...source.candidates],
    pool: [...(source.pool || [])],
    _metadataRetryCandidates: [...(source._metadataRetryCandidates || [])],
    confirmation: source.confirmation ? { ...source.confirmation } : null,
    _workToken: null,
  })
  return target
}

function mergeExpansionStates(target, source) {
  if (target === source) return target
  const statuses = [target.status, source.status]
  const preflightCounts = [target.preflightCount, source.preflightCount]
    .filter(count => count != null)
  const retryCandidates = [
    ...(target._metadataRetryCandidates || []),
    ...(source._metadataRetryCandidates || []),
  ]
  // Any response owned by either pre-merge node is now ambiguous. Cancel both
  // work tokens and preserve only settled expansion state on the survivor.
  target._workToken = null
  source._workToken = null

  if (target.candidateCount == null && source.candidateCount != null) {
    copyExpansion(target, source)
  } else if (target.candidateCount != null && source.candidateCount != null) {
    const entries = [target, source].flatMap(expansion => (
      expansion.candidates.map((candidate, index) => ({
        candidate,
        processed: index < expansion.cursor,
      }))
    ))
    const merged = mergeCandidateEntries(entries)
    const processed = timeStratifiedOrder(
      merged.filter(candidate => candidate.processed),
      BATCH,
    )
    const pending = timeStratifiedOrder(
      merged.filter(candidate => !candidate.processed),
      BATCH,
    )
    for (const candidate of merged) delete candidate.processed

    target.candidates = [...processed, ...pending]
    target.cursor = processed.length
    target.displayedCount = processed.length
    target.candidateCount = merged.length
    target.totalLinks = Math.max(target.totalLinks ?? 0, source.totalLinks ?? 0)
    target.exhausted = target.cursor >= target.candidateCount
    target.pool = mergedCandidates([...(target.pool || []), ...(source.pool || [])])
  }

  target.preflightCount = preflightCounts.length > 0
    ? Math.max(...preflightCounts)
    : null
  target._metadataRetryCandidates = mergedCandidates(retryCandidates)
  target._workToken = null
  target.confirmation = null
  target.status = target.candidateCount != null
    ? 'idle'
    : statuses.includes('blocked')
      ? 'blocked'
      : 'idle'
  return target
}

function rekeyRuntimeState(graphState, oldIds, canonicalId) {
  for (const oldId of oldIds) {
    if (lastDirectionByNode.has(oldId)) {
      if (!lastDirectionByNode.has(canonicalId)) {
        lastDirectionByNode.set(canonicalId, lastDirectionByNode.get(oldId))
      }
      lastDirectionByNode.delete(oldId)
    }

    for (const [operationId] of [...pendingRetries]) {
      const expandPrefix = `expand:${oldId}:`
      const metadataPrefix = `metadata:${oldId}:`
      const paperPrefix = `paper:${oldId}:`
      if (operationId.startsWith(expandPrefix)) {
        const suffix = operationId.slice(expandPrefix.length)
        const direction = suffix.split(':')[0]
        const nextId = `expand:${canonicalId}:${suffix}`
        pendingRetries.delete(operationId)
        pendingRetries.set(nextId, () => {
          const current = graphState.nodes.get(canonicalId)
          if (!current) return
          current.expansion[direction].status = 'idle'
          expand(current, direction, nextId)
        })
      } else if (operationId.startsWith(metadataPrefix)) {
        const direction = operationId.slice(metadataPrefix.length).split(':')[0]
        const nextId = metadataRetryKey(canonicalId, direction)
        pendingRetries.delete(operationId)
        pendingRetries.set(nextId, () => {
          const current = graphState.nodes.get(canonicalId)
          if (current) retryHydration(current, direction, nextId)
        })
      } else if (operationId.startsWith(paperPrefix)) {
        const suffix = operationId.slice(paperPrefix.length)
        const nextId = `paper:${canonicalId}:${suffix}`
        pendingRetries.delete(operationId)
        pendingRetries.set(nextId, () => {
          const current = graphState.nodes.get(canonicalId)
          if (current) loadDetails(current, nextId)
        })
      }
    }
  }
  if (elements?.retry) {
    const current = graphState.nodes.get(canonicalId)
    if (current) {
      for (const direction of ['references', 'citations']) {
        syncMetadataRetry(current, direction)
      }
    }
    updateRetryButton()
  }
}

function rewireState(state, oldIds, canonicalId) {
  if (oldIds.size === 0) return
  const edges = [...state.edges.values()]
  state.edges.clear()
  for (const edge of edges) {
    addEdge(
      state,
      oldIds.has(edge.citing) ? canonicalId : edge.citing,
      oldIds.has(edge.cited) ? canonicalId : edge.cited,
    )
  }
  if (oldIds.has(state.selected)) state.selected = canonicalId
  if (oldIds.has(state.seedId)) state.seedId = canonicalId
}

export function addPaper(state, paper) {
  const incomingAliases = paperAliases(paper)
  const existingIds = new Set(incomingAliases.map(alias => state.aliases.get(alias)).filter(Boolean))
  if (state.nodes.has(paper.paperId)) existingIds.add(paper.paperId)
  const existingNodes = [...existingIds].map(id => state.nodes.get(id)).filter(Boolean)
  const originalIds = existingNodes.map(existing => existing.paperId)
  const aliases = [...new Set([
    ...incomingAliases,
    ...existingNodes.flatMap(node => node.aliases || [node.paperId]),
  ])].sort()
  const canonicalId = canonicalPaperId(aliases) || paper.paperId

  let node = existingNodes[0]
  if (!node) {
    node = {
      ...paper,
      paperId: canonicalId,
      aliases,
      authors: [...(paper.authors || [])],
      expansion: {
        references: newExpansion(paper.openReferenceCount ?? null),
        citations: newExpansion(paper.openCitationCount ?? null),
      },
    }
  } else {
    mergePaperFields(node, paper)
    node.aliases = aliases
    for (const duplicate of existingNodes.slice(1)) {
      mergePaperFields(node, duplicate)
      for (const direction of ['references', 'citations']) {
        const targetExpansion = node.expansion[direction]
        const duplicateExpansion = duplicate.expansion[direction]
        mergeExpansionStates(targetExpansion, duplicateExpansion)
      }
    }
    node.paperId = canonicalId
  }

  if (canonicalId.startsWith('doi:')) node.doi = canonicalId.slice(4)
  node.omid ||= aliases.find(alias => alias.startsWith('omid:')) || null
  node.pmid ||= aliases.find(alias => alias.startsWith('pmid:')) || null
  for (const [direction, count] of [
    ['references', node.openReferenceCount],
    ['citations', node.openCitationCount],
  ]) {
    const expansion = node.expansion[direction]
    if (count != null && expansion.candidateCount == null && expansion.status === 'idle') {
      expansion.preflightCount = count
    }
  }

  const oldIds = new Set(originalIds.filter(id => id !== canonicalId))
  for (const id of oldIds) state.nodes.delete(id)
  state.nodes.set(canonicalId, node)
  for (const alias of aliases) state.aliases.set(alias, canonicalId)
  for (const [alias, id] of state.aliases) {
    if (oldIds.has(id)) state.aliases.set(alias, canonicalId)
  }
  rewireState(state, oldIds, canonicalId)
  rekeyRuntimeState(state, oldIds, canonicalId)
  return node
}

export function addEdge(state, citing, cited) {
  if (citing === cited) return false

  const key = `${citing}→${cited}`
  if (state.edges.has(key)) return false

  state.edges.set(key, { citing, cited })
  return true
}

export function completeFetch(exp, { candidates, totalLinks }) {
  const unique = mergeCandidateEntries((candidates || []).map(candidate => ({
    candidate,
    processed: false,
  })))
  exp.status = 'idle'
  exp.confirmation = null
  for (const candidate of unique) delete candidate.processed
  exp.candidates = timeStratifiedOrder(unique, BATCH)
  exp.cursor = 0
  exp.candidateCount = exp.candidates.length
  exp.totalLinks = Number.isFinite(totalLinks) ? totalLinks : exp.candidateCount
  exp.exhausted = exp.candidates.length === 0
}

export function nextCandidateBatch(exp, batchSize = BATCH) {
  return exp.candidates.slice(exp.cursor, exp.cursor + batchSize)
}

function resolvePaperNode(graphState, paper) {
  if (!paper) return null
  if (graphState.nodes.get(paper.paperId) === paper) return paper
  for (const alias of paperAliases(paper)) {
    const paperId = graphState.aliases.get(alias)
    const node = graphState.nodes.get(paperId)
    if (node) return node
  }
  return null
}

function overlayHydratedCandidate(candidate, paper) {
  const aliases = [...new Set([
    ...paperAliases(candidate),
    ...paperAliases(paper),
  ])].sort()
  const paperId = canonicalPaperId(aliases) || paper.paperId || candidate.paperId
  return {
    ...candidate,
    ...paper,
    paperId,
    aliases,
    doi: aliases.find(alias => alias.startsWith('doi:'))?.slice(4) || null,
    omid: aliases.find(alias => alias.startsWith('omid:')) || null,
    pmid: aliases.find(alias => alias.startsWith('pmid:')) || null,
    year: paper.year ?? candidate.year ?? null,
    yearSource: paper.year != null ? paper.yearSource : candidate.yearSource,
  }
}

function candidateGroupsFromEntries(entries) {
  const candidates = mergeCandidateEntries(entries)
  const aliasToGroup = new Map()
  const groups = candidates.map(candidate => {
    const group = {
      candidate,
      processed: candidate.processed === true,
      wasProcessed: candidate.processed === true,
      current: false,
      variants: [],
      order: Number.POSITIVE_INFINITY,
      self: false,
    }
    delete candidate.processed
    for (const alias of paperAliases(candidate)) aliasToGroup.set(alias, group)
    return group
  })

  for (const entry of entries) {
    const group = paperAliases(entry.candidate)
      .map(alias => aliasToGroup.get(alias))
      .find(Boolean)
    if (!group) continue
    group.current ||= entry.current
    group.variants.push(...entry.variants)
    group.order = Math.min(group.order, entry.order)
  }
  return groups.sort((left, right) => left.order - right.order)
}

function mergeKnownEquivalentCandidates(left, right) {
  const aliases = [...new Set([
    ...paperAliases(left),
    ...paperAliases(right),
  ])].sort()
  const bridge = {
    ...left,
    paperId: canonicalPaperId(aliases) || left.paperId || right.paperId,
    aliases,
  }
  return mergedCandidates([left, right, bridge])[0]
}

function mergeCandidateGroup(target, source) {
  target.candidate = mergeKnownEquivalentCandidates(
    target.candidate,
    source.candidate,
  )
  target.processed ||= source.processed
  target.wasProcessed ||= source.wasProcessed
  target.current ||= source.current
  target.variants.push(...source.variants)
  target.order = Math.min(target.order, source.order)
  target.self ||= source.self
  return target
}

function resolvedCandidateNodes(graphState, candidate) {
  const nodes = new Set()
  for (const alias of paperAliases(candidate)) {
    const paperId = graphState.aliases.get(alias)
    const node = paperId ? graphState.nodes.get(paperId) : null
    if (node) nodes.add(node)
  }
  return nodes
}

function coalesceGroupsByResolvedNode(graphState, groups) {
  const byNode = new Map()
  const result = new Set()
  for (const group of groups) {
    const resolvedNodes = resolvedCandidateNodes(graphState, group.candidate)
    const matches = [...new Set(
      [...resolvedNodes]
        .map(node => byNode.get(node))
        .filter(Boolean),
    )]
    const target = matches[0] || group

    if (matches.length === 0) {
      result.add(target)
    } else {
      mergeCandidateGroup(target, group)
    }

    for (const duplicate of matches.slice(1)) {
      mergeCandidateGroup(target, duplicate)
      result.delete(duplicate)
      for (const [node, mappedGroup] of byNode) {
        if (mappedGroup === duplicate) byNode.set(node, target)
      }
    }

    for (const node of resolvedNodes) byNode.set(node, target)
  }
  return [...result].sort((left, right) => left.order - right.order)
}

function hydratedCandidateGroups(graphState, exp, papers) {
  const start = exp.cursor
  const end = Math.min(start + papers.length, exp.candidates.length)
  const entries = exp.candidates.map((candidate, index) => {
    const current = index >= start && index < end
    const paper = current ? papers[index - start] : null
    return {
      candidate: paper ? overlayHydratedCandidate(candidate, paper) : candidate,
      processed: index < start,
      current,
      variants: paper ? [paper] : [],
      order: index,
    }
  })
  return coalesceGroupsByResolvedNode(
    graphState,
    candidateGroupsFromEntries(entries),
  )
}

function groupResolvesToNode(graphState, group, node) {
  return paperAliases(group.candidate).some(alias => (
    graphState.aliases.get(alias) === node.paperId
  ))
}

function finishHydratedGroups(graphState, node, direction, groups) {
  const currentNode = resolvePaperNode(graphState, node) || node
  const expansion = currentNode.expansion[direction]
  for (const group of groups) {
    group.self ||= groupResolvesToNode(graphState, group, currentNode)
  }
  const visible = groups.filter(group => !group.self)
  const processed = visible.filter(group => group.processed)
  const pending = visible.filter(group => !group.processed)
  expansion.candidates = [...processed, ...pending].map(group => group.candidate)
  expansion.cursor = processed.length
  expansion.displayedCount = processed.length
  expansion.candidateCount = visible.length
  expansion.exhausted = expansion.cursor >= expansion.candidateCount
  if (direction === 'citations') currentNode.openCitationCount = expansion.candidateCount
  else currentNode.openReferenceCount = expansion.candidateCount
  return { node: currentNode, expansion }
}

export function reconcileRetriedExpansion(
  graphState,
  node,
  direction,
  attemptedCandidates,
  papers,
) {
  const currentNode = resolvePaperNode(graphState, node) || node
  const expansion = currentNode.expansion[direction]
  const entries = expansion.candidates.map((candidate, index) => ({
    candidate,
    processed: index < expansion.cursor,
    current: false,
    variants: [],
    order: index,
  }))
  for (let index = 0; index < attemptedCandidates.length; index += 1) {
    const attempted = attemptedCandidates[index]
    const paper = papers[index]
    if (!paper) continue
    const aliases = new Set(paperAliases(attempted))
    const directIndex = expansion.candidates.findIndex(candidate => (
      paperAliases(candidate).some(alias => aliases.has(alias))
    ))
    entries.push({
      candidate: overlayHydratedCandidate(attempted, paper),
      processed: true,
      current: false,
      variants: [],
      order: directIndex < 0 ? expansion.candidates.length + index : directIndex,
    })
  }
  const groups = coalesceGroupsByResolvedNode(
    graphState,
    candidateGroupsFromEntries(entries),
  )
  return finishHydratedGroups(graphState, currentNode, direction, groups)
}

export function admit(state, node, direction, papersOrOptions, maybeOptions = {}) {
  let currentNode = resolvePaperNode(state, node) || node
  let exp = currentNode.expansion[direction]
  const explicitPapers = Array.isArray(papersOrOptions)
  const papers = explicitPapers
    ? papersOrOptions.slice(0, BATCH)
    : exp.pool.slice(0, BATCH)
  const options = explicitPapers ? maybeOptions : (papersOrOptions || {})
  const cap = options.cap ?? NODE_CAP
  const admitted = []
  const attempted = []
  let capped = false
  let incomplete = 0
  const retryable = []

  if (explicitPapers && exp.candidateCount != null) {
    const groups = hydratedCandidateGroups(state, exp, papers)
    for (const group of groups.filter(candidateGroup => candidateGroup.current)) {
      currentNode = resolvePaperNode(state, currentNode) || currentNode
      group.self = groupResolvesToNode(state, group, currentNode)
      const isNew = !paperAliases(group.candidate).some(alias => state.aliases.has(alias))
      if (!group.processed && !group.self && isNew && state.nodes.size >= cap) {
        capped = true
        break
      }

      let other = null
      for (const paper of group.variants) other = addPaper(state, paper)
      currentNode = resolvePaperNode(state, currentNode) || currentNode
      other = resolvePaperNode(state, group.candidate) || other
      attempted.push(group.candidate)
      group.self ||= !other || other === currentNode || groupResolvesToNode(state, group, currentNode)
      if (!group.self && other.metadataRetryable) retryable.push(group.candidate)
      if (group.self || group.processed) continue

      if (direction === 'citations') {
        addEdge(state, other.paperId, currentNode.paperId)
      } else {
        addEdge(state, currentNode.paperId, other.paperId)
      }
      group.processed = true
      admitted.push(other)
      if (other.metadataIncomplete) incomplete += 1
    }

    const settled = finishHydratedGroups(state, currentNode, direction, groups)
    currentNode = settled.node
    exp = settled.expansion
    const requested = groups.filter(group => (
      group.current && !group.wasProcessed && !group.self
    )).length
    return {
      admitted,
      attempted,
      capped,
      requested,
      incomplete,
      retryable: mergedCandidates(retryable),
      node: currentNode,
      expansion: exp,
    }
  }

  const requested = papers.length
  let processed = 0
  for (const paper of papers) {
    const aliases = paperAliases(paper)
    const isNew = !aliases.some(alias => state.aliases.has(alias))

    if (isNew && state.nodes.size >= cap) {
      capped = true
      break
    }

    const other = addPaper(state, paper)
    currentNode = resolvePaperNode(state, currentNode) || currentNode
    exp = currentNode.expansion[direction]
    if (direction === 'citations') {
      addEdge(state, other.paperId, currentNode.paperId)
    } else {
      addEdge(state, currentNode.paperId, other.paperId)
    }
    admitted.push(other)
    attempted.push(paper)
    if (other.metadataIncomplete) incomplete += 1
    if (other.metadataRetryable) retryable.push(paper)
    exp.displayedCount += 1
    processed += 1
  }

  exp.cursor += processed
  if (!explicitPapers) exp.pool.splice(0, processed)
  if (exp.candidateCount != null) exp.exhausted = exp.cursor >= exp.candidates.length

  return {
    admitted,
    attempted,
    capped,
    requested,
    incomplete,
    retryable,
    node: currentNode,
    expansion: exp,
  }
}

const formatCount = number => number.toLocaleString('en-US')

export function disclosure(exp, noun) {
  const total = exp.candidateCount ?? exp.preflightCount ?? 0
  if (exp.displayedCount >= total) {
    return `showing ${formatCount(exp.displayedCount)} of ${formatCount(total)} known open ${noun}`
  }
  const singular = noun === 'citations' ? 'citation' : 'reference'
  return `showing ${formatCount(exp.displayedCount)} representative ${noun} from ${formatCount(total)} known open ${singular} links`
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

function metadataRetryKey(paperId, direction) {
  return `metadata:${paperId}:${direction}`
}

function syncMetadataRetry(node, direction) {
  if (!elements?.retry) return
  const current = resolvePaperNode(state, node)
  if (!current) return
  const expansion = current.expansion[direction]
  const operationId = metadataRetryKey(current.paperId, direction)
  if (expansion._metadataRetryCandidates.length === 0) {
    clearRetry(operationId)
    return
  }
  queueRetry(operationId, () => {
    const latest = state.nodes.get(current.paperId)
      || resolvePaperNode(state, current)
    if (!latest) return
    const latestExpansion = latest.expansion[direction]
    if (['preflighting', 'fetching', 'hydrating'].includes(latestExpansion.status)) {
      syncMetadataRetry(latest, direction)
      setStatus('metadata retry queued until the current request finishes')
      return
    }
    retryHydration(latest, direction, metadataRetryKey(latest.paperId, direction))
  })
}

function beginExpansionWork(node, direction) {
  const expansion = node.expansion[direction]
  const generation = state.gen
  const token = {}
  expansion._workToken = token
  return {
    isStale: () => (
      generation !== state.gen
      || state.nodes.get(node.paperId) !== node
      || expansion._workToken !== token
    ),
    finish: () => {
      if (expansion._workToken === token) expansion._workToken = null
    },
  }
}

function clearConfirmations() {
  for (const node of state.nodes.values()) {
    for (const direction of ['references', 'citations']) {
      const expansion = node.expansion[direction]
      if (expansion.status === 'confirm') {
        expansion.status = 'idle'
        expansion.preflightCount = null
      }
      expansion.confirmation = null
    }
  }
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
    if (expansion.candidateCount != null && !expansion.exhausted) return direction
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
    layoutControls: byId('layout-controls'),
    spacing: byId('node-spacing'),
    spacingValue: byId('node-spacing-value'),
    resetLayout: byId('reset-layout'),
  }

  client = new DataClient({
    onStatus: status => {
      if (status.state === 'loading') setStatus(status.message || 'fetching…')
      else if (status.state === 'backoff' || status.state === 'note') setStatus(status.message)
      else if (status.state === 'idle' && elements.status.textContent.startsWith('fetching from ')) {
        setStatus('ready')
      }
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
  elements.spacing.addEventListener('input', () => {
    const spacing = graph.setSpacing(elements.spacing.value)
    elements.spacing.value = String(spacing)
    elements.spacingValue.value = `${spacing}px`
    elements.spacing.setAttribute('aria-valuetext', `${spacing} pixels between nodes`)
    setStatus(`node spacing set to ${spacing} pixels`)
  })
  elements.resetLayout.addEventListener('click', () => {
    graph.resetVerticalPositions()
    setStatus('automatic vertical layout restored')
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
    setStatus(error?.message || 'search failed')
    if (error instanceof SourceError && error.retryable) {
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
  elements.layoutControls.hidden = false
  const node = addPaper(state, paper)
  state.seedId = node.paperId
  select(node.paperId)
}

export function select(paperId) {
  const node = state.nodes.get(paperId)
  if (!node) return
  if (state.selected !== paperId) {
    selectionSequence += 1
    clearRetriesMatching('paper:')
    clearConfirmations()
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
  let expansion = node.expansion[direction]
  if (['preflighting', 'fetching', 'hydrating'].includes(expansion.status)) return
  if (expansion.status === 'blocked') return

  if (expansion.status === 'confirm') {
    const confirmation = expansion.confirmation
    if (
      !confirmation
      || confirmation.generation !== state.gen
      || confirmation.count !== expansion.preflightCount
    ) {
      expansion.status = 'idle'
      expansion.confirmation = null
      expansion.preflightCount = null
    } else {
      confirmation.accepted = true
      expansion.status = 'idle'
    }
  }

  const retryPrefix = `expand:${node.paperId}:${direction}:`
  if (operationId == null) {
    clearRetriesMatching(retryPrefix)
    operationId = nextOperationId(`expand:${node.paperId}:${direction}`)
  }
  clearRetry(operationId)
  const generation = state.gen
  const work = beginExpansionWork(node, direction)
  const isStale = work.isStale

  try {
    if (expansion.candidateCount == null) {
      if (expansion.preflightCount == null) {
        expansion.status = 'preflighting'
        refreshSelectedInspector(node)
        const count = await client.connectionCount(node, direction, isStale)
        if (isStale()) throw new StaleError()
        expansion.preflightCount = count
        if (direction === 'citations') node.openCitationCount = count
        else node.openReferenceCount = count
      }

      const count = expansion.preflightCount
      if (count === 0) {
        expansion.status = 'idle'
        expansion.candidateCount = 0
        expansion.totalLinks = 0
        expansion.exhausted = true
        clearRetry(operationId)
        setStatus(`no known open ${direction}`)
        refreshSelectedInspector(node)
        return
      }
      if (count > BLOCK_LINKS) {
        expansion.status = 'blocked'
        expansion.confirmation = null
        clearRetry(operationId)
        setStatus(`${formatCount(count)} known open ${direction} — exceeds Lineage’s ${formatCount(BLOCK_LINKS)}-link browser limit`)
        refreshSelectedInspector(node)
        return
      }
      if (count > CONFIRM_LINKS && !expansion.confirmation?.accepted) {
        // A selection change invalidates a pending large-download gesture,
        // including one that happens while the count request is in flight.
        if (state.selected !== node.paperId) {
          expansion.status = 'idle'
          expansion.confirmation = null
          clearRetry(operationId)
          return
        }
        expansion.status = 'confirm'
        expansion.confirmation = { generation, count, accepted: false }
        clearRetry(operationId)
        setStatus(`${formatCount(count)} known open ${direction} — activate show ${direction} again to load`)
        refreshSelectedInspector(node)
        return
      }

      expansion.status = 'fetching'
      refreshSelectedInspector(node)
      const result = await client.connections(node, direction, isStale)
      if (isStale()) throw new StaleError()
      completeFetch(expansion, result)
      // After normalization, the deduplicated candidate count is the graph's
      // truthful known-open total. Raw provider rows may contain duplicates.
      if (direction === 'citations') node.openCitationCount = expansion.candidateCount
      else node.openReferenceCount = expansion.candidateCount
    }

    if (expansion.exhausted) {
      clearRetry(operationId)
      refreshSelectedInspector(node)
      if (expansion.displayedCount === 0) setStatus(`no identifiable open ${direction} found`)
      return
    }

    const candidates = nextCandidateBatch(expansion)
    expansion.status = 'hydrating'
    refreshSelectedInspector(node)
    const papers = await client.hydrateCandidates(candidates, isStale)
    if (isStale()) throw new StaleError()
    const result = admit(state, node, direction, papers, { cap: configuredNodeCap() })
    if (isStale()) throw new StaleError()
    node = result.node
    expansion = result.expansion
    expansion.status = 'idle'
    clearRetry(operationId)
    expansion._metadataRetryCandidates = reconcileMetadataRetries(
      expansion._metadataRetryCandidates,
      result.attempted,
      result.retryable,
    )
    syncMetadataRetry(node, direction)

    let message = disclosure(expansion, direction)
    if (result.capped) {
      message += ` — node cap reached — added ${result.admitted.length} of ${result.requested}`
    }
    if (result.incomplete > 0) {
      message += ` — metadata incomplete for ${formatCount(result.incomplete)} paper${result.incomplete === 1 ? '' : 's'}`
    }
    const retryCount = expansion._metadataRetryCandidates.length
    if (retryCount > 0) {
      if (result.incomplete === 0) {
        message += ` — metadata incomplete for ${formatCount(retryCount)} paper${retryCount === 1 ? '' : 's'}`
      }
      message += ' — retry available'
    }
    refreshSelectedInspector(node)
    const { widened } = render()
    setOutcomeStatus(message, widened)
  } catch (error) {
    if (error instanceof StaleError || isStale()) {
      clearRetry(operationId)
      return
    }
    expansion.status = 'error'
    setStatus(error?.message || `${direction} request failed`)
    if (error instanceof SourceError && error.retryable) {
      const retryId = `expand:${node.paperId}:${direction}:${operationId.split(':').at(-1)}`
      clearRetry(operationId)
      queueRetry(retryId, () => {
        expansion.status = 'idle'
        expand(node, direction, retryId)
      })
    } else {
      clearRetry(operationId)
    }
    refreshSelectedInspector(node)
  } finally {
    work.finish()
  }
}

async function retryHydration(
  node,
  direction,
  operationId = metadataRetryKey(node.paperId, direction),
) {
  node = resolvePaperNode(state, node)
  if (!node || state.nodes.get(node.paperId) !== node) {
    clearRetry(operationId)
    return
  }
  let expansion = node.expansion[direction]
  const candidates = [...expansion._metadataRetryCandidates]
  if (candidates.length === 0) {
    clearRetry(operationId)
    return
  }
  const generation = state.gen
  const work = beginExpansionWork(node, direction)
  const isStale = work.isStale
  clearRetry(operationId)
  expansion.status = 'hydrating'
  refreshSelectedInspector(node)

  try {
    const papers = await client.hydrateCandidates(candidates, isStale)
    if (isStale()) throw new StaleError()
    const retryable = []
    const incompleteNodes = new Set()
    for (const paper of papers) {
      const updated = addPaper(state, paper)
      if (isStale()) throw new StaleError()
      if (updated.metadataIncomplete) incompleteNodes.add(updated.paperId)
      if (updated.metadataRetryable) retryable.push(paper)
    }
    const settled = reconcileRetriedExpansion(
      state,
      node,
      direction,
      candidates,
      papers,
    )
    node = settled.node
    expansion = settled.expansion
    expansion.status = 'idle'
    expansion._metadataRetryCandidates = reconcileMetadataRetries(
      expansion._metadataRetryCandidates,
      papers,
      retryable,
    )
    syncMetadataRetry(node, direction)
    refreshSelectedInspector(node)
    const { widened } = render()
    const incomplete = incompleteNodes.size
    const retryCount = expansion._metadataRetryCandidates.length
    const message = retryCount > 0
      ? `metadata still incomplete for ${formatCount(incomplete)} paper${incomplete === 1 ? '' : 's'} — retry available`
      : incomplete > 0
        ? `metadata remains incomplete for ${formatCount(incomplete)} paper${incomplete === 1 ? '' : 's'}`
        : 'paper metadata refreshed'
    setOutcomeStatus(message, widened)
  } catch (error) {
    if (error instanceof StaleError || isStale()) {
      clearRetry(operationId)
      if (generation === state.gen) {
        const current = resolvePaperNode(state, node)
        if (current) syncMetadataRetry(current, direction)
      }
      return
    }
    expansion.status = 'error'
    setStatus(error?.message || 'paper metadata refresh failed')
    if (error instanceof SourceError && error.retryable) {
      syncMetadataRetry(node, direction)
    } else {
      clearRetry(operationId)
    }
    refreshSelectedInspector(node)
  } finally {
    work.finish()
  }
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
  field('insp-title').textContent = node.title || node.doi || node.omid || node.paperId
  field('insp-meta').textContent = [
    (node.authors || []).join(', '),
    node.year ?? 'undated',
    node.venue,
    node.metadataIncomplete ? 'metadata incomplete' : null,
  ].filter(Boolean).join(' · ')
  const countFacts = []
  if (node.crossrefCitedByCount != null) {
    countFacts.push(`${formatCount(node.crossrefCitedByCount)} Crossref cited-by`)
  }
  if (node.openCitationCount != null) {
    countFacts.push(`${formatCount(node.openCitationCount)} known open citations`)
  }
  if (node.openReferenceCount != null) {
    countFacts.push(`${formatCount(node.openReferenceCount)} known open references`)
  }
  field('insp-counts').textContent = countFacts.join(' · ')
  field('insp-counts').hidden = countFacts.length === 0

  const abstract = field('insp-abstract')
  abstract.textContent = node.abstract ?? ''
  abstract.hidden = !node.abstract
  fillInspectorLinks(field('insp-links'), node)
  fillRelationships(field, node)

  for (const direction of ['references', 'citations']) {
    const expansion = node.expansion[direction]
    const status = field(`${direction}-status`)
    const button = field(`expand-${direction}`)
    button.textContent = expansion.status === 'confirm'
      ? `load ${formatCount(expansion.preflightCount)} ${direction}`
      : `show ${direction}`
    button.disabled = (
      ['preflighting', 'fetching', 'hydrating', 'blocked'].includes(expansion.status)
      || (expansion.candidateCount != null && expansion.exhausted)
      || state.nodes.size >= configuredNodeCap()
    )
    if (expansion.status === 'confirm') {
      button.setAttribute(
        'aria-label',
        `Load ${formatCount(expansion.preflightCount)} known open ${direction}; large download confirmation`,
      )
    } else {
      button.removeAttribute('aria-label')
    }

    if (expansion.status === 'preflighting') {
      status.textContent = `checking known open ${direction}…`
      status.hidden = false
    } else if (expansion.status === 'confirm') {
      status.textContent = `${formatCount(expansion.preflightCount)} known open ${direction} — activate the button again to load`
      status.hidden = false
    } else if (expansion.status === 'blocked') {
      status.textContent = `${formatCount(expansion.preflightCount)} known open ${direction} — exceeds the browser safety limit`
      status.hidden = false
    } else if (expansion.status === 'fetching') {
      status.textContent = `fetching ${direction} links…`
      status.hidden = false
    } else if (expansion.status === 'hydrating') {
      status.textContent = `loading ${direction} paper details…`
      status.hidden = false
    } else if (expansion.status === 'error') {
      const retryable = (
        hasRetryMatching(`expand:${node.paperId}:${direction}:`)
        || hasRetryMatching(metadataRetryKey(node.paperId, direction))
      )
      status.textContent = retryable
        ? `${direction} request failed — retry available`
        : `${direction} request failed`
      status.hidden = false
    } else if (
      state.nodes.size >= configuredNodeCap()
      && expansion.candidateCount != null
      && !expansion.exhausted
    ) {
      status.textContent = 'node cap reached — reset to explore another neighborhood'
      status.hidden = false
    } else if (expansion.candidateCount != null) {
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

  loadDetails(node)
}

function loadDetails(node, operationId = null) {
  if (node.detailsLoaded || state.nodes.get(node.paperId) !== node) return

  const retryPrefix = `paper:${node.paperId}:`
  if (operationId == null && hasRetryMatching(retryPrefix)) return

  const requestKey = `${state.gen}:${selectionSequence}`
  if (node._detailsRequested === requestKey) return
  if (operationId == null) {
    clearRetriesMatching(retryPrefix)
    operationId = nextOperationId(`paper:${node.paperId}`)
  }
  clearRetry(operationId)
  node._detailsRequested = requestKey

  const generation = state.gen
  const selection = selectionSequence
  const isStale = () => (
    generation !== state.gen
    || selection !== selectionSequence
    || state.selected !== node.paperId
    || elements.inspector.hidden
  )

  client.directPaper(node, isStale).then(full => {
    clearRetry(operationId)
    if (node._detailsRequested === requestKey) delete node._detailsRequested
    if (!isStale() && full && state.nodes.get(node.paperId) === node) {
      const updated = addPaper(state, { ...full, detailsLoaded: true })
      if (state.selected === updated.paperId && !elements.inspector.hidden) {
        showInspector(updated)
        const { widened } = render()
        if (widened) setOutcomeStatus('paper details loaded', true)
      }
    } else if (!isStale() && state.nodes.get(node.paperId) === node) {
      node.detailsLoaded = true
    }
  }).catch(error => {
    if (node._detailsRequested === requestKey) {
      delete node._detailsRequested
    }
    if (error instanceof StaleError || isStale()) {
      clearRetry(operationId)
      return
    }
    setStatus(error?.message || 'paper details unavailable')
    if (error instanceof SourceError && error.retryable) {
      queueRetry(operationId, () => {
        if (isStale()) {
          clearRetry(operationId)
          return
        }
        loadDetails(node, operationId)
      })
    } else {
      // A permanent provider response (for example, Crossref 404) cannot be
      // improved by reselecting the same paper. Keep the edge-derived fields
      // and avoid repeating the failed request on every inspector render.
      if (error instanceof SourceError) node.detailsLoaded = true
      clearRetry(operationId)
    }
  })
}

function fillInspectorLinks(container, node) {
  container.replaceChildren()
  const links = []
  if (node.doi) links.push(['DOI', doiHref(node.doi)])
  if (node.doi) {
    links.push([
      'Crossref',
      `https://search.crossref.org/?q=${encodeURIComponent(node.doi)}`,
    ])
  }
  links.push([
    'OpenCitations',
    `https://opencitations.net/index?text=${encodeURIComponent(node.doi || node.omid || node.pmid || node.paperId)}`,
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
  state.aliases.clear()
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
  elements.layoutControls.hidden = true
  updateRetryButton()
  if (clearSearch) elements.search.value = ''
  setStatus('ready')
  render()
}

function handleCanvasKeydown(event) {
  const fromId = document.activeElement?.getAttribute?.('data-id') || state.selected
  if (!fromId) return
  if (event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault()
    graph.nudgeNode(fromId, event.key === 'ArrowUp' ? -DEFAULT_NODE_SPACING : DEFAULT_NODE_SPACING)
    setStatus(`paper moved ${event.key === 'ArrowUp' ? 'up' : 'down'}`)
    return
  }

  const direction = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
  }[event.key]
  if (!direction) return

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
