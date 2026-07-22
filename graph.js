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
