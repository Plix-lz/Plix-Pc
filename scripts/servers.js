const servers = (() => {
  const LANGUAGES = {
    latino: 'Latino',
    castellano: 'Castellano',
    subtitulado: 'Subtitulado'
  }
  const LANGUAGE_ORDER = [LANGUAGES.latino, LANGUAGES.castellano, LANGUAGES.subtitulado]

  // Archivos vacíos en la raíz de cada serie que marcan el idioma de sus enlaces (sin marcador = Latino).
  const SERIES_LANGUAGE_MARKERS = {
    subtitulado: LANGUAGES.subtitulado,
    ingles: LANGUAGES.subtitulado,
    engsub: LANGUAGES.subtitulado,
    castellano: LANGUAGES.castellano,
    espanol: LANGUAGES.castellano
  }

  const CATALOG_STORAGE_KEY = 'lzplay:catalogo-github'
  const CATALOG_TTL_MS = 60 * 60 * 1000

  let movieListPromise = null
  let catalogPromise = null
  const seasonFiles = new Map()

  const REQUEST_TIMEOUT_MS = 12000

  // Nombres del selector "Fuente" del embed-final de PelixPlay (igual que en Plix).
  const EMBED_FINAL_NAMES = {
    streamwish: 'StreamWish',
    vidmoly: 'Vidmoly',
    voe: 'VOE',
    uqload: 'UQload',
    vidspeed: 'VidSpeed',
    filelions: 'FileLions - VidHide',
    vidhide: 'VidHide',
    doodstream: 'DoodStream',
    primeload: 'PrimeLoad',
    vimeos: 'Vimeos',
    powvideo: 'PowVideo',
    powcloud: 'Powcloud',
    streamplay: 'Streamplay',
    streamhide: 'StreamHide',
    mp4upload: 'Mp4Upload',
    hxfile: 'HXFile'
  }

  async function fetchJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`El servidor respondió con un error (${response.status}).`)
    return response.json()
  }

  // Con el servidor local se consulta a través de él, así el navegador no bloquea la respuesta por CORS.
  async function fetchJsonCors(url) {
    const helper = await streamHelper()
    if (helper) return fetchJson(`${helper}/api/json?url=${encodeURIComponent(url)}`)

    const proxy = CONFIG.SERVERS.CORS_PROXY
    if (!proxy) throw new Error('Esta fuente necesita el servidor local (npm start).')
    return fetchJson(proxy + encodeURIComponent(url))
  }

  function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1)
  }

  // Igual que Plix: DoodStream y Playmogo no reproducen bien y Filemoon está oculto.
  function isBlocked(url, label = '') {
    const u = url.toLowerCase()
    const l = label.toLowerCase()
    return l.includes('dood') || l.includes('filemoon') ||
      /doodstream|dood\.|doodcdn|doimg\.net|playmogo|filemoon|kerapoxy|moonmov/.test(u)
  }

  /** filelions → "FileLions - VidHide", voe_2 → "VOE 2", servidorgoldmember → "Goldmember". */
  function prettyServerKey(key) {
    let value = key.trim().toLowerCase()
    if (value.startsWith('servidor') && value.length > 'servidor'.length) value = value.slice('servidor'.length)
    const match = value.match(/^(.*?)[_-]?(\d+)$/)
    const base = (match?.[1] || value).replace(/[^a-z0-9]/g, '')
    const name = EMBED_FINAL_NAMES[base] ?? capitalize(base || value)
    return match?.[1] ? `${name} ${match[2]}` : name
  }

  function labelFromUrl(url) {
    try {
      const { hostname, pathname } = new URL(url)
      const host = hostname.replace(/^www\./, '')
      if (/\.(mp4|m3u8)$/i.test(pathname)) return 'Directo'
      if (host === CONFIG.SERVERS.VIDHIDE_DOMAIN) return 'Vidhide'
      if (/(^|\.)ok\.ru$/i.test(host)) return 'OK.ru'
      return capitalize(host.split('.').slice(0, -1).join('.') || host)
    } catch {
      return 'Servidor'
    }
  }

  function languageFromKey(key = '') {
    const value = key.trim().toLowerCase()
    if (/castellano|espanol|español/.test(value) || value === 'es') return LANGUAGES.castellano
    if (/sub|ingl|eng|vose/.test(value) || value === 'en') return LANGUAGES.subtitulado
    return LANGUAGES.latino
  }

  function okRuEmbed(url) {
    const id = url.match(/ok\.ru\/(?:video|videoembed)\/(\d+)/i)?.[1]
    return id ? `https://ok.ru/videoembed/${id}?nochat=1` : null
  }

  function isVidhideHost(host) {
    const clean = host.replace(/^www\./, '').toLowerCase()
    return clean.includes('vidhide') || CONFIG.SERVERS.VIDHIDE_HOSTS.includes(clean)
  }

  function vidhideUrl(url, name = '') {
    try {
      const parsed = new URL(url)
      if (!/vidhide/i.test(name) && !isVidhideHost(parsed.hostname)) return null
      parsed.protocol = 'https:'
      parsed.host = CONFIG.SERVERS.VIDHIDE_DOMAIN
      return parsed.href
    } catch {
      return null
    }
  }

  function normalizeUrl(url, name) {
    const absolute = url.trim().startsWith('//') ? `https:${url.trim()}` : url.trim()
    return okRuEmbed(absolute) ?? vidhideUrl(absolute, name) ?? absolute
  }

  function isOkRu(url) {
    return /(^|\/\/)(www\.)?ok\.ru\//i.test(url)
  }

  // Los JSON usan una URL suelta, un arreglo de URLs o un arreglo de { url, label }.
  function linksFrom(value, group) {
    const items = Array.isArray(value) ? value : [value]
    return items
      .map(item => (typeof item === 'string' ? { url: item } : { url: item?.url ?? item?.video, label: item?.label }))
      .filter(item => typeof item.url === 'string' && item.url.trim())
      .map(item => {
        const url = normalizeUrl(item.url, item.label)
        return { name: item.label || labelFromUrl(url), url, group }
      })
  }

  /* ---------- Catálogo de GitHub ---------- */

  // El archivo pesa ~370 KB, así que se descarga una sola vez por sesión.
  function loadMovieList() {
    movieListPromise ??= fetchJson(CONFIG.SERVERS.MOVIE_LIST_URL).catch(error => {
      movieListPromise = null
      throw error
    })
    return movieListPromise
  }

  function buildCatalog(tree) {
    const series = {}
    const movies = new Set()
    const seriesPrefix = CONFIG.SERVERS.SERIES_TREE_PREFIX
    const moviePrefix = CONFIG.SERVERS.MOVIES_TREE_PREFIX

    tree.forEach(({ path }) => {
      if (path.startsWith(moviePrefix)) {
        const id = Number(path.slice(moviePrefix.length).split('/')[0])
        if (id) movies.add(id)
        return
      }
      if (!path.startsWith(seriesPrefix)) return

      const [idText, child, file] = path.slice(seriesPrefix.length).split('/')
      const id = Number(idText)
      if (!id) return
      series[id] ??= { seasons: [], language: LANGUAGES.latino }

      const season = child?.match(/^t(\d+)$/i)?.[1]
      if (season && !file && !series[id].seasons.includes(Number(season))) {
        series[id].seasons.push(Number(season))
      }

      const marker = !file && child?.toLowerCase().match(/^(.+)\.json$/)?.[1]
      if (marker && SERIES_LANGUAGE_MARKERS[marker]) series[id].language = SERIES_LANGUAGE_MARKERS[marker]
    })

    Object.values(series).forEach(entry => entry.seasons.sort((a, b) => a - b))
    return { series, movies: [...movies] }
  }

  function readCachedCatalog() {
    try {
      const saved = JSON.parse(localStorage.getItem(CATALOG_STORAGE_KEY))
      return saved && Date.now() - saved.savedAt < CATALOG_TTL_MS ? saved.catalog : null
    } catch {
      return null
    }
  }

  // La API de GitHub permite 60 consultas por hora sin sesión: el índice se guarda una hora.
  function loadCatalog() {
    catalogPromise ??= (async () => {
      const cached = readCachedCatalog()
      if (cached) return cached

      const data = await fetchJson(CONFIG.SERVERS.CATALOG_TREE_URL)
      const catalog = buildCatalog(data.tree ?? [])
      try {
        localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), catalog }))
      } catch (error) {
        console.warn('No se pudo guardar el catálogo de series:', error)
      }
      return catalog
    })().catch(error => {
      catalogPromise = null
      throw error
    })
    return catalogPromise
  }

  async function catalogKeys() {
    const [list, catalog] = await Promise.allSettled([loadMovieList(), loadCatalog()])
    const keys = new Set()
    if (list.status === 'fulfilled') Object.keys(list.value ?? {}).forEach(id => keys.add(`movie:${id}`))
    if (catalog.status === 'fulfilled') {
      catalog.value.movies.forEach(id => keys.add(`movie:${id}`))
      Object.keys(catalog.value.series).forEach(id => keys.add(`tv:${id}`))
    }
    return keys
  }

  async function seriesInfo(tvId) {
    const catalog = await loadCatalog().catch(() => null)
    return catalog?.series[tvId] ?? null
  }

  function loadSeasonFile(tvId, season) {
    const key = `${tvId}:${season}`
    if (!seasonFiles.has(key)) {
      const url = `${CONFIG.SERVERS.SERIES_BASE_URL}${tvId}/t${season}/${tvId}.json`
      // Sin JSON de temporada simplemente no hay enlaces de GitHub para esa temporada.
      seasonFiles.set(key, fetchJson(url).then(json => json?.capitulos ?? json ?? {}).catch(() => ({})))
    }
    return seasonFiles.get(key)
  }

  async function githubEpisodes(tvId, season) {
    const chapters = await loadSeasonFile(tvId, season)
    return Object.keys(chapters)
      .map(Number)
      .filter(number => Number.isInteger(number) && number > 0)
      .sort((a, b) => a - b)
  }

  /* ---------- Fuentes de servidores ---------- */

  /** Formato { latino: { servidor: url } } de Embed69 y CuevanaCZ. */
  function fromLanguageGroups(embeds) {
    return Object.entries(embeds ?? {}).flatMap(([language, links]) =>
      Object.entries(links ?? {})
        .filter(([, link]) => typeof link === 'string' && link.trim())
        .map(([name, link]) => ({ name: capitalize(name), url: normalizeUrl(link, name), group: languageFromKey(language) }))
    )
  }

  function episodeQuery(episode) {
    return episode ? `&season=${episode.season}&episode=${episode.episode}` : ''
  }

  async function fromEmbed69(tmdbId, episode) {
    const data = await fetchJson(CONFIG.SERVERS.EMBED69_URL + encodeURIComponent(tmdbId) + episodeQuery(episode))
    return data?.error ? [] : fromLanguageGroups(data?.embeds)
  }

  async function fromCuevana(tmdbId, episode) {
    const data = await fetchJson(CONFIG.SERVERS.CUEVANA_URL + encodeURIComponent(tmdbId) + episodeQuery(episode))
    return data?.error ? [] : fromLanguageGroups(data?.embeds)
  }

  /** Embed-final y HLS/4: { ok, all_embeds: { latino: { servidor: [url, …] } } }. */
  async function fromAllEmbeds(baseUrl, tmdbId, episode, prettyLabels) {
    const type = episode ? 'tv' : 'movie'
    const data = await fetchJsonCors(`${baseUrl}${encodeURIComponent(tmdbId)}&type=${type}${episodeQuery(episode)}`)
    if (!data?.ok) return []

    const groups = data.all_embeds ?? (data.embeds ? { [data.language ?? 'latino']: data.embeds } : {})
    return Object.entries(groups).flatMap(([language, servers]) =>
      Object.entries(servers ?? {}).flatMap(([key, value]) => {
        const name = prettyLabels ? prettyServerKey(key) : capitalize(key)
        return (Array.isArray(value) ? value : [value])
          .filter(link => typeof link === 'string' && link.trim())
          .map((link, index) => ({
            name: index ? `${name} (${index + 1})` : name,
            url: normalizeUrl(link, key),
            group: languageFromKey(language)
          }))
      })
    )
  }

  async function fromMovieList(tmdbId) {
    const list = await loadMovieList()
    const entry = list?.[tmdbId]
    return linksFrom(entry?.enlaces ?? entry?.enlace ?? [], LANGUAGES.latino)
  }

  // A veces enlace_video es el único directo (Rumble, MP4) y no está en list-movie.
  async function fromAppleMovie(tmdbId) {
    const data = await fetchJson(`${CONFIG.SERVERS.APPLE_MOVIE_BASE_URL}${tmdbId}/${tmdbId}.json`).catch(() => null)
    return linksFrom(data?.enlace_video ?? [], LANGUAGES.latino)
  }

  async function fromSeriesGithub(tvId, { season, episode }) {
    const [chapters, info] = await Promise.all([loadSeasonFile(tvId, season), seriesInfo(tvId)])
    return linksFrom(chapters[episode] ?? [], info?.language ?? LANGUAGES.latino)
  }

  function mergeServers(lists) {
    const seen = new Set()
    const order = group => (LANGUAGE_ORDER.indexOf(group) + 1 || LANGUAGE_ORDER.length + 1)
    return lists
      .flat()
      .filter(server => !isBlocked(server.url, server.name))
      .filter(server => {
        const key = server.url.toLowerCase()
        return !seen.has(key) && seen.add(key)
      })
      .sort((a, b) => order(a.group) - order(b.group))
  }

  /**
   * Fuentes en el orden de Plix: GitHub, embed-final, Embed69, CuevanaCZ y HLS/4.
   * Para series se pasa { season, episode }; onUpdate recibe la lista parcial cada vez que responde una fuente.
   */
  async function find(media, episode = null, onUpdate = null) {
    const { EMBED_FINAL_URL, HLS4_URL } = CONFIG.SERVERS
    const target = media.type === 'tv' ? episode : null
    const github = media.type === 'tv'
      ? [fromSeriesGithub(media.id, episode)]
      : [fromMovieList(media.id), fromAppleMovie(media.id)]
    const sources = [
      ...github,
      fromAllEmbeds(EMBED_FINAL_URL, media.id, target, true),
      fromEmbed69(media.id, target),
      fromCuevana(media.id, target),
      fromAllEmbeds(HLS4_URL, media.id, target, false)
    ]

    const partial = sources.map(() => [])
    sources.forEach((source, index) => source.then(list => {
      partial[index] = list
      onUpdate?.(mergeServers(partial))
    }, () => {}))

    const results = await Promise.allSettled(sources)
    results
      .filter(result => result.status === 'rejected')
      .forEach(result => console.warn('No se pudo consultar una fuente de servidores:', result.reason?.message))

    if (results.every(result => result.status === 'rejected')) {
      throw new Error('No se pudo conectar con los servidores. Inténtalo de nuevo.')
    }

    return mergeServers(results.map(result => (result.status === 'fulfilled' ? result.value : [])))
  }

  /* ---------- Extracción de video (servidor local) ---------- */

  let helperPromise = null

  // Se prueba primero el origen de la página (si la sirve server.js) y luego STREAM_HELPER_URL.
  function streamHelper() {
    helperPromise ??= (async () => {
      const bases = [...new Set([
        location.protocol.startsWith('http') ? location.origin : null,
        CONFIG.SERVERS.STREAM_HELPER_URL
      ].filter(Boolean))]
      for (const base of bases) {
        const ok = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2500) })
          .then(response => response.ok)
          .catch(() => false)
        if (ok) return base
      }
      return null
    })()
    return helperPromise
  }

  const isHls = url => /\.m3u8(\?|$)/i.test(url)
  const isMp4 = url => /\.mp4(\?|$)/i.test(url)

  /**
   * Devuelve { type: 'hls' | 'mp4', url } listo para el <video>, o null si el servidor
   * solo puede abrirse en su iframe (VOE, PowVideo… o sin servidor local).
   */
  async function resolveStream(server, signal = null) {
    if (isMp4(server.url)) return { type: 'mp4', url: server.url }

    const helper = await streamHelper()
    if (isHls(server.url)) {
      const referer = `${new URL(server.url).origin}/`
      return {
        type: 'hls',
        url: helper ? `${helper}/api/hls?url=${encodeURIComponent(server.url)}&ref=${encodeURIComponent(referer)}` : server.url
      }
    }
    if (!helper) return null

    // El servidor local abre el embed en un navegador oculto (hasta 35 s según el servidor, como Plix).
    const response = await fetch(`${helper}/api/extract?url=${encodeURIComponent(server.url)}`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000)
    }).catch(() => null)
    if (!response?.ok) return null
    const data = await response.json()
    return data?.url ? { type: data.type, url: new URL(data.url, helper).href, session: data.session ?? null } : null
  }

  /** Destruye el embed oculto de una captura cuando el reproductor ya no lo necesita. */
  async function releaseCapture(session) {
    if (!session) return
    const helper = await streamHelper()
    if (!helper) return
    fetch(`${helper}/api/capture/release?session=${encodeURIComponent(session)}`, { keepalive: true }).catch(() => {})
  }

  /* ---------- Paso humano (captcha) ---------- */

  const HUMAN_FAMILIES = /voe|powvideo|powwideo|powvldeo|povvldeo|powv1deo|povvideo|pouvideo|povw1deo|streamplay|straemplay|streamp1ay|stre4mplay|steamplay|streampiay|primeload|abyss|short\.icu/i

  /** requiresHumanStep() de Plix: el HLS solo aparece tras resolver el captcha y pulsar Play. */
  function requiresHumanStep(server) {
    return HUMAN_FAMILIES.test(server.url) || HUMAN_FAMILIES.test(server.name ?? '')
  }

  /**
   * Abre la verificación en el servidor local. Devuelve { events, input(event), cancel() } o null.
   * `events` es un EventSource con 'frame' (JPEG en base64), 'ready' ({ type, url, session }) y 'failed'.
   */
  async function startHumanCheck(server) {
    const helper = await streamHelper()
    if (!helper) return null
    const params = new URLSearchParams({ url: server.url, label: server.name ?? '' })
    const response = await fetch(`${helper}/api/human/start?${params}`).catch(() => null)
    if (!response?.ok) return null
    const { id } = await response.json()
    const query = `id=${encodeURIComponent(id)}`
    const send = event => fetch(`${helper}/api/human/input?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    }).catch(() => {})
    // En orden (un "up" nunca antes de su "down"); los movimientos pendientes se agrupan en el último.
    let queue = Promise.resolve()
    let pendingMove = null
    return {
      helper,
      events: new EventSource(`${helper}/api/human/events?${query}`),
      input(event) {
        if (event.type === 'move') {
          const queued = pendingMove
          pendingMove = event
          if (queued) return
          queue = queue.then(() => {
            const move = pendingMove
            pendingMove = null
            return move && send(move)
          })
          return
        }
        queue = queue.then(() => send(event))
      },
      cancel() {
        fetch(`${helper}/api/human/cancel?${query}`, { keepalive: true }).catch(() => {})
      }
    }
  }

  return { find, isOkRu, catalogKeys, seriesInfo, githubEpisodes, resolveStream, releaseCapture, requiresHumanStep, startHumanCheck }
})()
