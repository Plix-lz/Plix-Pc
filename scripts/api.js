const api = (() => {
  const genres = new Map()
  const mediaCache = new Map()
  const seasonCache = new Map()

  async function request(path, params = {}) {
    const url = new URL(`${CONFIG.API_BASE_URL}${path}`)
    const query = { api_key: CONFIG.API_KEY, language: CONFIG.API_LANGUAGE, ...params }
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value))

    let response
    try {
      response = await fetch(url)
    } catch {
      throw new Error('No se pudo conectar con TMDB. Revisa tu conexión a internet.')
    }

    if (response.status === 401) throw new Error('La clave de la API de TMDB no es válida.')
    if (response.status === 404) throw new Error('No encontramos ese contenido.')
    if (!response.ok) throw new Error(`TMDB respondió con un error (${response.status}).`)

    return response.json()
  }

  function imageUrl(path, size = 'small') {
    if (!path) return ''
    return /^https?:\/\//.test(path) ? path : CONFIG.IMAGE_BASE_URL[size] + path
  }

  function mediaKey(type, id) {
    return `${type === 'tv' ? 'tv' : 'movie'}:${id}`
  }

  function rawType(raw, fallback = 'movie') {
    return raw?.media_type === 'tv' || raw?.media_type === 'movie' ? raw.media_type : fallback
  }

  function rawTitle(raw) {
    return (raw.title ?? raw.name ?? '').trim()
  }

  function rawDate(raw) {
    return raw.release_date || raw.first_air_date || ''
  }

  function normalize(data, fallbackType = 'movie') {
    const type = rawType(data, fallbackType)
    const media = {
      id: data.id,
      type,
      title: rawTitle(data),
      overview: data.overview || 'Sinopsis no disponible en español.',
      rating: data.vote_average ? data.vote_average.toFixed(1) : '–',
      genre: data.genres?.[0]?.name ?? genres.get(data.genre_ids?.[0]) ?? (type === 'tv' ? 'Serie' : 'Película'),
      year: rawDate(data).split('-')[0],
      runtime: data.runtime || data.episode_run_time?.[0] || null,
      backdrop: data.backdrop_path || null,
      poster: data.poster_path || null
    }

    if (type === 'tv' && Array.isArray(data.seasons)) {
      media.seasons = data.seasons
        .filter(season => season.season_number > 0)
        .map(season => ({ number: season.season_number, name: season.name, episodes: season.episode_count }))
      media.seasonCount = data.number_of_seasons ?? media.seasons.length
    }
    return media
  }

  async function loadGenres() {
    const results = await Promise.allSettled([request('/genre/movie/list'), request('/genre/tv/list')])
    results.forEach(result => {
      if (result.status === 'fulfilled') result.value.genres.forEach(genre => genres.set(genre.id, genre.name))
      else console.warn('No se pudieron cargar los géneros:', result.reason.message)
    })
  }

  /* ---------- Géneros del home (igual que TmdbClient.buildHomeGenreList / genreMix) ---------- */

  const HOME_RAIL_EXCLUDE_IDS = new Set([10763, 10766, 10767])
  const HOME_RAIL_EXCLUDE_KEYS = new Set(['news', 'soap', 'talk', 'noticias', 'telenovela', 'talk show', 'talkshow'])
  const SECTION_SIZE = 15

  function normalizeGenreKey(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
  }

  function isExcludedHomeGenre(entry) {
    if (entry.movieId > 0 && HOME_RAIL_EXCLUDE_IDS.has(entry.movieId)) return true
    if (entry.tvId > 0 && HOME_RAIL_EXCLUDE_IDS.has(entry.tvId)) return true
    const key = normalizeGenreKey(entry.key || entry.name)
    if (HOME_RAIL_EXCLUDE_KEYS.has(key)) return true
    return [...HOME_RAIL_EXCLUDE_KEYS].some(bad =>
      key === bad || key.startsWith(`${bad} `) || key.endsWith(` ${bad}`)
    )
  }

  /** Chips del home: géneros de película y serie fusionados por nombre en español. */
  async function homeGenres() {
    const [movieList, tvList] = await Promise.all([
      request('/genre/movie/list').then(data => data.genres ?? []),
      request('/genre/tv/list').then(data => data.genres ?? [])
    ])
    const byKey = new Map()
    movieList.forEach(genre => {
      const name = String(genre.name ?? '').trim()
      if (!genre.id || !name) return
      const key = normalizeGenreKey(name)
      byKey.set(key, { name, key, movieId: genre.id, tvId: null })
    })
    tvList.forEach(genre => {
      const name = String(genre.name ?? '').trim()
      if (!genre.id || !name) return
      const key = normalizeGenreKey(name)
      const existing = byKey.get(key)
      if (existing) existing.tvId = genre.id
      else byKey.set(key, { name, key, movieId: null, tvId: genre.id })
    })
    return [...byKey.values()]
      .filter(entry => !isExcludedHomeGenre(entry))
      .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
  }

  function genreOrQuery(ids) {
    if (ids == null || ids === '') return ''
    const list = Array.isArray(ids)
      ? ids.map(Number)
      : String(ids).split(/[|,]/).map(id => Number(id.trim()))
    return list.filter(id => id > 0).join('|')
  }

  async function discoverPage(type, params, page = 1, { requireBackdrop = true } = {}) {
    const data = await request(`/discover/${type}`, {
      sort_by: 'popularity.desc',
      include_adult: false,
      'vote_count.gte': 1,
      page,
      ...params
    })
    return {
      totalPages: Math.max(1, Number(data.total_pages) || 1),
      results: (data.results ?? [])
        .filter(item => requireBackdrop ? item.backdrop_path : (item.poster_path || item.backdrop_path))
        .map(item => normalize(item, type))
    }
  }

  function takeDiscoverItems(pageResult, type, destination, seen, limit) {
    for (const item of pageResult.results) {
      if (destination.length >= limit) break
      if (!item.poster && !item.backdrop) continue
      const key = mediaKey(item.type ?? type, item.id)
      if (seen.has(key)) continue
      seen.add(key)
      destination.push(item)
    }
  }

  /**
   * Fila del home: mezcla series y películas (TV, movie, TV, movie…),
   * como fetchMixedPaged + fetchGenrePersonalized de Plix.
   */
  async function genreMix(movieGenreIds, tvGenreIds, size = SECTION_SIZE) {
    const movieOr = genreOrQuery(movieGenreIds)
    const tvOr = genreOrQuery(tvGenreIds)
    const items = []
    const seen = new Set()
    let page = 1
    let movieActive = Boolean(movieOr)
    let tvActive = Boolean(tvOr)
    let pagesFetched = 0

    while (items.length < size && pagesFetched < 8 && (movieActive || tvActive)) {
      const [movies, shows] = await Promise.all([
        movieActive
          ? discoverPage('movie', { with_genres: movieOr }, page).catch(() => ({ totalPages: 1, results: [] }))
          : { totalPages: 1, results: [] },
        tvActive
          ? discoverPage('tv', { with_genres: tvOr }, page).catch(() => ({ totalPages: 1, results: [] }))
          : { totalPages: 1, results: [] }
      ])

      if (movieActive && page >= movies.totalPages) movieActive = false
      if (tvActive && page >= shows.totalPages) tvActive = false

      const limit = Math.max(movies.results.length, shows.results.length)
      for (let index = 0; index < limit && items.length < size; index++) {
        const show = shows.results[index]
        if (show) {
          const key = mediaKey(show.type, show.id)
          if (!seen.has(key)) {
            seen.add(key)
            items.push(show)
          }
        }
        if (items.length >= size) break
        const movie = movies.results[index]
        if (movie) {
          const key = mediaKey(movie.type, movie.id)
          if (!seen.has(key)) {
            seen.add(key)
            items.push(movie)
          }
        }
      }

      page++
      pagesFetched++
      if (!movieActive && !tvActive) break
    }

    return items
  }

  /**
   * Página del listado de un género (GenresActivity / fetchGenreContentPageProgressive):
   * batch de ~18 títulos, movie+tv en paralelo, con hasMore para lazy load.
   */
  async function genreContentPage(movieId, tvId, fromPage = 1, batchSize = 18) {
    let page = Math.max(1, fromPage)
    let movieActive = Number(movieId) > 0
    let tvActive = Number(tvId) > 0
    let movieTotalPages = 1
    let tvTotalPages = 1
    const items = []
    const seen = new Set()
    let pagesFetched = 0

    while (items.length < batchSize && pagesFetched < 4 && (movieActive || tvActive)) {
      const [movies, shows] = await Promise.all([
        movieActive
          ? discoverPage('movie', { with_genres: String(movieId) }, page, { requireBackdrop: false })
            .catch(() => ({ totalPages: 1, results: [] }))
          : null,
        tvActive
          ? discoverPage('tv', { with_genres: String(tvId) }, page, { requireBackdrop: false })
            .catch(() => ({ totalPages: 1, results: [] }))
          : null
      ])

      if (movies) {
        movieTotalPages = movies.totalPages
        if (page >= movieTotalPages) movieActive = false
      }
      if (shows) {
        tvTotalPages = shows.totalPages
        if (page >= tvTotalPages) tvActive = false
      }

      // Igual que Plix: primero series, luego películas, por índice.
      const movieResults = movies?.results ?? []
      const showResults = shows?.results ?? []
      const limit = Math.max(movieResults.length, showResults.length)
      for (let index = 0; index < limit && items.length < batchSize; index++) {
        const show = showResults[index]
        if (show && (show.poster || show.backdrop)) {
          const key = mediaKey(show.type, show.id)
          if (!seen.has(key)) {
            seen.add(key)
            items.push(show)
          }
        }
        if (items.length >= batchSize) break
        const movie = movieResults[index]
        if (movie && (movie.poster || movie.backdrop)) {
          const key = mediaKey(movie.type, movie.id)
          if (!seen.has(key)) {
            seen.add(key)
            items.push(movie)
          }
        }
      }

      page++
      pagesFetched++
      if (!movieActive && !tvActive) break
    }

    const hasMore =
      (Number(movieId) > 0 && page <= movieTotalPages) ||
      (Number(tvId) > 0 && page <= tvTotalPages)

    return { items, nextPage: page, hasMore }
  }

  // Acepta un ID numérico de TMDB o un ID de IMDb (tt1234567).
  async function getMedia(id, type = 'movie') {
    const cacheKey = typeof id === 'string' && id.startsWith('tt') ? id : mediaKey(type, id)
    if (mediaCache.has(cacheKey)) return mediaCache.get(cacheKey)

    let tmdbId = id
    let tmdbType = type
    if (typeof id === 'string' && id.startsWith('tt')) {
      const data = await request(`/find/${id}`, { external_source: 'imdb_id' })
      const movie = data.movie_results?.[0]
      const series = data.tv_results?.[0]
      tmdbId = (movie ?? series)?.id
      tmdbType = movie ? 'movie' : 'tv'
      if (!tmdbId) throw new Error('No encontramos contenido con ese ID de IMDb.')
    }

    const media = normalize(await request(`/${tmdbType}/${tmdbId}`), tmdbType)
    mediaCache.set(cacheKey, media)
    mediaCache.set(mediaKey(media.type, media.id), media)
    return media
  }

  async function getSeason(tvId, seasonNumber) {
    const key = `${tvId}:${seasonNumber}`
    if (!seasonCache.has(key)) {
      const pending = request(`/tv/${tvId}/season/${seasonNumber}`)
        .then(data => (data.episodes ?? []).map(episode => ({
          number: episode.episode_number,
          name: episode.name || `Episodio ${episode.episode_number}`,
          overview: episode.overview || '',
          still: episode.still_path || null,
          runtime: episode.runtime || null,
          airDate: episode.air_date || ''
        })))
        .catch(error => {
          seasonCache.delete(key)
          throw error
        })
      seasonCache.set(key, pending)
    }
    return seasonCache.get(key)
  }

  async function discover(params = {}, type = 'movie') {
    const data = await request(`/discover/${type}`, {
      sort_by: 'popularity.desc',
      include_adult: false,
      ...params
    })
    return data.results.filter(item => item.backdrop_path).map(item => normalize(item, type))
  }

  /* ---------- Buscador (misma lógica que la app Plix) ---------- */

  const SEARCH_SIZE = 120
  const SEARCH_PRIMARY_PAGES = 3
  const SEARCH_VARIANT_PAGES = 1
  const ALT_TITLE_PREFETCH_BUDGET = 20
  const MIN_VOTES = 20
  const MIN_POPULARITY = 3
  const MIN_VOTES_RECENT = 2
  const RECENT_WINDOW_MS = 45 * 24 * 60 * 60 * 1000

  const alternativeTitles = new Map()
  const alternativeTitleRequests = new Map()
  // Índice inverso: título alternativo normalizado → claves movie:id / tv:id.
  const alternativeTitleLookup = new Map()

  function today() {
    return new Date().toLocaleDateString('en-CA')
  }

  function isReleased(raw) {
    const date = rawDate(raw)
    return date.length >= 10 && date.slice(0, 10) <= today()
  }

  // Sin sinopsis en español casi nunca hay doblaje ni subtítulos circulando.
  function looksReal(raw) {
    if (!raw.backdrop_path || !raw.overview?.trim()) return false
    const votes = raw.vote_count ?? 0
    if (votes >= MIN_VOTES && (raw.popularity ?? 0) >= MIN_POPULARITY) return true
    const date = rawDate(raw)
    const isRecent = date.length >= 10 && Date.now() - new Date(date.slice(0, 10)).getTime() <= RECENT_WINDOW_MS
    return votes >= MIN_VOTES_RECENT && isRecent
  }

  // Lo que está en el catálogo de GitHub se reproduce aunque TMDB tenga datos incompletos.
  function isSearchable(raw, type, catalog) {
    if (!raw || !rawTitle(raw) || !raw.poster_path) return false
    if (catalog.has(mediaKey(type, raw.id))) return true
    return isReleased(raw) && looksReal(raw)
  }

  async function fetchSearchPages(query, pages) {
    const params = { query, include_adult: false }
    const first = await request('/search/multi', { ...params, page: 1 })
    const total = Math.min(pages, first.total_pages || 1)
    const rest = await Promise.all(
      Array.from({ length: total - 1 }, (_, index) =>
        request('/search/multi', { ...params, page: index + 2 }).catch(() => ({ results: [] }))
      )
    )
    return [first, ...rest]
      .flatMap(data => data.results ?? [])
      .filter(raw => raw.media_type === 'movie' || raw.media_type === 'tv')
  }

  function registerAlternativeTitles(key, titles) {
    titles.forEach(title => {
      ;[searchMatch.normalize(title), searchMatch.compact(title)].forEach(lookupKey => {
        if (!lookupKey) return
        if (!alternativeTitleLookup.has(lookupKey)) alternativeTitleLookup.set(lookupKey, new Set())
        alternativeTitleLookup.get(lookupKey).add(key)
      })
    })
  }

  function loadAlternativeTitles(type, id) {
    const key = mediaKey(type, id)
    if (alternativeTitles.has(key)) return Promise.resolve(alternativeTitles.get(key))
    if (!alternativeTitleRequests.has(key)) {
      const pending = request(`/${type}/${id}/alternative_titles`)
        // TMDB responde "titles" en películas y "results" en series.
        .then(data => [...new Set((data.titles ?? data.results ?? []).map(entry => entry.title?.trim()).filter(Boolean))])
        .catch(() => [])
        .then(titles => {
          alternativeTitles.set(key, titles)
          alternativeTitleRequests.delete(key)
          registerAlternativeTitles(key, titles)
          return titles
        })
      alternativeTitleRequests.set(key, pending)
    }
    return alternativeTitleRequests.get(key)
  }

  function preliminaryScore(query, { raw }) {
    return Math.max(
      searchMatch.matchScore(query, rawTitle(raw)),
      searchMatch.matchScore(query, raw.original_title ?? raw.original_name)
    )
  }

  function itemScore(query, entry) {
    const alternatives = alternativeTitles.get(entry.key) ?? []
    return alternatives.reduce(
      (best, title) => Math.max(best, searchMatch.matchScore(query, title)),
      preliminaryScore(query, entry)
    )
  }

  async function search(query) {
    const variants = searchMatch.buildVariants(query)
    if (!variants.length) return []

    const catalogPromise = servers.catalogKeys().catch(() => new Set())
    const responses = await Promise.allSettled(
      variants.map((variant, index) => fetchSearchPages(variant, index === 0 ? SEARCH_PRIMARY_PAGES : SEARCH_VARIANT_PAGES))
    )
    if (responses.every(response => response.status === 'rejected')) throw responses[0].reason

    const catalog = await catalogPromise
    const candidates = new Map()
    const addCandidate = (raw, type) => {
      const key = mediaKey(type, raw?.id)
      if (!candidates.has(key) && isSearchable(raw, type, catalog)) candidates.set(key, { key, type, raw })
    }

    responses
      .flatMap(response => (response.status === 'fulfilled' ? response.value : []))
      .forEach(raw => addCandidate(raw, raw.media_type))

    // Segunda vía: títulos alternativos ya conocidos de búsquedas anteriores.
    const lookupKeys = new Set()
    variants.forEach(variant => {
      ;[searchMatch.normalize(variant), searchMatch.compact(variant)].forEach(lookupKey => {
        alternativeTitleLookup.get(lookupKey)?.forEach(key => lookupKeys.add(key))
      })
    })
    await Promise.all(
      [...lookupKeys]
        .filter(key => !candidates.has(key))
        .map(async key => {
          const [type, id] = key.split(':')
          const raw = await request(`/${type}/${id}`).catch(() => null)
          if (raw) addCandidate(raw, type)
        })
    )

    const ranked = [...candidates.values()].sort((a, b) => preliminaryScore(query, b) - preliminaryScore(query, a))
    await Promise.all(
      ranked
        .filter(entry => !alternativeTitles.has(entry.key))
        .slice(0, ALT_TITLE_PREFETCH_BUDGET)
        .map(entry => loadAlternativeTitles(entry.type, entry.raw.id))
    )

    return ranked
      .map(entry => ({ entry, score: itemScore(query, entry) }))
      .filter(({ score }) => score >= searchMatch.MIN_SCORE)
      .sort((a, b) => b.score - a.score || (b.entry.raw.vote_average ?? 0) - (a.entry.raw.vote_average ?? 0))
      .slice(0, SEARCH_SIZE)
      .map(({ entry }) => normalize(entry.raw, entry.type))
  }

  return {
    imageUrl, mediaKey, loadGenres, homeGenres, genreMix, genreContentPage,
    getMedia, getSeason, discover, search
  }
})()
