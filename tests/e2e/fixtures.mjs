export const paper = (id, year, cc, title, rc = 3) => ({
  paperId: id, title, year,
  authors: [{ name: `Author ${id}` }], venue: 'Test Venue',
  citationCount: cc, referenceCount: rc,
  externalIds: { DOI: `10.1/${id}` },
})

export const SEED = paper('seed1', 1953, 30, 'Molecular Structure of Nucleic Acids', 3)
export const REFS = [
  paper('r1', 1949, 900, 'Reference One'),
  paper('r2', 1950, 20, 'Reference Two'),
  paper('r3', null, 5, 'Undated Reference'),
]
export const CITS = Array.from({ length: 30 }, (_, i) =>
  paper(`c${i}`, 1960 + (i % 40), 1000 - i, `Citation ${i}`))

export const routes = {
  search: { total: 1, offset: 0, data: [SEED] },
  paper: { ...SEED, abstract: 'A structure for deoxyribose nucleic acid.' },
  references: { offset: 0, data: REFS.map(p => ({ citedPaper: p })) },
  citations: { offset: 0, data: CITS.map(p => ({ citingPaper: p })) },
}
