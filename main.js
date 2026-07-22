// Lineage controller + graph model. The pure model lives up top (unit
// tested); DOM wiring is appended below and only runs in the page.

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
  exp.status = 'idle'
  exp.pool = rankPool([...exp.pool, ...papers])
  exp.fetchedCount += papers.length
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
  if (exp.exhausted && exp.fetchedCount === exp.total) {
    return `showing top ${formatCount(exp.displayedCount)} of ${formatCount(exp.total)} ${noun}`
  }
  if (exp.exhausted) {
    return `showing ${formatCount(exp.displayedCount)} of ${formatCount(exp.fetchedCount)} available papers (${formatCount(exp.total)} ${noun} reported)`
  }
  return `showing top ${formatCount(exp.displayedCount)} of the first ${formatCount(exp.fetchedCount)} fetched (${formatCount(exp.total)} total)`
}
