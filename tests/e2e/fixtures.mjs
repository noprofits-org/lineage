const doiFor = id => `10.1000/${id}`.toLowerCase()
const omidFor = id => `omid:br/06${Math.abs(hash(String(id)))}`

export const paper = (id, year, citationCount, title, referenceCount = 3, options = {}) => {
  const doi = options.doi === undefined ? doiFor(id) : options.doi
  const omid = options.omid || omidFor(id)
  const paperId = doi ? `doi:${doi.toLowerCase()}` : omid
  return {
    paperId,
    title,
    year,
    authors: options.authors || [`Author ${id}`],
    venue: options.venue === undefined ? 'Test Venue' : options.venue,
    abstract: options.abstract ?? null,
    crossrefCitedByCount: citationCount,
    openCitationCount: options.openCitationCount ?? null,
    openReferenceCount: options.openReferenceCount ?? referenceCount,
    doi: doi ? doi.toLowerCase() : null,
    aliases: [doi && `doi:${doi.toLowerCase()}`, omid, options.pmid && `pmid:${options.pmid}`]
      .filter(Boolean),
  }
}

export const crossrefWork = (value, options = {}) => ({
  DOI: value.doi,
  title: [value.title],
  author: value.authors.map(name => {
    const parts = name.split(' ')
    return { given: parts.slice(0, -1).join(' '), family: parts.at(-1) }
  }),
  ...(value.year == null ? {} : { published: { 'date-parts': [[value.year]] } }),
  ...(value.venue ? { 'container-title': [value.venue] } : {}),
  ...(value.crossrefCitedByCount == null
    ? {}
    : { 'is-referenced-by-count': value.crossrefCitedByCount }),
  ...(value.openReferenceCount == null ? {} : { 'reference-count': value.openReferenceCount }),
  ...(Object.hasOwn(options, 'abstract') && options.abstract
    ? { abstract: options.abstract }
    : {}),
})

export const crossrefSearch = papers => ({
  status: 'ok',
  'message-type': 'work-list',
  message: { items: papers.map(value => crossrefWork(value)) },
})

export const crossrefDetail = (value, options = {}) => ({
  status: 'ok',
  'message-type': 'work',
  message: crossrefWork(value, options),
})

export const pidBundle = value => value.aliases.join(' ')

export const edge = (citing, cited, options = {}) => ({
  oci: options.oci || `061-${Math.abs(hash(`${citing.paperId}->${cited.paperId}`))}`,
  citing: pidBundle(citing),
  cited: pidBundle(cited),
  creation: options.creation ?? (citing.year == null ? '' : String(citing.year)),
  timespan: options.timespan ?? deriveTimespan(citing.year, cited.year),
  journal_sc: 'no',
  author_sc: 'no',
})

export const metaRecord = value => ({
  id: value.aliases.join(' '),
  title: value.title,
  author: value.authors.map(name => `${familyFirst(name)} [omid:ra/061]`).join('; '),
  pub_date: value.year == null ? '' : String(value.year),
  venue: value.venue ? `${value.venue} [issn:1234-5678 omid:br/0609]` : '',
  type: 'journal article',
  volume: '',
  issue: '',
  page: '',
})

export const SEED = paper(
  'seed',
  1953,
  30,
  'Molecular Structure of Nucleic Acids',
  3,
  { abstract: 'A structure for deoxyribose nucleic acid.' },
)
export const REFS = [
  paper('r1', 1949, 900, 'Reference One'),
  paper('r2', 1950, 20, 'Reference Two'),
  paper('r3', null, 5, 'Undated Reference'),
]
export const CITS = Array.from({ length: 30 }, (_, index) =>
  paper(`c${index}`, 1960 + (index % 40), 1000 - index, `Citation ${index}`))

export const ALL = [SEED, ...REFS, ...CITS]

export const routes = {
  search: crossrefSearch([SEED]),
  details: new Map(ALL.filter(value => value.doi).map(value => [
    value.doi,
    crossrefDetail(value, value === SEED ? {
      abstract: '<jats:p>A structure for <jats:italic>deoxyribose</jats:italic> nucleic acid.</jats:p>',
    } : {}),
  ])),
  references: REFS.map((value, index) => edge(SEED, value, { oci: `ref-${index}` })),
  citations: CITS.map((value, index) => edge(value, SEED, { oci: `cit-${index}` })),
  referenceCount: [{ count: String(REFS.length) }],
  citationCount: [{ count: String(CITS.length) }],
  meta: new Map(ALL.flatMap(value => value.aliases.map(alias => [alias, metaRecord(value)]))),
}

export const idSelector = value => `[data-id="${value.paperId}"]`

function deriveTimespan(citingYear, citedYear) {
  if (!Number.isInteger(citingYear) || !Number.isInteger(citedYear)) return ''
  return `P${Math.max(0, citingYear - citedYear)}Y0M0D`
}

function familyFirst(name) {
  const parts = name.split(' ')
  return `${parts.at(-1)}, ${parts.slice(0, -1).join(' ')}`.trim()
}

function hash(value) {
  let result = 0
  for (const character of value) result = (result * 31 + character.charCodeAt(0)) | 0
  return result
}
