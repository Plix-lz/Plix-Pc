// Coincidencia de texto del buscador, misma lógica que la app Plix (TmdbClient.java).
const searchMatch = (() => {
  const VARIANT_LIMIT = 10
  const MIN_SCORE = 0.52

  /** "Spider-Man: No Way Home" → "spider man no way home" */
  function normalize(value) {
    if (!value) return ''
    return String(value)
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/&/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
  }

  /** "spider-man" / "spider man" → "spiderman" */
  function compact(value) {
    return normalize(value).replace(/ /g, '')
  }

  function isVowel(char) {
    return 'aeiou'.includes(char)
  }

  function singularize(word) {
    const length = word.length
    if (length > 4 && word.endsWith('ces')) return word.slice(0, -3) + 'z'
    if (length > 4 && word.endsWith('es')) {
      const root = word.slice(0, -2)
      if (!isVowel(root.at(-1))) return root
    }
    if (length > 3 && word.endsWith('s') && isVowel(word.at(-2))) return word.slice(0, -1)
    return word
  }

  function pluralize(word) {
    const singular = singularize(word)
    if (singular.endsWith('z')) return singular.slice(0, -1) + 'ces'
    return singular + (isVowel(singular.at(-1)) ? 's' : 'es')
  }

  function buildVariants(query) {
    const clean = normalize(query)
    const compacted = compact(query)
    if (!clean && !compacted) return []

    const variants = new Set([query.trim(), clean, compacted])
    const words = clean ? clean.split(' ') : []

    if (words.length) {
      const singular = words.map(singularize).join(' ')
      const plural = words.map(pluralize).join(' ')
      variants.add(singular).add(plural).add(compact(singular)).add(compact(plural))

      if (words.length > 1) {
        variants.add([...words].reverse().join(' '))
        variants.add(singular.split(' ').reverse().join(' '))
        // Consultar términos por separado recupera títulos aunque se escriban desordenados.
        words.filter(word => word.length >= 3).forEach(word => variants.add(word))
      } else if (clean.length >= 5) {
        // TMDB admite coincidencias parciales; este prefijo ayuda con una última letra errónea.
        variants.add(clean.slice(0, -1))
      }
    }

    return [...variants].map(variant => variant.trim()).filter(Boolean).slice(0, VARIANT_LIMIT)
  }

  function editDistance(first, second) {
    let previous = Array.from({ length: second.length + 1 }, (_, index) => index)
    for (let row = 1; row <= first.length; row++) {
      const current = [row]
      for (let column = 1; column <= second.length; column++) {
        const substitution = first[row - 1] === second[column - 1] ? 0 : 1
        current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + substitution)
      }
      previous = current
    }
    return previous[second.length]
  }

  function wordSimilarity(first, second) {
    const longest = Math.max(first.length, second.length)
    if (!longest) return 1
    if (first.length >= 4 && (first.startsWith(second) || second.startsWith(first))) return 0.82
    return 1 - editDistance(first, second) / longest
  }

  function matchScore(query, candidate) {
    const normalizedQuery = normalize(query)
    const normalizedCandidate = normalize(candidate)
    const compactQuery = compact(query)
    const compactCandidate = compact(candidate)
    if ((!normalizedQuery && !compactQuery) || (!normalizedCandidate && !compactCandidate)) return 0

    if (compactQuery && compactQuery === compactCandidate) return 1.25
    if (normalizedQuery && normalizedCandidate === normalizedQuery) return 1.2
    if (compactQuery && compactCandidate.includes(compactQuery)) return 1.1
    if (normalizedQuery && normalizedCandidate.includes(normalizedQuery)) return 1.05

    const queryWords = (normalizedQuery || compactQuery).split(' ')
    const candidateWords = normalizedCandidate ? normalizedCandidate.split(' ') : [compactCandidate]

    let total = 0
    for (const queryWord of queryWords) {
      const queryRoot = singularize(queryWord)
      let best = 0
      for (const candidateWord of candidateWords) {
        const candidateRoot = singularize(candidateWord)
        if (queryRoot === candidateRoot) {
          best = 1
          break
        }
        best = Math.max(best, wordSimilarity(queryRoot, candidateRoot))
      }
      // Compara contra el título unido (spider + man) para aceptar "spiderman".
      if (best < 1 && compactCandidate) best = Math.max(best, wordSimilarity(queryRoot, compactCandidate))
      total += best
    }

    const coverage = total / queryWords.length
    const lengthBalance = Math.min(queryWords.length, candidateWords.length) / Math.max(queryWords.length, candidateWords.length)
    const compactBonus = compactQuery && compactCandidate ? wordSimilarity(compactQuery, compactCandidate) * 0.18 : 0
    return Math.min(1.2, coverage * 0.82 + lengthBalance * 0.1 + compactBonus)
  }

  return { MIN_SCORE, normalize, compact, buildVariants, matchScore }
})()
