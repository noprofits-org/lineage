// Lineage renderer. Pure layout math lives up top (unit tested); the D3
// force/SVG renderer is appended below and exercised via Playwright.

export const GUTTER_W = 84
export const PAD = 24

export function datedDomain(nodes) {
  let min = Infinity
  let max = -Infinity

  for (const node of nodes) {
    if (node.year == null) continue
    min = Math.min(min, node.year)
    max = Math.max(max, node.year)
  }

  if (min === Infinity) return null
  if (min === max) return [min - 1, max + 1]
  return [min, max]
}

export function solveDomain({ minYear, maxYear, selYear, prevFrac }) {
  const edgeFraction = 0.02
  const fraction = Math.min(
    1 - edgeFraction,
    Math.max(edgeFraction, prevFrac),
  )
  const span = Math.max(
    (selYear - minYear) / fraction,
    (maxYear - selYear) / (1 - fraction),
    1,
  )
  const start = selYear - fraction * span
  return [start, start + span]
}

export function makeXScale(domain, width) {
  const plotStart = PAD
  const plotEnd = width - GUTTER_W - PAD
  const [startYear, endYear] = domain

  return year => (
    plotStart
    + ((year - startYear) / (endYear - startYear)) * (plotEnd - plotStart)
  )
}

export function gutterX(width) {
  return width - GUTTER_W / 2
}

export function nodeRadius(citationCount) {
  const count = Math.max(0, Number(citationCount) || 0)
  return 3 + 3 * Math.min(1, Math.log10(1 + count) / 4)
}

export function nearestInDirection(positions, fromId, direction) {
  const from = positions.find(position => position.id === fromId)
  if (!from) return null

  const vector = {
    left: [-1, 0],
    right: [1, 0],
    up: [0, -1],
    down: [0, 1],
  }[direction]
  if (!vector) return null

  const [vectorX, vectorY] = vector
  const pick = predicate => {
    let closestId = null
    let closestDistance = Infinity

    for (const position of positions) {
      if (position.id === fromId) continue

      const deltaX = position.x - from.x
      const deltaY = position.y - from.y
      const along = deltaX * vectorX + deltaY * vectorY
      if (along <= 0) continue

      const orthogonal = Math.abs(deltaX * vectorY - deltaY * vectorX)
      if (!predicate(along, orthogonal)) continue

      const distance = deltaX * deltaX + deltaY * deltaY
      if (distance < closestDistance) {
        closestDistance = distance
        closestId = position.id
      }
    }

    return closestId
  }

  return pick((along, orthogonal) => orthogonal <= along) ?? pick(() => true)
}

// -------------------------------------------------------------- D3 renderer

