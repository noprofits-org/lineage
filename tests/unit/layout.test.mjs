import test from 'node:test'
import assert from 'node:assert/strict'
import {
  datedDomain,
  solveDomain,
  makeXScale,
  gutterX,
  nodeRadius,
  normalizeNodeSpacing,
  nearestInDirection,
  DEFAULT_NODE_SPACING,
  GUTTER_W,
  MAX_NODE_SPACING,
  MIN_NODE_SPACING,
  NODE_SPACING_STEP,
  PAD,
} from '../../graph.js'

test('layout constants reserve the specified gutter and padding', () => {
  assert.equal(GUTTER_W, 84)
  assert.equal(PAD, 24)
})

test('datedDomain ignores undated papers, widens one year, and handles none', () => {
  assert.deepEqual(
    datedDomain([{ year: 1990 }, { year: null }, { year: 2001 }]),
    [1990, 2001],
  )
  assert.deepEqual(datedDomain([{ year: 1990 }]), [1989, 1991])
  assert.equal(datedDomain([{ year: null }]), null)
})

test('datedDomain accepts any iterable of nodes', () => {
  const nodes = new Map([
    ['a', { year: 2025 }],
    ['b', { year: 1899 }],
  ])
  assert.deepEqual(datedDomain(nodes.values()), [1899, 2025])
})

test('solveDomain keeps the selected fraction exactly when feasible', () => {
  const [start, end] = solveDomain({
    minYear: 1950,
    maxYear: 2000,
    selYear: 1990,
    prevFrac: 0.5,
  })

  assert.ok(start <= 1950 && end >= 2000)
  assert.ok(Math.abs((1990 - start) / (end - start) - 0.5) < 1e-9)
})

test('solveDomain clamps a selected paper previously at the plot edge', () => {
  const [start, end] = solveDomain({
    minYear: 1900,
    maxYear: 2000,
    selYear: 1950,
    prevFrac: 0,
  })

  assert.ok(start <= 1900 && end >= 2000)
  const fraction = (1950 - start) / (end - start)
  assert.ok(fraction > 0 && fraction <= 0.03, `clamped fraction, got ${fraction}`)
})

test('solveDomain clamps symmetrically at the right plot edge', () => {
  const [start, end] = solveDomain({
    minYear: 1900,
    maxYear: 2000,
    selYear: 1950,
    prevFrac: 1,
  })
  const fraction = (1950 - start) / (end - start)

  assert.ok(start <= 1900 && end >= 2000)
  assert.ok(fraction >= 0.97 && fraction < 1, `clamped fraction, got ${fraction}`)
})

test('makeXScale maps domain ends to the padded plot and reserves gutter', () => {
  const x = makeXScale([1900, 2000], 1000)

  assert.equal(x(1900), PAD)
  assert.equal(x(2000), 1000 - GUTTER_W - PAD)
  assert.ok(gutterX(1000) > 1000 - GUTTER_W)
  assert.ok(gutterX(1000) < 1000)
})

test('nodeRadius has a 3px floor, 6px ceiling, and is monotone', () => {
  assert.equal(nodeRadius(0), 3)
  assert.ok(nodeRadius(100) > nodeRadius(10))
  assert.ok(nodeRadius(10_000_000) <= 6)
})

test('nodeRadius safely treats missing and negative counts as zero', () => {
  assert.equal(nodeRadius(null), 3)
  assert.equal(nodeRadius(undefined), 3)
  assert.equal(nodeRadius(-10), 3)
})

test('node spacing normalizes to the supported stepped range', () => {
  assert.equal(DEFAULT_NODE_SPACING, 12)
  assert.equal(MIN_NODE_SPACING, 8)
  assert.equal(MAX_NODE_SPACING, 32)
  assert.equal(NODE_SPACING_STEP, 4)
  assert.equal(normalizeNodeSpacing('20'), 20)
  assert.equal(normalizeNodeSpacing(21), 20)
  assert.equal(normalizeNodeSpacing(-10), MIN_NODE_SPACING)
  assert.equal(normalizeNodeSpacing(100), MAX_NODE_SPACING)
  assert.equal(normalizeNodeSpacing('not a number'), DEFAULT_NODE_SPACING)
})

test('nearestInDirection picks the nearest node in the 45-degree cone', () => {
  const positions = [
    { id: 'me', x: 100, y: 100 },
    { id: 'right-near', x: 160, y: 110 },
    { id: 'right-far', x: 400, y: 100 },
    { id: 'left', x: 20, y: 100 },
    { id: 'below', x: 105, y: 300 },
  ]

  assert.equal(nearestInDirection(positions, 'me', 'right'), 'right-near')
  assert.equal(nearestInDirection(positions, 'me', 'left'), 'left')
  assert.equal(nearestInDirection(positions, 'me', 'down'), 'below')
  assert.equal(nearestInDirection(positions, 'me', 'up'), null)
})

test('nearestInDirection falls back to the directional half-plane', () => {
  const positions = [
    { id: 'me', x: 100, y: 100 },
    { id: 'steep-right', x: 120, y: 40 },
    { id: 'far-steep-right', x: 130, y: 220 },
  ]

  assert.equal(
    nearestInDirection(positions, 'me', 'right'),
    'steep-right',
  )
})

test('nearestInDirection handles an unknown source or direction', () => {
  assert.equal(nearestInDirection([], 'ghost', 'left'), null)
  assert.equal(
    nearestInDirection([{ id: 'me', x: 0, y: 0 }], 'me', 'diagonal'),
    null,
  )
})