export function createGraph(svg, { onSelect = () => {}, reducedMotion = false } = {}) {
  const d3 = window.d3
  if (!d3) throw new Error('D3 failed to load')

  const root = d3.select(svg)
  root.selectAll('*').remove()

  const defs = root.append('defs').attr('aria-hidden', 'true')
  defs.append('marker')
    .attr('id', 'tick')
    .attr('viewBox', '0 0 8 8')
    .attr('refX', 7)
    .attr('refY', 4)
    .attr('markerWidth', 8)
    .attr('markerHeight', 8)
    .attr('markerUnits', 'userSpaceOnUse')
    .attr('orient', 'auto')
    .append('path')
    .attr('class', 'cited-tick')
    .attr('d', 'M1,1 L7,4')

  const edgeLayer = root.append('g').attr('aria-hidden', 'true')
  const nodeLayer = root.append('g')
  const axisLayer = root.append('g').attr('class', 'axis').attr('aria-hidden', 'true')
  const gutterLayer = root.append('g').attr('aria-hidden', 'true')

  let simulation = null
  let nodesById = new Map()
  let previousDomain = null
  let previousDated = null
  let previousWidth = null
  let currentSelectedId = null
  let currentFocusedId = null
  let hoveredId = null
  let renderedEdges = edgeLayer.selectAll('line.edge')

  const dimensions = () => ({
    width: Math.max(240, svg.clientWidth || 800),
    height: Math.max(240, svg.clientHeight || 500),
  })

  function update({ nodes, edges, selectedId }) {
    const { width, height } = dimensions()
    const selectionChanged = selectedId !== currentSelectedId
    currentSelectedId = selectedId
    if (selectionChanged) currentFocusedId = selectedId

    if (nodes.length === 0) {
      simulation?.stop()
      simulation = null
      nodesById = new Map()
      previousDomain = null
      previousDated = null
      previousWidth = width
      currentFocusedId = null
      edgeLayer.selectAll('*').remove()
      nodeLayer.selectAll('*').remove()
      axisLayer.selectAll('*').remove()
      gutterLayer.selectAll('*').remove()
      return { widened: false }
    }

    const dated = datedDomain(nodes)
    let domain = dated || [1900, 2030]
    const selectedDatum = nodesById.get(selectedId)
    if (
      dated
      && previousDomain
      && previousWidth
      && selectedDatum?.year != null
      && selectedDatum.fx != null
    ) {
      const oldPlotWidth = Math.max(1, previousWidth - GUTTER_W - PAD * 2)
      const previousFraction = (selectedDatum.fx - PAD) / oldPlotWidth
      domain = solveDomain({
        minYear: dated[0],
        maxYear: dated[1],
        selYear: selectedDatum.year,
        prevFrac: previousFraction,
      })
    }
    const widened = Boolean(
      dated
      && previousDated
      && (dated[0] < previousDated[0] || dated[1] > previousDated[1]),
    )
    previousDomain = domain
    previousDated = dated
    previousWidth = width

    const x = makeXScale(domain, width)
    const activeIds = new Set(nodes.map(node => node.paperId))
    if (!activeIds.has(currentFocusedId)) currentFocusedId = selectedId
    for (const id of nodesById.keys()) {
      if (!activeIds.has(id)) nodesById.delete(id)
    }

    const datums = nodes.map((node, index) => {
      let datum = nodesById.get(node.paperId)
      if (!datum) {
        datum = {
          id: node.paperId,
          y: initialY(node.paperId, index, height),
        }
        nodesById.set(node.paperId, datum)
      }
      datum.node = node
      datum.year = node.year
      datum.r = nodeRadius(node.citationCount)
      datum.fx = node.year == null ? gutterX(width) : x(node.year)
      datum.x = datum.fx
      datum.y = clamp(datum.y ?? height / 2, 18, height - 54)
      return datum
    })

    const links = edges
      .filter(edge => nodesById.has(edge.citing) && nodesById.has(edge.cited))
      .map(edge => ({ source: edge.citing, target: edge.cited }))

    drawAxis(d3, axisLayer, gutterLayer, domain, width, height)

    const edgeJoin = edgeLayer.selectAll('line.edge')
      .data(links, edge => edgeKey(edge))
    edgeJoin.exit().remove()
    renderedEdges = edgeJoin.enter().append('line').attr('class', 'edge').merge(edgeJoin)

    const nodeJoin = nodeLayer.selectAll('g.node').data(datums, datum => datum.id)
    nodeJoin.exit().remove()
    const enteredNodes = nodeJoin.enter()
      .append('g')
      .attr('class', 'node')
      .attr('data-id', datum => datum.id)
      .attr('role', 'button')
    enteredNodes.append('circle').attr('class', 'hit').attr('r', 12)
    enteredNodes.append('circle').attr('class', 'dot')
    enteredNodes.append('circle').attr('class', 'ring')
    enteredNodes.append('text')
    enteredNodes
      .on('click', (event, datum) => onSelect(datum.id))
      .on('focus', (event, datum) => {
        currentFocusedId = datum.id
      })
      .on('keydown', (event, datum) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(datum.id)
        }
      })
      .on('mouseenter', (event, datum) => {
        hoveredId = datum.id
        styleEdges()
      })
      .on('mouseleave', () => {
        hoveredId = null
        styleEdges()
      })

    const renderedNodes = enteredNodes.merge(nodeJoin)
      .classed('selected', datum => datum.id === selectedId)
      .classed('undated', datum => datum.year == null)
      .classed('pinned', datum => (
        datum.id === selectedId
        || datum.node.expansion?.references?.displayedCount > 0
        || datum.node.expansion?.citations?.displayedCount > 0
      ))
      .attr('tabindex', datum => (datum.id === currentFocusedId ? 0 : -1))
      .attr('aria-label', datum => (
        `${datum.node.authors[0] || 'Unknown author'}, ${datum.year ?? 'undated'}: ${datum.node.title}`
      ))
    renderedNodes.select('circle.dot').attr('r', datum => datum.r)
    renderedNodes.select('circle.ring').attr('r', datum => datum.r + 4)
    renderedNodes.select('text').text(datum => nodeLabel(datum.node))

    function styleEdges() {
      renderedEdges
        .classed('selected-edge', edge => incident(edge, currentSelectedId))
        .classed('hover-edge', edge => incident(edge, hoveredId))
        .attr('marker-end', edge => (
          incident(edge, currentSelectedId) || incident(edge, hoveredId)
            ? 'url(#tick)'
            : null
        ))
    }
    styleEdges()

    function place() {
      for (const datum of datums) {
        datum.y = clamp(datum.y, 18, height - 54)
      }
      renderedNodes.selectAll('circle')
        .attr('cx', datum => datum.fx)
        .attr('cy', datum => datum.y)
      renderedNodes.select('text')
        .attr('x', datum => datum.fx)
        .attr('y', datum => datum.y - datum.r - 6)
        .attr('text-anchor', 'middle')
      renderedEdges
        .attr('x1', edge => edge.source.fx)
        .attr('y1', edge => edge.source.y)
        .attr('x2', edge => citedEndpoint(edge).x)
        .attr('y2', edge => citedEndpoint(edge).y)
    }

    simulation?.stop()
    simulation = d3.forceSimulation(datums)
      .force('collide', d3.forceCollide(datum => datum.r + 8).iterations(2))
      .force('y', d3.forceY(height / 2 - 14).strength(0.05))
      .force('link', d3.forceLink(links).id(datum => datum.id).strength(0))
      .on('tick', place)

    if (reducedMotion) {
      simulation.stop()
      simulation.tick(160)
    }
    place()
    return { widened }
  }

  return {
    update,
    focusNode(id) {
      const renderedNodes = nodeLayer.selectAll('g.node')
      currentFocusedId = id
      renderedNodes.attr('tabindex', datum => (datum.id === id ? 0 : -1))
      renderedNodes.filter(datum => datum.id === id).node()?.focus()
    },
    positions() {
      return [...nodesById.values()].map(datum => ({
        id: datum.id,
        x: datum.fx ?? datum.x,
        y: datum.y,
      }))
    },
  }
}

function drawAxis(d3, axisLayer, gutterLayer, domain, width, height) {
  const scale = d3.scaleLinear()
    .domain(domain)
    .range([PAD, width - GUTTER_W - PAD])
  const tickTarget = Math.max(3, Math.floor(width / 110))
  const firstYear = Math.ceil(domain[0])
  const lastYear = Math.floor(domain[1])
  const generatedTicks = firstYear <= lastYear
    ? d3.ticks(firstYear, lastYear, tickTarget)
    : [(domain[0] + domain[1]) / 2]
  const yearTicks = [...new Set(generatedTicks.map(year => Math.round(year)))]
  axisLayer
    .attr('transform', `translate(0,${height - 28})`)
    .call(
      d3.axisBottom(scale)
        .tickValues(yearTicks)
        .tickFormat(d3.format('d')),
    )

  gutterLayer.selectAll('*').remove()
  gutterLayer.append('line')
    .attr('class', 'gutter-rule')
    .attr('x1', width - GUTTER_W)
    .attr('x2', width - GUTTER_W)
    .attr('y1', 12)
    .attr('y2', height - 34)
  gutterLayer.append('text')
    .attr('class', 'gutter-label')
    .attr('x', gutterX(width))
    .attr('y', height - 36)
    .attr('text-anchor', 'middle')
    .text('undated')
}

function edgeKey(edge) {
  return `${edge.source.id ?? edge.source}→${edge.target.id ?? edge.target}`
}

function incident(edge, id) {
  if (!id) return false
  return (edge.source.id ?? edge.source) === id || (edge.target.id ?? edge.target) === id
}

function citedEndpoint(edge) {
  const source = edge.source
  const target = edge.target
  const deltaX = source.fx - target.fx
  const deltaY = source.y - target.y
  const length = Math.hypot(deltaX, deltaY) || 1
  const offset = (target.r || 3) + 2
  return {
    x: target.fx + deltaX / length * offset,
    y: target.y + deltaY / length * offset,
  }
}

function nodeLabel(node) {
  const author = node.authors[0]?.trim().split(/\s+/).pop() || '—'
  return `${author} ${node.year ?? '—'}`
}

function initialY(id, index, height) {
  let hash = 0
  for (const character of String(id)) hash = (hash * 31 + character.charCodeAt(0)) | 0
  return height / 2 + ((Math.abs(hash) + index * 17) % 81) - 40
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
