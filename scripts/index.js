const $ = (selector, root = document) => root.querySelector(selector)

const header = $('.header')
const menuButton = $('.button__menu')
const navigation = $('#navigation')
const navigationBackdrop = $('.navigation__backdrop')
const historyList = $('.history__list')
const historyEmpty = $('.history__empty')
const confirmClearDialog = $('#confirm-clear')
const confirmExitDialog = $('#confirm-exit')
const hero = $('.hero')
const heroImage = $('.hero__image img')
const rowsContainer = $('#rows')
const genreRowsContainer = $('#genre-rows')
const genreRail = $('#genre-rail')
const genreRailTrack = $('.genre-rail__track', genreRail)
const genreBrowseDialog = $('#genre-browse')
const genreBrowseTitle = $('#genre-browse-title')
const genreBrowseStatus = $('.genre-screen__status', genreBrowseDialog)
const genreBrowseGrid = $('.genre-screen__grid', genreBrowseDialog)
const genreBrowseScroll = $('.genre-screen__scroll', genreBrowseDialog)
const genreBrowseSentinel = $('.genre-screen__sentinel', genreBrowseDialog)
const GENRE_PAGE_SIZE = 18
const GENRE_PREFETCH_TARGET = 54

let genreBrowseSession = null
let genreBrowseObserver = null
const rowTemplate = $('#row-template')
const myListRow = $('#mi-lista')
const detailDialog = $('#detail')
const synopsisDialog = $('#synopsis')
const playerDialog = $('#player')
const watchDialog = $('#watch')
const watchFrame = $('#watch iframe')
const watchVideo = $('#watch video')
const watchMessage = $('.watch__message')
const DEFAULT_FRAME_ALLOW = watchFrame.allow
const playerStatus = $('.player__status')
const playerServers = $('.player__servers')
const episodesSection = $('.episodes')
const episodesSeason = $('.episodes__season')
const episodesStatus = $('.episodes__status')
const episodesList = $('.episodes__list')
const searchDialog = $('#search')
const searchInput = $('#search-input')
const searchStatus = $('.search__status')
const searchResults = $('.search__results')
const accountButton = $('#open-account')
const accountDialog = $('#account')
const accountForm = $('#account-form')
const accountError = $('.account__error')
const accountSubmit = $('.account__submit')
const accountProfile = $('.account__profile')
const accountSyncButton = $('#account-sync')
const profileCard = $('.profile-card')
const pinToggle = $('.account__pin-toggle')
const pickerDialog = $('#profile-picker')
const pickerSections = $('.picker__sections')

const PROGRESS_SAVE_MS = 5000
const CAPTURE_RELEASE_MS = 3000

let heroMovie = null
let detailMovie = null
let detailRequestId = 0
let detailSeason = null
let detailEpisodes = []
// [{ number, name }] de las temporadas de la serie abierta en el detalle.
let detailSeasons = []
let episodesRequestId = 0
// Promesas de episodios por `${serie}:${temporada}` para no repetir peticiones al cambiar de episodio.
const seasonEpisodesCache = new Map()
let searchRequestId = 0
let searchTimer = null
let playerRequestId = 0
let activeServerUrl = null
let hlsInstance = null
let hlsScriptPromise = null
let dashInstance = null
let dashScriptPromise = null
let playbackId = 0
let playerMedia = null
let playerEpisode = null
// Cola del reproductor como en Plix: los episodios de la temporada actual y las temporadas disponibles.
let playerQueue = []
let playerSeasons = []
let episodeSwitching = false
// Lo que se está viendo en #watch: { media, episode, server, resumed, started, capture }.
let watchSession = null
// Sesión de Cine Virtual: { roomId, roomCode, uid, displayName, isHost, movie?, season?, episode? }.
let watchPartySession = null
let watchPartyHandoff = false
let watchPartyFollowKey = ''
// Captura del embed oculto en curso y espera para destruirlo cuando el video ya reproduce.
let captureAbort = null
let captureReleaseTimer = null
let progressSavedAt = 0
let pinVisible = false
let pickerKind = 'icon'
let pickerRequestId = 0

function icon(name, className = 'icon') {
  return `<svg class="${className}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`
}

function formatRuntime(minutes) {
  if (!minutes) return ''
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours ? `${hours} h ${rest} min` : `${rest} min`
}

function formatMeta(movie) {
  return [movie.year, movie.genre, formatRuntime(movie.runtime)].filter(Boolean).join(' · ')
}

function updatePlayButton(button, movie) {
  button.disabled = !movie
  $('span', button).textContent = movie?.type === 'tv' ? 'Ver episodios' : 'Reproducir'
}

function updateListButton(button, movie, { compact = false } = {}) {
  const inList = Boolean(movie) && myList.has(movie)
  const label = inList ? 'Quitar de Mi lista' : 'Agregar a Mi lista'

  button.innerHTML = icon(inList ? 'check' : 'plus') + (compact ? '' : `<span>${inList ? 'En Mi lista' : 'Mi lista'}</span>`)
  button.setAttribute('aria-pressed', inList)
  button.title = label
  if (compact) button.setAttribute('aria-label', label)
}

function toggleMyList(movie) {
  if (!movie) return
  const adding = !myList.has(movie)
  myList.toggle(movie)
  analytics.log(adding ? 'add_to_wishlist' : 'remove_from_wishlist', { items: [analytics.item(movie)] })
}

/* ---------- Portada ---------- */

function setHeroImage(path) {
  const src = api.imageUrl(path, 'original')
  if (!src || heroImage.src === src) return

  heroImage.classList.add('is-loading')
  heroImage.src = src
}

function setHeroMovie(movie) {
  heroMovie = movie
  hero.classList.remove('hero--loading', 'hero--error')

  setHeroImage(movie.backdrop)
  heroImage.alt = `Imagen de ${movie.title}`
  $('.rating strong', hero).textContent = movie.rating
  $('.feature__info', hero).textContent = formatMeta(movie)
  $('h1', hero).textContent = movie.title
  $('.feature__overview', hero).textContent = movie.overview

  updatePlayButton($('#hero-play'), movie)
  updateListButton($('#hero-list'), movie, { compact: true })
}

function showHeroError(message) {
  hero.classList.remove('hero--loading')
  hero.classList.add('hero--error')
  $('h1', hero).textContent = 'No pudimos cargar las películas'
  $('.feature__overview', hero).textContent = `${message} Revisa la clave de la API en scripts/config.js.`
}

const HERO_RECENT_KEY = 'lzplay_hero_recent'
const HERO_RECENT_LIMIT = 10

const pickRandom = items => items[Math.floor(Math.random() * items.length)]

function recentHeroKeys() {
  try {
    const keys = JSON.parse(localStorage.getItem(HERO_RECENT_KEY))
    return Array.isArray(keys) ? keys : []
  } catch {
    return []
  }
}

function rememberHero(media) {
  const key = api.mediaKey(media.type, media.id)
  const keys = [key, ...recentHeroKeys().filter(item => item !== key)].slice(0, HERO_RECENT_LIMIT)
  try {
    localStorage.setItem(HERO_RECENT_KEY, JSON.stringify(keys))
  } catch {}
}

// Cada recarga elige una categoría y una página al azar y evita repetir las últimas portadas.
async function randomHeroMedia() {
  const row = pickRandom(CONFIG.HERO_ROWS ?? CONFIG.ROWS)
  const type = row.type ?? 'movie'
  const page = 1 + Math.floor(Math.random() * (CONFIG.HERO_PAGES ?? 3))
  // El mínimo de votos deja fuera cortos y extras poco conocidos.
  const minVotes = type === 'tv' ? 100 : 300
  const usable = async page => (await api.discover({ 'vote_count.gte': minVotes, ...row.params, page }, type))
    .filter(media => media.overview && !media.overview.startsWith('Sinopsis no disponible'))
  // Algunas categorías tienen menos páginas de las pedidas: entonces se toma la primera.
  let results = await usable(page)
  if (!results.length && page > 1) results = await usable(1)
  if (!results.length) throw new Error('Sin resultados para la portada.')

  const recent = new Set(recentHeroKeys())
  const fresh = results.filter(media => !recent.has(api.mediaKey(media.type, media.id)))
  const pool = [...(fresh.length ? fresh : results)].sort(() => Math.random() - 0.5)

  // Los cortos (Pixar, Lucasfilm…) no se anuncian en la portada: se prueba el siguiente candidato.
  let media = null
  for (const candidate of pool.slice(0, 5)) {
    media = await api.getMedia(candidate.id, candidate.type)
    if (media.type === 'tv' || !media.runtime || media.runtime >= 40) return media
  }
  return media
}

const SPLASH_MAX_MS = 10000
const splash = $('.splash')

function hideSplash() {
  if (!splash || splash.classList.contains('is-done')) return
  splash.classList.add('is-done')
  document.body.classList.remove('is-splashing')
  splash.addEventListener('transitionend', () => splash.remove(), { once: true })
}

function heroImageReady() {
  if (heroImage.complete && heroImage.naturalWidth) return heroImage.decode().catch(() => {})
  return new Promise(resolve => {
    heroImage.addEventListener('load', resolve, { once: true })
    heroImage.addEventListener('error', resolve, { once: true })
  })
}

async function loadHero() {
  const safety = setTimeout(hideSplash, SPLASH_MAX_MS)
  try {
    const media = await randomHeroMedia().catch(error => {
      console.warn('Portada aleatoria no disponible:', error.message)
      return api.getMedia(CONFIG.HERO_MOVIE)
    })
    rememberHero(media)
    setHeroMovie(media)
    if (media.backdrop) await heroImageReady()
  } catch (error) {
    showHeroError(error.message)
  } finally {
    clearTimeout(safety)
    hideSplash()
  }
}

/* ---------- Historial (menú lateral) ---------- */

// Solo en la app de escritorio y en el inicio: sin ventanas abiertas ni video en pantalla completa.
function canConfirmExit() {
  return Boolean(window.plixDesktop) && !document.querySelector('dialog[open]') && !document.fullscreenElement
}

function toggleNavigation(force) {
  const isOpen = navigation.classList.toggle('active', force)
  navigation.inert = !isOpen
  navigationBackdrop.classList.toggle('active', isOpen)
  menuButton.setAttribute('aria-expanded', isOpen)

  if (isOpen) $('.navigation__close').focus()
  else if (navigation.contains(document.activeElement)) menuButton.focus()
}

const dateFormatter = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })

function formatOpenedAt(timestamp) {
  const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(timestamp))) / 86400000)
  if (days <= 0) return 'Hoy'
  if (days === 1) return 'Ayer'
  if (days < 7) return `Hace ${days} días`
  return dateFormatter.format(timestamp)
}

function createHistoryItem(entry) {
  const item = document.createElement('li')

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'history__item'
  button.addEventListener('click', () => {
    toggleNavigation(false)
    openDetail(entry.id, entry.type)
  })

  const imageWrapper = document.createElement('div')
  imageWrapper.className = 'history__image'
  if (entry.backdrop) {
    const image = document.createElement('img')
    image.src = api.imageUrl(entry.backdrop, 'small')
    image.alt = ''
    image.loading = 'lazy'
    imageWrapper.append(image)
  }

  const meta = document.createElement('span')
  meta.className = 'history__meta'
  meta.textContent = [entry.type === 'tv' ? 'Serie' : 'Película', entry.year].filter(Boolean).join(' · ')

  const title = document.createElement('strong')
  title.className = 'history__title'
  title.textContent = entry.title

  const date = document.createElement('span')
  date.className = 'history__date'
  date.textContent = formatOpenedAt(entry.openedAt)

  button.append(imageWrapper, meta, title, date)
  item.append(button)
  return item
}

function renderHistory() {
  const entries = watchHistory.all()
  historyList.replaceChildren(...entries.map(createHistoryItem))
  historyEmpty.hidden = entries.length > 0
  $('#history-clear').hidden = entries.length === 0
}

/* ---------- Filas de películas ---------- */

function createCard(movie) {
  const item = document.createElement('li')
  item.className = 'row__item'

  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'card'
  card.dataset.id = movie.id
  card.dataset.type = movie.type ?? 'movie'

  if (movie.backdrop) {
    const image = document.createElement('img')
    image.src = api.imageUrl(movie.backdrop, 'small')
    image.alt = ''
    image.loading = 'lazy'
    card.append(image)
  } else {
    card.classList.add('card--no-image')
  }

  const title = document.createElement('span')
  title.className = 'card__title'
  title.textContent = movie.title
  card.append(title)

  if (movie.type === 'tv') {
    const tag = document.createElement('span')
    tag.className = 'card__tag'
    tag.textContent = 'Serie'
    card.append(tag)
  }

  item.append(card)
  return item
}

/** Tarjeta vertical (póster 2:3) como item_search_card de Plix. */
function createPosterCard(movie) {
  const item = document.createElement('li')
  item.className = 'row__item'

  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'poster-card'
  card.dataset.id = movie.id
  card.dataset.type = movie.type ?? 'movie'

  const frame = document.createElement('div')
  frame.className = 'poster-card__frame'

  const image = document.createElement('img')
  image.src = api.imageUrl(movie.poster || movie.backdrop, 'small')
  image.alt = ''
  image.loading = 'lazy'
  frame.append(image)

  if (movie.type === 'tv') {
    const tag = document.createElement('span')
    tag.className = 'poster-card__tag'
    tag.textContent = 'Serie'
    frame.append(tag)
  }

  const title = document.createElement('span')
  title.className = 'poster-card__title'
  title.textContent = movie.title

  card.append(frame, title)
  item.append(card)
  return item
}

function renderSkeletons(track, count = 6) {
  const skeletons = Array.from({ length: count }, () => {
    const item = document.createElement('li')
    item.className = 'row__item'
    item.innerHTML = '<div class="card card--skeleton" aria-hidden="true"></div>'
    return item
  })
  track.replaceChildren(...skeletons)
}

function renderRow(section, movies) {
  const hasMovies = movies.length > 0
  $('.row__track', section).replaceChildren(...movies.map(createCard))
  $('.row__track', section).hidden = !hasMovies
  $('.row__controls', section).hidden = !hasMovies
  $('.row__message', section).hidden = hasMovies
}

function showRowError(section, message) {
  $('.row__track', section).hidden = true
  $('.row__controls', section).hidden = true
  $('.row__message', section).textContent = message
  $('.row__message', section).hidden = false
}

function appendRow(container, title) {
  const section = rowTemplate.content.firstElementChild.cloneNode(true)
  section.setAttribute('aria-label', title)
  $('.row__title', section).textContent = title
  renderSkeletons($('.row__track', section))
  container.append(section)
  return section
}

async function loadGenreRail() {
  if (!genreRail || !genreRailTrack) return
  genreRail.hidden = false
  genreRailTrack.replaceChildren(
    ...Array.from({ length: 10 }, () => {
      const chip = document.createElement('span')
      chip.className = 'genre-chip genre-chip--skeleton'
      chip.setAttribute('aria-hidden', 'true')
      return chip
    })
  )

  try {
    const genres = await api.homeGenres()
    if (!genres.length) throw new Error('Lista de géneros vacía')
    genreRailTrack.replaceChildren(...genres.map(genre => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'genre-chip'
      button.setAttribute('role', 'listitem')
      button.textContent = genre.name
      button.addEventListener('click', () => openGenreBrowse(genre))
      return button
    }))
  } catch (error) {
    console.warn('No se pudieron cargar los géneros del home:', error)
    genreRailTrack.replaceChildren()
    const message = document.createElement('p')
    message.className = 'row__message'
    message.textContent = `No se pudieron cargar los géneros. ${error.message}`
    genreRail.append(message)
  }
}

function stopGenreBrowse() {
  genreBrowseObserver?.disconnect()
  genreBrowseObserver = null
  if (genreBrowseSession) genreBrowseSession.cancelled = true
  genreBrowseSession = null
  if (genreBrowseSentinel) {
    genreBrowseSentinel.hidden = true
    genreBrowseSentinel.classList.remove('is-loading')
  }
}

function setGenreBrowseLoading(session, loading) {
  if (genreBrowseSession !== session) return
  session.loading = loading
  if (!genreBrowseSentinel) return
  // Mantener el sentinel en el layout si hay más páginas (IntersectionObserver).
  genreBrowseSentinel.hidden = !session.hasMore
  const showLabel = loading && session.hasMore && genreBrowseGrid.children.length > 0
  genreBrowseSentinel.classList.toggle('is-loading', showLabel)
}

function scheduleGenreBrowsePrefetch(session) {
  if (genreBrowseSession !== session || session.cancelled || !session.hasMore || session.loading) return
  const loaded = genreBrowseGrid.children.length
  // Sigue llenando en segundo plano hasta tener un colchón, o si el usuario ya está cerca del final.
  if (loaded < GENRE_PREFETCH_TARGET || session.nearEnd) {
    loadGenreBrowsePage()
  }
}

async function loadGenreBrowsePage() {
  const session = genreBrowseSession
  if (!session || session.cancelled || session.loading || !session.hasMore) return

  setGenreBrowseLoading(session, true)

  try {
    const page = await api.genreContentPage(
      session.genre.movieId,
      session.genre.tvId,
      session.nextPage,
      GENRE_PAGE_SIZE
    )
    if (genreBrowseSession !== session || session.cancelled) return

    if (page.items.length) {
      genreBrowseStatus.textContent = ''
      // Pintar de inmediato lo que ya llegó; el resto sigue en segundo plano.
      genreBrowseGrid.append(...page.items.map(createPosterCard))
    } else if (!genreBrowseGrid.children.length) {
      genreBrowseStatus.textContent = 'No hay títulos disponibles en este género.'
    }

    session.nextPage = page.nextPage
    session.hasMore = page.hasMore
    // Si esta tanda vino vacía pero aún hay páginas, sigue en segundo plano.
    if (!page.items.length && page.hasMore) session.nearEnd = true
  } catch (error) {
    if (genreBrowseSession !== session || session.cancelled) return
    if (!genreBrowseGrid.children.length) {
      genreBrowseStatus.textContent = `No se pudo cargar este género. ${error.message}`
    }
    session.hasMore = false
  } finally {
    setGenreBrowseLoading(session, false)
    // Sin esperar al scroll: sigue trayendo el resto en segundo plano.
    if (genreBrowseSession === session && !session.cancelled) {
      Promise.resolve().then(() => scheduleGenreBrowsePrefetch(session))
    }
  }
}

function openGenreBrowse(genre) {
  stopGenreBrowse()
  genreBrowseTitle.textContent = genre.name
  genreBrowseStatus.textContent = 'Cargando…'
  genreBrowseGrid.replaceChildren()
  genreBrowseDialog.showModal()
  genreBrowseScroll.scrollTop = 0

  const session = {
    genre,
    nextPage: 1,
    hasMore: true,
    loading: false,
    nearEnd: false,
    cancelled: false
  }
  genreBrowseSession = session

  genreBrowseObserver = new IntersectionObserver(entries => {
    const visible = entries.some(entry => entry.isIntersecting)
    if (!genreBrowseSession) return
    genreBrowseSession.nearEnd = visible
    if (visible) scheduleGenreBrowsePrefetch(genreBrowseSession)
  }, { root: genreBrowseScroll, rootMargin: '600px 0px' })

  if (genreBrowseSentinel) {
    genreBrowseSentinel.hidden = true
    genreBrowseObserver.observe(genreBrowseSentinel)
  }

  loadGenreBrowsePage()
}

async function loadGenreRows() {
  if (!genreRowsContainer) return
  const rows = CONFIG.GENRE_ROWS ?? []
  await Promise.all(rows.map(async ({ title, movie, tv }) => {
    const section = appendRow(genreRowsContainer, title)
    try {
      const items = await api.genreMix(movie, tv)
      if (!items.length) {
        showRowError(section, 'Sin títulos disponibles ahora.')
        return
      }
      renderRow(section, items)
    } catch (error) {
      showRowError(section, `No se pudo cargar este contenido. ${error.message}`)
    }
  }))
}

async function loadRows() {
  await api.loadGenres()

  await Promise.all([
    loadGenreRail(),
    loadGenreRows(),
    ...CONFIG.ROWS.map(async ({ title, params, type = 'movie' }) => {
      const section = appendRow(rowsContainer, title)
      try {
        renderRow(section, await api.discover(params, type))
      } catch (error) {
        showRowError(section, `No se pudo cargar este contenido. ${error.message}`)
      }
    })
  ])
}

function scrollRow(arrow) {
  const track = $('.row__track', arrow.closest('.row'))
  track.scrollBy({ left: track.clientWidth * 0.8 * Number(arrow.dataset.direction), behavior: 'smooth' })
}

/* ---------- Mi lista ---------- */

function handleMyListChange() {
  renderRow(myListRow, myList.all())
  if (heroMovie) updateListButton($('#hero-list'), heroMovie, { compact: true })
  if (detailMovie) updateListButton($('#detail-list'), detailMovie)
}

/* ---------- Detalle ---------- */

function renderDetail(movie) {
  const image = $('.detail__image img', detailDialog)
  if (movie.backdrop) image.src = api.imageUrl(movie.backdrop, 'large')
  image.alt = `Imagen de ${movie.title}`

  $('.detail__title', detailDialog).textContent = movie.title
  $('.detail__overview', detailDialog).textContent = movie.overview

  const badge = document.createElement('span')
  badge.className = 'badge'
  badge.textContent = 'TMDB'
  const rating = document.createElement('strong')
  rating.textContent = movie.rating
  const info = document.createElement('span')
  info.textContent = formatMeta(movie)
  $('.detail__meta', detailDialog).replaceChildren(badge, rating, info)

  updateListButton($('#detail-list'), movie)
  updateSynopsisButton()
  watchHistory.record(movie)
  analytics.log('view_item', { items: [analytics.item(movie)] })

  if (movie.type === 'tv') {
    detailDialog.classList.add('modal--series')
    loadSeries(movie)
  }
  updateDetailPlay()
}

/* ---------- Temporadas y episodios ---------- */

function resetEpisodes() {
  episodesRequestId++
  detailSeason = null
  detailEpisodes = []
  detailSeasons = []
  detailDialog.classList.remove('modal--series')
  episodesSection.hidden = true
  episodesSeason.replaceChildren()
  episodesList.replaceChildren()
  episodesStatus.textContent = ''
}

function updateDetailPlay() {
  const button = $('#detail-play')
  const label = $('span', button)

  if (detailMovie?.type !== 'tv') {
    button.disabled = !detailMovie
    label.textContent = 'Reproducir'
    return
  }

  const { episode, resuming } = detailTargetEpisode()
  button.disabled = !episode
  label.textContent = episode ? `${resuming ? 'Continuar' : 'Reproducir'} T${detailSeason} E${episode.number}` : 'Reproducir'
}

// Como Plix: se retoma el último episodio abierto de la temporada; si no hay, el primero.
function detailTargetEpisode() {
  const last = detailMovie ? playbackProgress.lastEpisode(detailMovie.id, detailSeason) : null
  const resumed = detailEpisodes.find(episode => episode.number === last)
  return { episode: resumed ?? detailEpisodes[0], resuming: Boolean(resumed) }
}

async function loadSeries(media) {
  const requestId = detailRequestId
  episodesSection.hidden = false
  episodesStatus.textContent = 'Cargando temporadas…'

  const info = await servers.seriesInfo(media.id)
  if (requestId !== detailRequestId) return

  const tmdbSeasons = new Map((media.seasons ?? []).map(season => [season.number, season.name]))
  const numbers = [...new Set([...tmdbSeasons.keys(), ...(info?.seasons ?? [])])].sort((a, b) => a - b)

  if (!numbers.length) {
    episodesStatus.textContent = 'Esta serie todavía no tiene temporadas disponibles.'
    return
  }

  detailSeasons = numbers.map(number => ({ number, name: tmdbSeasons.get(number) || `Temporada ${number}` }))
  episodesSeason.replaceChildren(...detailSeasons.map(season => {
    const option = document.createElement('option')
    option.value = season.number
    option.textContent = season.name
    return option
  }))

  // La temporada elegida la última vez (también desde la app) o la primera con enlaces en GitHub.
  const selected = playbackProgress.selectedSeason(media.id)
  const initial = numbers.includes(selected) ? selected : info?.seasons?.[0] ?? numbers[0]
  episodesSeason.value = initial
  loadEpisodes(media, initial)
}

function seasonEpisodes(media, season) {
  const key = `${media.id}:${season}`
  if (!seasonEpisodesCache.has(key)) {
    const request = Promise.all([
      api.getSeason(media.id, season).catch(() => []),
      servers.githubEpisodes(media.id, season).catch(() => [])
    ]).then(([tmdbEpisodes, githubNumbers]) => {
      // Igual que Plix: si GitHub tiene la temporada, manda su lista de episodios y TMDB solo aporta los datos.
      const byNumber = new Map(tmdbEpisodes.map(episode => [episode.number, episode]))
      const episodes = githubNumbers.length
        ? githubNumbers.map(number => byNumber.get(number) ?? { number, name: `Episodio ${number}`, overview: '', still: null })
        : tmdbEpisodes
      if (!episodes.length) seasonEpisodesCache.delete(key)
      return episodes
    })
    seasonEpisodesCache.set(key, request)
  }
  return seasonEpisodesCache.get(key)
}

async function loadEpisodes(media, season) {
  const requestId = ++episodesRequestId
  detailSeason = season
  detailEpisodes = []
  episodesList.replaceChildren()
  episodesStatus.textContent = 'Cargando episodios…'
  updateDetailPlay()

  const episodes = await seasonEpisodes(media, season)
  if (requestId !== episodesRequestId) return
  detailEpisodes = episodes

  episodesStatus.textContent = detailEpisodes.length ? '' : 'No hay episodios disponibles en esta temporada.'
  const watched = playbackProgress.watchedEpisodes(media.id, season)
  episodesList.replaceChildren(...detailEpisodes.map(episode => createEpisodeItem(media, season, episode, watched.has(episode.number))))
  updateDetailPlay()
}

function createEpisodeItem(media, season, episode, watched = false) {
  const item = document.createElement('li')

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'episode'
  button.addEventListener('click', () => openPlayer(media, { season, episode: episode.number, name: episode.name }))

  const thumb = document.createElement('div')
  thumb.className = 'episode__thumb'
  const still = episode.still ?? media.backdrop
  if (still) {
    const image = document.createElement('img')
    image.src = api.imageUrl(still, 'small')
    image.alt = ''
    image.loading = 'lazy'
    thumb.append(image)
  }
  thumb.insertAdjacentHTML('beforeend', icon('play', 'icon episode__play'))

  const info = document.createElement('div')
  info.className = 'episode__info'

  const title = document.createElement('strong')
  title.className = 'episode__title'
  title.textContent = `${episode.number}. ${episode.name}`

  const meta = document.createElement('span')
  meta.className = 'episode__meta'
  meta.textContent = [formatRuntime(episode.runtime), watched ? 'Visto' : ''].filter(Boolean).join(' · ')

  const overview = document.createElement('p')
  overview.className = 'episode__overview'
  overview.textContent = episode.overview

  info.append(title, meta, overview)
  button.append(thumb, info)
  item.append(button)
  return item
}

// En series la sinopsis no se muestra en el detalle, así que el botón siempre está disponible.
function updateSynopsisButton() {
  const overview = $('.detail__overview', detailDialog)
  $('#detail-synopsis').hidden = detailMovie?.type !== 'tv' && overview.scrollHeight <= overview.clientHeight + 1
}

async function openDetail(movieId, type = 'movie') {
  const requestId = ++detailRequestId
  detailMovie = null
  resetEpisodes()

  detailDialog.classList.remove('modal--error')
  detailDialog.classList.add('modal--loading')
  $('.detail__image img', detailDialog).removeAttribute('src')
  $('.detail__title', detailDialog).textContent = 'Cargando…'
  $('.detail__meta', detailDialog).replaceChildren()
  $('.detail__overview', detailDialog).textContent = ''
  if (!detailDialog.open) detailDialog.showModal()

  try {
    const movie = await api.getMedia(movieId, type)
    if (requestId !== detailRequestId) return
    detailMovie = movie
    renderDetail(movie)
  } catch (error) {
    if (requestId !== detailRequestId) return
    detailDialog.classList.add('modal--error')
    $('.detail__title', detailDialog).textContent = 'No pudimos cargar el contenido'
    $('.detail__overview', detailDialog).textContent = error.message
  } finally {
    if (requestId === detailRequestId) detailDialog.classList.remove('modal--loading')
  }
}

function openSynopsis(movie) {
  if (!movie) return
  $('.synopsis__title', synopsisDialog).textContent = movie.title
  $('.synopsis__meta', synopsisDialog).textContent = formatMeta(movie)
  $('.synopsis__text', synopsisDialog).textContent = movie.overview
  synopsisDialog.showModal()
}

/* ---------- Reproductor ---------- */

function loadHlsScript() {
  hlsScriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js'
    script.onload = () => resolve(window.Hls)
    script.onerror = () => {
      hlsScriptPromise = null
      reject(new Error('No se pudo cargar el reproductor de video.'))
    }
    document.head.append(script)
  })
  return hlsScriptPromise
}

// PowVideo (pkcdn) solo entrega DASH: se reproduce con dash.js, como ExoPlayer en Plix.
function loadDashScript() {
  dashScriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/dashjs@4/dist/dash.all.min.js'
    script.onload = () => resolve(window.dashjs)
    script.onerror = () => {
      dashScriptPromise = null
      reject(new Error('No se pudo cargar el reproductor de video.'))
    }
    document.head.append(script)
  })
  return dashScriptPromise
}

function destroyEngines() {
  hlsInstance?.destroy()
  hlsInstance = null
  dashInstance?.reset()
  dashInstance = null
}

function playbackParams(extra = {}) {
  const { media, episode, server } = watchSession
  return {
    content_type: media.type === 'tv' ? 'series' : 'movie',
    item_id: `${media.type === 'tv' ? 'tv' : 'movie'}:${media.id}`,
    item_name: media.title,
    ...(episode ? { season: episode.season, episode: episode.episode } : {}),
    server: server.name,
    server_group: server.group ?? '',
    ...extra
  }
}

function markPlaybackStarted(player) {
  if (!watchSession || watchSession.started) return
  watchSession.started = true
  playbackProgress.markStarted(watchSession.media, watchSession.episode)
  cloud.recordPlayed(watchSession.media, watchSession.episode)
  analytics.log('video_start', playbackParams({ player }))
}

function resumePlayback() {
  const session = watchSession
  if (!session || session.resumed) return
  session.resumed = true
  const duration = Number.isFinite(watchVideo.duration) ? watchVideo.duration * 1000 : 0
  const position = playbackProgress.resumePosition(session.media, session.episode, duration)
  if (!position) return
  watchVideo.currentTime = position / 1000
  videoPlayer.showToast(`Reanudando desde ${videoPlayer.formatTime(position / 1000)}`, 2500)
}

function saveProgress(force = false) {
  if (!watchSession?.resumed || watchVideo.seeking || !Number.isFinite(watchVideo.duration)) return
  const now = Date.now()
  if (!force && now - progressSavedAt < PROGRESS_SAVE_MS) return
  progressSavedAt = now
  playbackProgress.save(watchSession.media, watchSession.episode, watchVideo.currentTime * 1000, watchVideo.duration * 1000)
}

function stopPlayback() {
  saveProgress(true)
  captureAbort?.abort()
  captureAbort = null
  clearTimeout(captureReleaseTimer)
  captureReleaseTimer = null
  servers.releaseCapture(watchSession?.capture)
  humanCheckView.hide()
  watchSession = null
  playbackId++
  destroyEngines()
  watchVideo.onerror = null
  watchVideo.pause()
  watchVideo.removeAttribute('src')
  watchVideo.load()
  watchVideo.hidden = true
  watchFrame.src = 'about:blank'
  watchFrame.hidden = true
  watchMessage.hidden = true
  videoPlayer.reset()
}

function showWatchMessage(message, loading = false) {
  watchMessage.textContent = message
  watchMessage.classList.toggle('watch__message--loading', loading)
  watchMessage.hidden = false
}

function showWatchError(message) {
  watchVideo.hidden = true
  videoPlayer.setMode('message')
  showWatchMessage(message)
}

function showFrame(url) {
  destroyEngines()
  watchVideo.pause()
  watchVideo.hidden = true
  watchMessage.hidden = true
  videoPlayer.setMode('frame')
  // Los atributos deben fijarse antes de asignar src para que el navegador los aplique.
  if (servers.isOkRu(url)) {
    watchFrame.allow = 'autoplay'
    watchFrame.removeAttribute('referrerpolicy')
  } else {
    watchFrame.allow = DEFAULT_FRAME_ALLOW
    watchFrame.referrerPolicy = 'origin'
  }
  watchFrame.src = url
  watchFrame.hidden = false
  markPlaybackStarted('iframe')
}

async function playStream(stream, server, id) {
  // Si el video extraído falla, se abre el embed original para no dejar la pantalla en negro.
  const fallback = () => {
    if (id !== playbackId) return
    analytics.log('stream_fallback', playbackParams({ stream_type: stream.type }))
    if (/\.(m3u8|mp4)(\?|$)/i.test(server.url)) showWatchError('No se pudo reproducir este servidor. Prueba con otro.')
    else showFrame(server.url)
  }

  if (stream.type === 'dash') {
    const dashjs = await loadDashScript().catch(() => null)
    if (id !== playbackId) return
    if (!dashjs?.supportsMediaSource()) return fallback()
    watchVideo.onerror = null
    const player = dashjs.MediaPlayer().create()
    dashInstance = player
    player.updateSettings({
      streaming: {
        buffer: { bufferTimeAtTopQuality: 60, stableBufferTime: 30 },
        retryAttempts: { MPD: 3, InitializationSegment: 4, MediaSegment: 6 }
      }
    })
    player.on(dashjs.MediaPlayer.events.ERROR, event => {
      if (id !== playbackId) return
      console.warn('Error de dash.js:', event.error?.code ?? '', event.error?.message ?? '')
      fallback()
    })
    player.initialize(watchVideo, stream.url, true)
    watchVideo.hidden = false
    watchFrame.hidden = true
    watchMessage.hidden = true
    videoPlayer.setMode('video')
    return
  }

  // hls.js tiene prioridad (calidades y recuperación de errores); el HLS nativo queda para Safari/iOS.
  const Hls = stream.type === 'hls' ? await loadHlsScript().catch(() => null) : null
  if (id !== playbackId) return
  if (stream.type === 'hls' && !Hls?.isSupported() && !watchVideo.canPlayType('application/vnd.apple.mpegurl')) return fallback()

  if (Hls?.isSupported()) {

    // Con hls.js los errores del <video> los gestiona hls.js; solo se abandona si no logra recuperarse.
    watchVideo.onerror = null
    const hls = new Hls({
      maxBufferLength: 60,
      manifestLoadPolicy: { default: { maxTimeToFirstByteMs: 20000, maxLoadTimeMs: 30000, timeoutRetry: { maxNumRetry: 3, retryDelayMs: 0, maxRetryDelayMs: 0 }, errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 } } },
      playlistLoadPolicy: { default: { maxTimeToFirstByteMs: 20000, maxLoadTimeMs: 30000, timeoutRetry: { maxNumRetry: 3, retryDelayMs: 0, maxRetryDelayMs: 0 }, errorRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 } } },
      fragLoadPolicy: { default: { maxTimeToFirstByteMs: 30000, maxLoadTimeMs: 120000, timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 }, errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 } } }
    })
    hlsInstance = hls
    let networkRecoveries = 0
    let mediaRecoveries = 0
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      networkRecoveries = 0
      mediaRecoveries = 0
    })
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal || id !== playbackId) return
      console.warn('Error de hls.js:', data.type, data.details, data.response?.code ?? '')
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 3 && data.details !== Hls.ErrorDetails.MANIFEST_PARSING_ERROR) {
        networkRecoveries++
        setTimeout(() => { if (id === playbackId) hls.startLoad() }, networkRecoveries * 1500)
        return
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 3) {
        mediaRecoveries++
        if (mediaRecoveries === 2) hls.swapAudioCodec()
        hls.recoverMediaError()
        return
      }
      fallback()
    })
    videoPlayer.attachHls(hlsInstance)
    hlsInstance.loadSource(stream.url)
    hlsInstance.attachMedia(watchVideo)
  } else {
    watchVideo.onerror = fallback
    watchVideo.src = stream.url
  }

  watchMessage.hidden = true
  watchVideo.hidden = false
  videoPlayer.setMode('video')
  watchVideo.play().catch(() => {})
}

async function playServer(server, button) {
  stopPlayback()
  const id = playbackId
  activeServerUrl = server.url
  watchSession = { media: playerMedia, episode: playerEpisode, server, resumed: false, started: false }
  videoPlayer.setEpisodes(playerEpisode ? episodeNavigator : null)
  analytics.log('select_content', playbackParams({ content_type: 'server' }))
  playerServers.querySelectorAll('.player__server').forEach(item => {
    item.setAttribute('aria-pressed', item === button)
  })

  if (watchPartySession?.isHost) {
    await publishWatchPartyServer(server)
  }

  videoPlayer.setTitle($('.player__title', playerDialog).textContent)
  watchDialog.showModal()
  // Debe pedirse dentro del clic: los navegadores bloquean la pantalla completa fuera de un gesto del usuario.
  watchDialog.requestFullscreen?.().catch(() => {})
  if (watchPartySession) attachWatchPartyToPlayer()

  if (servers.requiresHumanStep(server)) {
    startHumanStep(server, id)
    return
  }

  // Como Plix: el embed se abre oculto en el servidor local y solo se muestra si no entrega el video.
  showWatchMessage(`Conectando con ${server.name}…`, true)
  captureAbort = new AbortController()
  const stream = await servers.resolveStream(server, captureAbort.signal).catch(() => null)
  if (id !== playbackId || !watchDialog.open) {
    servers.releaseCapture(stream?.session)
    return
  }
  captureAbort = null
  watchSession.capture = stream?.session ?? null

  if (stream) playStream(stream, server, id)
  else showFrame(server.url)
}

// HumanCheckDialog de Plix: VOE, PowVideo… piden captcha y Play. La persona los resuelve en la tarjeta
// (el embed corre en el Chrome del servidor local, con sus popups destruidos) y el HLS pasa al reproductor.
async function startHumanStep(server, id) {
  humanCheckView.hide()
  videoPlayer.setMode('human')
  showWatchMessage(`Abriendo ${server.name}…`, true)
  const check = await servers.startHumanCheck(server).catch(() => null)
  if (id !== playbackId || !watchDialog.open) {
    check?.events.close()
    check?.cancel()
    return
  }
  watchMessage.hidden = true
  if (!check) {
    showFrame(server.url)
    return
  }
  humanCheckView.open(server.name, check, {
    onReady: stream => {
      if (id !== playbackId || !watchSession) {
        servers.releaseCapture(stream.session)
        return
      }
      watchSession.capture = stream.session ?? null
      playStream({ ...stream, url: new URL(stream.url, check.helper).href }, server, id)
    },
    onReload: () => {
      if (id === playbackId) startHumanStep(server, id)
    }
  })
}

// destroyWebView() en STATE_READY: con el video ya reproduciéndose, el embed oculto se destruye.
function releaseCaptureWhenPlaying() {
  const session = watchSession
  if (!session?.capture || captureReleaseTimer) return
  captureReleaseTimer = setTimeout(() => {
    captureReleaseTimer = null
    if (watchSession !== session || watchVideo.paused || watchVideo.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return
    servers.releaseCapture(session.capture)
    session.capture = null
  }, CAPTURE_RELEASE_MS)
}

function closeWatch() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  const handoff = watchPartyHandoff
  watchPartyHandoff = false
  stopPlayback()
  if (!handoff) leaveWatchParty()
}

function watchPartyPlayerHost() {
  return {
    getPositionMs: () => videoPlayer.getPositionMs(),
    getDurationMs: () => videoPlayer.getDurationMs(),
    isPlaying: () => videoPlayer.isPlaying(),
    getPlaybackSpeed: () => videoPlayer.getSpeed(),
    applyPlay: () => videoPlayer.applyPlay(),
    applyPause: () => videoPlayer.applyPause(),
    applySeek: ms => videoPlayer.applySeek(ms),
    applySpeed: speed => videoPlayer.applySpeed(speed),
    onWatchPartyRoom(room) {
      if (!watchPartySession) return
      if (room.hostId && room.hostId === watchPartySession.uid && !watchPartySession.isHost) {
        watchPartySession.isHost = true
        watchPartyManager.setHost(true)
        videoPlayer.setWatchPartyGuest(false)
        videoPlayer.showToast('Ahora sos el anfitrión de la sala', 2500)
      } else if (room.hostId && room.hostId !== watchPartySession.uid && watchPartySession.isHost) {
        watchPartySession.isHost = false
        watchPartyManager.setHost(false)
        videoPlayer.setWatchPartyGuest(true)
      }
      if (!watchPartySession.isHost) maybeFollowWatchPartyContent(room)
      if (!room.active) {
        videoPlayer.showToast('La sala ya no está disponible', 2500)
        watchDialog.close()
      }
    },
    onWatchPartyError(message) {
      videoPlayer.showToast(message || 'Error de Cine Virtual', 3000)
    },
    onJoinSyncHoldChanged(holding) {
      if (holding) videoPlayer.showToast('Pausado: esperando que todos carguen el mismo tiempo…', 2500)
    },
    onGuestCatchUpRequired(syncEpoch) {
      setTimeout(() => {
        if (!watchPartySession || watchPartySession.isHost) return
        watchPartyPresence.markSynced(watchPartySession.roomId, watchPartySession.uid, syncEpoch)
          .then(() => {
            watchPartyManager.noteGuestAckedEpoch(syncEpoch)
            watchPartyManager.finishGuestCatchUp()
            watchPartyManager.resyncFromLastRoom()
          })
          .catch(() => {})
      }, 850)
    }
  }
}

function attachWatchPartyToPlayer() {
  if (!watchPartySession) return
  videoPlayer.setWatchPartyGuest(!watchPartySession.isHost)
  videoPlayer.setWatchPartyHooks({
    onPlay: () => {
      if (watchPartySession?.isHost) watchPartyManager.publishPlay()
    },
    onPause: () => {
      if (watchPartySession?.isHost) watchPartyManager.publishPause()
    },
    onSeek: () => {
      if (watchPartySession?.isHost) watchPartyManager.publishSeek()
    }
  })
  watchPartyManager.attach(
    watchPartyPlayerHost(),
    watchPartySession.roomId,
    watchPartySession.uid,
    watchPartySession.isHost
  )
  watchPartyUi.attachChat(watchPartySession)
  if (watchPartySession.movie) salaVirtualRecents.record(watchPartySession.movie)
  if (!watchPartySession.isHost) {
    setTimeout(() => watchPartyManager.startGuestCatchUp(), 400)
  } else {
    setTimeout(() => {
      if (watchPartySession?.isHost) watchPartyManager.publishPause()
    }, 1200)
  }
}

async function leaveWatchParty() {
  const session = watchPartySession
  watchPartySession = null
  watchPartyFollowKey = ''
  watchPartyManager.detach()
  watchPartyUi.detachChat()
  videoPlayer.setWatchPartyGuest(false)
  videoPlayer.setWatchPartyHooks(null)
  if (!session) return
  try {
    if (session.isHost) {
      await watchPartyClient.handleHostLeave(session.roomId, session.uid, session.displayName, session.roomCode)
    } else {
      await watchPartyPresence.markOffline(session.roomId, session.uid)
      await watchPartyChat.sendPresenceEvent(session.roomId, session.roomCode, session.uid, session.displayName, false)
    }
  } catch (error) {
    console.warn('leaveWatchParty:', error)
  }
}

async function publishWatchPartyServer(server) {
  if (!watchPartySession?.isHost || !server) return
  try {
    await watchPartyClient.setPreferredServer(
      watchPartySession.roomId,
      server.name,
      server.language || server.group || '',
      server.url,
      watchPartySession.uid
    )
  } catch (error) {
    console.warn('setPreferredServer:', error)
  }
}

async function startWatchPartyAsHost(session) {
  if (session?.needsContent) {
    videoPlayer.showToast('Abrí un título y pulsá Cine Virtual para empezar la sala', 3500)
    return
  }
  watchPartySession = { ...session, isHost: true }
  const episode = session.season > 0
    ? { season: session.season, episode: session.episode, name: session.movie?.title }
    : null
  await openPlayer(session.movie, episode)
}

async function startWatchPartyAsGuest({ room, uid, displayName }) {
  const type = room.contentType === WatchPartyConfig.TYPE_SERIES ? 'tv' : 'movie'
  let movie
  try {
    movie = await api.getMedia(room.contentId, type)
  } catch (error) {
    videoPlayer.showToast(error.message || 'No se pudo cargar el título de la sala', 3000)
    return
  }
  watchPartySession = {
    roomId: room.roomId,
    roomCode: room.roomCode,
    uid,
    displayName,
    isHost: false,
    movie,
    season: room.season,
    episode: room.episode,
    preferredServerName: room.preferredServerName,
    preferredServerLanguage: room.preferredServerLanguage,
    preferredServerUrl: room.preferredServerUrl
  }
  watchPartyFollowKey = `${room.contentId}:${room.season}:${room.episode}:${room.preferredServerUrl || room.preferredServerName || ''}`
  const episode = room.contentType === WatchPartyConfig.TYPE_SERIES && room.season > 0
    ? { season: room.season, episode: room.episode || 1, name: movie.title }
    : null
  await openPlayer(movie, episode)
}

async function maybeFollowWatchPartyContent(room) {
  if (!watchPartySession || watchPartySession.isHost || !room?.isReadyForGuests?.()) return
  const key = `${room.contentId}:${room.season}:${room.episode}:${room.preferredServerUrl || room.preferredServerName || ''}`
  if (key === watchPartyFollowKey) return
  watchPartyFollowKey = key
  watchPartyHandoff = true
  watchDialog.close()
  playerDialog.close()
  await startWatchPartyAsGuest({
    room,
    uid: watchPartySession.uid,
    displayName: watchPartySession.displayName
  })
}

function pickWatchPartyServer(list) {
  if (!watchPartySession || watchPartySession.isHost || !list?.length) return null
  const index = WatchPartyServerMatcher.indexOf(
    list,
    watchPartySession.preferredServerName,
    watchPartySession.preferredServerLanguage,
    watchPartySession.preferredServerUrl
  )
  return index >= 0 ? list[index] : null
}

function renderServers(list) {
  const groups = new Map()
  list.forEach(server => {
    if (!groups.has(server.group)) groups.set(server.group, [])
    groups.get(server.group).push(server)
  })

  const sections = [...groups].map(([name, items]) => {
    const section = document.createElement('section')
    section.className = 'player__group'

    const title = document.createElement('h3')
    title.className = 'player__group-title'
    title.textContent = name

    const totals = new Map()
    items.forEach(server => totals.set(server.name, (totals.get(server.name) ?? 0) + 1))
    const counters = new Map()

    const buttons = document.createElement('div')
    buttons.className = 'player__list'
    items.forEach(server => {
      const number = (counters.get(server.name) ?? 0) + 1
      counters.set(server.name, number)

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'player__server'
      button.setAttribute('aria-pressed', server.url === activeServerUrl)
      button.innerHTML = icon('play')
      const label = document.createElement('span')
      label.textContent = totals.get(server.name) > 1 ? `${server.name} ${number}` : server.name
      button.append(label)
      button.addEventListener('click', () => playServer(server, button))
      buttons.append(button)
    })

    section.append(title, buttons)
    return section
  })

  playerServers.replaceChildren(...sections)
}

/* ---------- Episodios dentro del reproductor ---------- */

function episodeImage(media, episode) {
  const still = episode.still ?? media.backdrop
  return still ? api.imageUrl(still, 'small') : null
}

const episodeNavigator = {
  state() {
    if (!playerMedia || !playerEpisode) return null
    const { season, episode } = playerEpisode
    return {
      season,
      episode,
      seasonName: playerSeasons.find(item => item.number === season)?.name,
      items: playerQueue.map(item => ({
        season,
        episode: item.number,
        name: item.name,
        image: episodeImage(playerMedia, item)
      })),
      watched: playbackProgress.watchedEpisodes(playerMedia.id, season),
      // Como hasNextEpisode() de Plix: queda otro episodio en la temporada o existe una temporada posterior.
      hasPrevious: playerQueue.some(item => item.number < episode) || playerSeasons.some(item => item.number < season),
      hasNext: playerQueue.some(item => item.number > episode) || playerSeasons.some(item => item.number > season)
    }
  },
  select: item => switchEpisode(item.season, { number: item.episode, name: item.name }),
  previous: () => stepEpisode(-1),
  next: () => stepEpisode(1)
}

// Igual que Plix: se cierra el reproductor y se abre la lista de servidores del episodio elegido.
async function switchEpisode(season, episode) {
  const media = playerMedia
  if (!media) return
  if (watchPartySession?.isHost) {
    watchPartyHandoff = true
    try {
      await watchPartyClient.setContent(
        watchPartySession.roomId,
        Number(media.id),
        WatchPartyConfig.TYPE_SERIES,
        media.title || '',
        media.poster ? api.imageUrl(media.poster, 'medium') : '',
        season,
        episode.number,
        watchPartySession.uid
      )
      watchPartySession.season = season
      watchPartySession.episode = episode.number
    } catch (error) {
      watchPartyHandoff = false
      videoPlayer.showToast(error.message || 'No se pudo cambiar el episodio en la sala', 3000)
      return
    }
  }
  watchDialog.close()
  playbackProgress.setSelectedSeason(media.id, season)
  if (detailMovie?.id === media.id && detailMovie.type === 'tv') {
    episodesSeason.value = season
    loadEpisodes(media, season)
  }
  openPlayer(media, { season, episode: episode.number, name: episode.name })
}

// selectNextEpisode() de Plix: el siguiente de la temporada o el primero de la siguiente temporada.
// El anterior sigue la misma lógica al revés y termina en el último episodio de la temporada previa.
async function stepEpisode(direction) {
  if (episodeSwitching || !playerMedia || !playerEpisode) return
  const media = playerMedia
  const { season, episode } = playerEpisode

  const sameSeason = direction > 0
    ? playerQueue.find(item => item.number > episode)
    : playerQueue.findLast(item => item.number < episode)
  if (sameSeason) {
    switchEpisode(season, sameSeason)
    return
  }

  const target = direction > 0
    ? playerSeasons.find(item => item.number > season)
    : playerSeasons.findLast(item => item.number < season)
  if (!target) {
    videoPlayer.showToast(direction > 0 ? 'No hay un siguiente episodio cargado.' : 'No hay un episodio anterior.', 2000)
    return
  }

  episodeSwitching = true
  videoPlayer.showToast(`Cargando ${target.name}…`, 4000)
  const episodes = await seasonEpisodes(media, target.number).finally(() => { episodeSwitching = false })
  if (playerMedia !== media || !watchDialog.open) return

  const pick = direction > 0 ? episodes.find(item => item.number === 1) ?? episodes[0] : episodes.at(-1)
  if (pick) switchEpisode(target.number, pick)
  else videoPlayer.showToast('No hay episodios disponibles en esa temporada.', 2000)
}

function loadPlayerQueue(movie, episode) {
  if (!episode) {
    playerQueue = []
    playerSeasons = []
    return
  }
  if (detailMovie?.id === movie.id && detailSeasons.length) playerSeasons = detailSeasons
  else if (playerMedia?.id !== movie.id) playerSeasons = []
  playerQueue = []
  seasonEpisodes(movie, episode.season).then(episodes => {
    if (playerEpisode !== episode) return
    playerQueue = episodes
    if (watchSession?.episode === episode) videoPlayer.setEpisodes(episodeNavigator)
  })
}

/** Para series se pasa { season, episode, name }. */
async function openPlayer(movie, episode = null) {
  if (!movie) return
  const requestId = ++playerRequestId
  loadPlayerQueue(movie, episode)
  playerMedia = movie
  playerEpisode = episode
  watchHistory.record(movie)
  const startedAt = performance.now()

  $('.player__label', playerDialog).textContent = episode
    ? `Temporada ${episode.season} · Episodio ${episode.episode}`
    : 'Reproducir'
  $('.player__title', playerDialog).textContent = episode?.name ? `${movie.title}: ${episode.name}` : movie.title
  activeServerUrl = null
  setPlayerStatus('Buscando servidores…', true)
  playerServers.replaceChildren()
  if (!playerDialog.open) playerDialog.showModal()

  try {
    const list = await servers.find(movie, episode, partial => {
      if (requestId !== playerRequestId || !partial.length) return
      setPlayerStatus(`${partial.length} servidor${partial.length === 1 ? '' : 'es'} · buscando más…`, true)
      renderServers(partial)
    })
    if (requestId !== playerRequestId) return

    setPlayerStatus(list.length
      ? `${list.length} servidor${list.length === 1 ? '' : 'es'} disponible${list.length === 1 ? '' : 's'}`
      : `No encontramos servidores para ${episode ? 'este episodio' : 'esta película'}.`)
    renderServers(list)
    analytics.log('servers_loaded', {
      item_id: `${movie.type === 'tv' ? 'tv' : 'movie'}:${movie.id}`,
      item_name: movie.title,
      server_count: list.length,
      load_ms: Math.round(performance.now() - startedAt)
    })

    const matched = pickWatchPartyServer(list)
    if (matched && watchPartySession && !watchPartySession.isHost) {
      setPlayerStatus(`Mismo servidor que el anfitrión: ${matched.name}`)
      const button = [...playerServers.querySelectorAll('.player__server')]
        .find(item => item.textContent.includes(matched.name))
      playServer(matched, button || null)
    }
  } catch (error) {
    if (requestId === playerRequestId) setPlayerStatus(error.message)
  }
}

function setPlayerStatus(text, loading = false) {
  playerStatus.textContent = text
  playerStatus.classList.toggle('player__status--loading', loading)
}

/* ---------- Búsqueda ---------- */

function openSearch() {
  if (!searchDialog.open) searchDialog.showModal()
  searchInput.focus()
  searchInput.select()
}

async function runSearch(query) {
  const requestId = ++searchRequestId

  try {
    const movies = await api.search(query)
    if (requestId !== searchRequestId) return

    searchResults.replaceChildren(...movies.map(createCard))
    analytics.log('search', { search_term: query, result_count: movies.length })
    searchStatus.textContent = movies.length
      ? `${movies.length} resultado${movies.length === 1 ? '' : 's'} para “${query}”`
      : `Sin resultados para “${query}”.`
  } catch (error) {
    if (requestId === searchRequestId) searchStatus.textContent = error.message
  }
}

function handleSearchInput() {
  clearTimeout(searchTimer)
  const query = searchInput.value.trim()

  if (query.length < 2) {
    searchRequestId++
    searchResults.replaceChildren()
    searchStatus.textContent = 'Escribe al menos 2 letras para buscar.'
    return
  }

  searchStatus.textContent = 'Buscando…'
  searchTimer = setTimeout(() => runSearch(query), 400)
}

/* ---------- Cuenta Plix (Firebase) ---------- */

const timeFormatter = new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit' })

function accountSyncText(state) {
  if (state.busy) return 'Sincronizando…'
  if (state.error) return state.error
  if (state.pending) return 'Hay cambios pendientes de subir.'
  if (!state.lastSyncMs) return 'Aún no se ha sincronizado.'
  return `Sincronizado: ${formatOpenedAt(state.lastSyncMs).toLowerCase()} a las ${timeFormatter.format(state.lastSyncMs)}.`
}

// Igual que UsageTimeFormatter de Plix.
function formatUsage(totalMs) {
  const totalMinutes = Math.max(0, Math.floor(totalMs / 60000))
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  if (hours < 24) return `${hours} h ${String(totalMinutes % 60).padStart(2, '0')} min`
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? 'día' : 'días'} ${hours % 24} h`
}

function setImage(image, src) {
  if (image.getAttribute('src') !== src) image.src = src
}

/** Como BackdropVideoBinder: imagen estática y, si es video, lo reproduce en bucle sin sonido. */
function bindBackdrop(url) {
  const backdropBox = $('.profile-card__backdrop')
  const image = $('img', backdropBox)
  const video = $('.profile-card__backdrop-video', backdropBox)
  const hasVideo = profileCatalog.isVideoUrl(url)

  backdropBox.hidden = !url
  profileCard.classList.toggle('profile-card--backdrop', Boolean(url))
  if (!url) {
    video.pause()
    video.removeAttribute('src')
    video.load()
    video.hidden = true
    image.removeAttribute('src')
    return
  }

  if (!hasVideo) {
    video.pause()
    video.removeAttribute('src')
    video.load()
    video.hidden = true
    setImage(image, url)
    return
  }

  // El fotograma previo queda debajo mientras el video carga.
  setImage(image, url)
  if (video.getAttribute('src') !== url) {
    video.src = url
    video.load()
  }
  video.hidden = false
  video.muted = true
  video.loop = true
  video.playsInline = true
  const play = () => video.play().catch(() => {})
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) play()
  else video.addEventListener('loadeddata', play, { once: true })
}

function renderProfileCard(state) {
  const avatar = profileCatalog.imageUrl('icon', state.icon)
  setImage($('.profile-card__avatar img'), avatar)
  setImage($('.header__account-avatar'), avatar)

  bindBackdrop(profileCatalog.imageUrl('backdrop', state.backdrop))

  $('.profile-card__username').textContent = state.username
  $('.profile-card__id').textContent = state.label
  $('.profile-card__friends-count').textContent =
    state.friendsCount == null ? '—' : String(state.friendsCount)
  $('.profile-card__bio').textContent = state.bio || cloud.BIO_DEFAULT
  $('#edit-backdrop').hidden = !state.signedIn
}

function renderPin(pin) {
  const value = $('.account__pin-value')
  pinToggle.disabled = !pin
  if (!pin) {
    value.textContent = 'No disponible'
    pinVisible = false
  } else {
    value.textContent = pinVisible ? pin : '•'.repeat(pin.length)
  }
  const label = pinVisible ? 'Ocultar PIN' : 'Mostrar PIN'
  pinToggle.setAttribute('aria-label', label)
  pinToggle.title = label
  $('use', pinToggle).setAttribute('href', pinVisible ? '#icon-eye-off' : '#icon-eye')
}

function renderStats({ stats }) {
  const values = {
    achievements: `${stats.achievements} Logros`,
    movies: stats.movies,
    series: stats.series,
    episodes: stats.episodes,
    usage: formatUsage(stats.usageMs)
  }
  accountProfile.querySelectorAll('[data-stat]').forEach(element => {
    element.textContent = values[element.dataset.stat]
  })
}

function renderAccount(state = cloud.state()) {
  accountButton.classList.toggle('header__account--signed', state.signedIn)
  accountButton.classList.toggle('header__account--pending', state.signedIn && (state.pending || Boolean(state.error)))
  $('.header__account-name').textContent = state.signedIn ? state.username : 'Entrar'
  $('.header__account-avatar').hidden = !state.signedIn
  accountButton.title = state.signedIn ? `Cuenta Plix: ${state.username}` : 'Entrar con tu cuenta Plix'

  accountForm.hidden = state.signedIn
  accountProfile.hidden = !state.signedIn
  $('#edit-backdrop').hidden = !state.signedIn
  if (!state.signedIn) {
    if (pickerDialog.open) pickerDialog.close()
    return
  }

  renderProfileCard(state)
  $('.account__info-username').textContent = state.username
  renderPin(state.pin)
  renderStats(state)
  $('.account__sync').textContent = accountSyncText(state)
  accountSyncButton.disabled = state.busy
  accountSyncButton.setAttribute('aria-busy', state.busy)
}

/* ---------- Selector de icono y backdrop ---------- */

function setPickerStatus(message, retry = false) {
  $('.picker__message').textContent = message
  $('.picker__retry').hidden = !retry
}

function createPickerOption(item, selected) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `picker__option picker__option--${pickerKind}`
  button.setAttribute('aria-pressed', profileCatalog.sameSelection(item, selected))
  button.setAttribute('aria-label', `${item.pack} ${item.id}`)
  button.title = `${item.pack} · ${item.id}`

  if (pickerKind === 'backdrop' && profileCatalog.isVideoUrl(item.imageUrl)) {
    const video = document.createElement('video')
    video.src = item.imageUrl
    video.muted = true
    video.loop = true
    video.playsInline = true
    video.preload = 'metadata'
    video.setAttribute('aria-hidden', 'true')
    const play = () => video.play().catch(() => {})
    video.addEventListener('loadeddata', play)
    button.addEventListener('pointerenter', play)
    button.append(video)
  } else {
    const image = document.createElement('img')
    image.src = item.imageUrl
    image.alt = ''
    image.loading = 'lazy'
    button.append(image)
  }

  button.addEventListener('click', async () => {
    pickerSections.querySelectorAll('.picker__option').forEach(option => {
      option.setAttribute('aria-pressed', option === button)
    })
    const kind = pickerKind
    try {
      await (kind === 'icon' ? cloud.setIcon(item) : cloud.setBackdrop(item))
      if (pickerKind === kind) pickerDialog.close()
      if (accountDialog.open) cloud.refreshAccount()
    } catch (error) {
      setPickerStatus(`No se pudo guardar: ${error.message}`)
    }
  })
  return button
}

function updatePickerArrows(track) {
  const carousel = $('.picker__carousel', track)
  const max = carousel.scrollWidth - carousel.clientWidth - 1
  $('.picker__arrow[data-direction="-1"]', track).hidden = carousel.scrollLeft <= 0
  $('.picker__arrow[data-direction="1"]', track).hidden = carousel.scrollLeft >= max
}

function createPickerArrow(carousel, direction) {
  const arrow = document.createElement('button')
  arrow.type = 'button'
  arrow.className = 'picker__arrow'
  arrow.dataset.direction = direction
  arrow.setAttribute('aria-label', direction < 0 ? 'Anteriores' : 'Siguientes')
  arrow.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#icon-chevron-${direction < 0 ? 'left' : 'right'}"></use></svg>`
  arrow.addEventListener('click', () => {
    carousel.scrollBy({ left: carousel.clientWidth * 0.8 * direction, behavior: 'smooth' })
  })
  return arrow
}

async function renderPicker(force = false) {
  const requestId = ++pickerRequestId
  const kind = pickerKind
  pickerSections.replaceChildren()
  setPickerStatus(kind === 'icon' ? 'Cargando iconos…' : 'Cargando backdrops…')

  try {
    const sections = await profileCatalog.load(kind, force)
    if (requestId !== pickerRequestId) return
    if (!sections.length) throw new Error('vacío')

    const state = cloud.state()
    const selected = kind === 'icon' ? state.icon : state.backdrop
    pickerSections.replaceChildren(...sections.map(section => {
      const element = document.createElement('section')
      element.className = 'picker__section'

      const folder = document.createElement('h3')
      folder.className = 'picker__folder'
      folder.textContent = section.folder.toUpperCase()

      const pack = document.createElement('p')
      pack.className = 'picker__pack'
      pack.textContent = section.pack

      const carousel = document.createElement('div')
      carousel.className = 'picker__carousel'
      carousel.append(...section.items.map(item => createPickerOption(item, selected)))

      const track = document.createElement('div')
      track.className = 'picker__track'
      track.append(createPickerArrow(carousel, -1), carousel, createPickerArrow(carousel, 1))
      carousel.addEventListener('scroll', () => updatePickerArrows(track), { passive: true })

      element.append(folder, pack, track)
      return element
    }))
    setPickerStatus('')
    pickerSections.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' })
    pickerSections.querySelectorAll('.picker__track').forEach(updatePickerArrows)
  } catch {
    if (requestId !== pickerRequestId) return
    setPickerStatus(kind === 'icon' ? 'No se pudieron cargar los iconos' : 'No se pudieron cargar los backdrops', true)
  }
}

function openPicker(kind) {
  pickerKind = kind
  $('#picker-title').textContent = kind === 'icon' ? 'Seleccionar icono' : 'Seleccionar backdrop'
  pickerDialog.showModal()
  renderPicker()
}

function showAccountError(message) {
  accountError.textContent = message
  accountError.hidden = !message
}

function openAccount() {
  const state = cloud.state()
  pinVisible = false
  // Como AccountActivity: primero pinta lo local y luego tira de la nube.
  renderAccount(state)
  showAccountError(state.configured || state.signedIn ? '' : 'Falta la configuración web de Firebase en scripts/config.js (CONFIG.FIREBASE). Mientras tanto todo se guarda solo en esta PC.')
  if (!accountDialog.open) accountDialog.showModal()
  if (!state.signedIn) accountForm.elements.username.focus()
  else cloud.refreshAccount()
}

function closeAccount() {
  if (pickerDialog.open) pickerDialog.close()
  if (accountDialog.open) accountDialog.close()
}

async function handleAccountSubmit(event) {
  event.preventDefault()
  const data = new FormData(accountForm)
  showAccountError('')
  accountSubmit.disabled = true
  accountSubmit.textContent = 'Entrando…'
  try {
    await cloud.signIn(String(data.get('username') ?? ''), String(data.get('pin') ?? '').trim())
    accountForm.reset()
  } catch (error) {
    showAccountError(error.message)
  } finally {
    accountSubmit.disabled = false
    accountSubmit.textContent = 'Entrar'
  }
}

async function handleSignOut() {
  const accepted = confirm('¿Cerrar sesión? Tu lista, historial y progreso se quitarán de esta PC, pero seguirán guardados en tu cuenta Plix.')
  if (!accepted) return
  await cloud.signOut()
  closeAccount()
}

async function handleEditBio() {
  const current = cloud.state().bio || ''
  const next = prompt(`Descripción del perfil (máx. ${cloud.BIO_MAX} caracteres)`, current)
  if (next == null) return
  try {
    await cloud.setBio(next)
  } catch (error) {
    alert(error.message)
  }
}

/* ---------- Eventos ---------- */

function setupEvents() {
  menuButton.addEventListener('click', () => toggleNavigation())
  $('.navigation__close').addEventListener('click', () => toggleNavigation(false))
  navigationBackdrop.addEventListener('click', () => toggleNavigation(false))
  $('#history-clear').addEventListener('click', () => confirmClearDialog.showModal())
  $('#confirm-clear-accept').addEventListener('click', () => {
    watchHistory.clear()
    confirmClearDialog.close()
  })
  $('#confirm-exit-accept').addEventListener('click', () => {
    saveProgress(true)
    window.plixDesktop.quit()
  })

  heroImage.addEventListener('load', () => heroImage.classList.remove('is-loading'))
  heroImage.addEventListener('error', () => heroImage.classList.remove('is-loading'))

  // Una serie necesita elegir episodio, así que "Ver episodios" abre su detalle.
  $('#hero-play').addEventListener('click', () => {
    if (heroMovie?.type === 'tv') openDetail(heroMovie.id, 'tv')
    else openPlayer(heroMovie)
  })
  $('#hero-info').addEventListener('click', () => heroMovie && openDetail(heroMovie.id, heroMovie.type))
  $('#hero-list').addEventListener('click', () => toggleMyList(heroMovie))

  $('#detail-play').addEventListener('click', () => {
    if (detailMovie?.type !== 'tv') return openPlayer(detailMovie)
    const { episode } = detailTargetEpisode()
    if (episode) openPlayer(detailMovie, { season: detailSeason, episode: episode.number, name: episode.name })
  })
  $('#detail-watch-party')?.addEventListener('click', async () => {
    if (!detailMovie) return
    let season = 0
    let episodeNum = 0
    if (detailMovie.type === 'tv') {
      const target = detailTargetEpisode()
      season = detailSeason || 0
      episodeNum = target.episode?.number || 0
      if (!episodeNum) {
        videoPlayer.showToast('Elegí un episodio antes de crear la sala', 2500)
        return
      }
    }
    try {
      const usedPending = await watchPartyUi.continuePendingHostWithContent(
        detailMovie,
        season,
        episodeNum,
        startWatchPartyAsHost
      )
      if (usedPending) return
    } catch (error) {
      videoPlayer.showToast(error.message || 'No se pudo usar la sala pendiente', 3000)
      return
    }
    watchPartyUi.showCreateForContent(detailMovie, season, episodeNum, startWatchPartyAsHost)
  })
  episodesSeason.addEventListener('change', () => {
    if (detailMovie?.type !== 'tv') return
    playbackProgress.setSelectedSeason(detailMovie.id, Number(episodesSeason.value))
    loadEpisodes(detailMovie, Number(episodesSeason.value))
  })
  $('#detail-list').addEventListener('click', () => toggleMyList(detailMovie))
  $('#detail-synopsis').addEventListener('click', () => openSynopsis(detailMovie))
  $('#open-sala-virtual')?.addEventListener('click', () => salaVirtual.open())
  $('#account-watch-party')?.addEventListener('click', () => {
    accountDialog.close()
    salaVirtual.open()
  })

  salaVirtual.configure({
    onOpenDetail: (id, type) => {
      salaVirtual.close()
      openDetail(id, type)
    },
    onJoinRoom: () => {
      watchPartyUi.showJoinOnly(startWatchPartyAsGuest)
    },
    onEditAvatar: () => openPicker('icon'),
    onEditBackdrop: () => openPicker('backdrop'),
    onEditBio: () => handleEditBio()
  })

  $('#open-search').addEventListener('click', openSearch)
  searchInput.addEventListener('input', handleSearchInput)

  playerDialog.addEventListener('close', () => {
    playerRequestId++
  })

  watchDialog.addEventListener('close', closeWatch)

  watchVideo.addEventListener('loadedmetadata', resumePlayback)
  watchVideo.addEventListener('timeupdate', () => saveProgress())
  watchVideo.addEventListener('pause', () => saveProgress(true))
  watchVideo.addEventListener('playing', () => {
    markPlaybackStarted(hlsInstance ? 'hls' : dashInstance ? 'dash' : 'video')
    releaseCaptureWhenPlaying()
  })
  watchVideo.addEventListener('ended', () => {
    saveProgress(true)
    if (watchSession) analytics.log('video_complete', playbackParams())
  })

  accountButton.addEventListener('click', openAccount)
  accountForm.addEventListener('submit', handleAccountSubmit)
  accountSyncButton.addEventListener('click', () => cloud.syncNow())
  $('#account-signout').addEventListener('click', handleSignOut)
  pinToggle.addEventListener('click', () => {
    pinVisible = !pinVisible
    renderPin(cloud.state().pin)
  })
  $('#edit-avatar').addEventListener('click', () => openPicker('icon'))
  $('#edit-backdrop').addEventListener('click', () => openPicker('backdrop'))
  $('#edit-bio').addEventListener('click', handleEditBio)
  $('.picker__retry').addEventListener('click', () => renderPicker(true))
  accountDialog.addEventListener('close', () => {
    if (pickerDialog.open) pickerDialog.close()
    const video = $('.profile-card__backdrop-video')
    if (video && !video.hidden) video.pause()
  })
  genreBrowseDialog?.addEventListener('close', stopGenreBrowse)
  // Al volver a la ventana con Cuenta abierta, relee remoto como onResume de AccountActivity.
  window.addEventListener('focus', () => {
    if (accountDialog.open && cloud.state().signedIn) cloud.refreshAccount()
  })
  cloud.onChange(state => {
    renderAccount(state)
    if (document.querySelector('#sala-virtual')?.open) {
      salaVirtual.renderProfile(state)
      salaVirtual.renderRecents()
    }
  })

  // Al salir de la pantalla completa (Esc o botón del navegador) se vuelve a la lista de servidores.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && watchDialog.open) watchDialog.close()
  })

  ;[detailDialog, synopsisDialog, playerDialog, confirmClearDialog, confirmExitDialog, pickerDialog].forEach(dialog => {
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close()
    })
  })

  document.addEventListener('click', event => {
    const closeButton = event.target.closest('[data-close]')
    if (closeButton) return closeButton.closest('dialog').close()

    const arrow = event.target.closest('.row__arrow')
    if (arrow) return scrollRow(arrow)

    const episodesArrow = event.target.closest('.episodes__arrow')
    if (episodesArrow) {
      return episodesList.scrollBy({
        left: episodesList.clientWidth * 0.8 * Number(episodesArrow.dataset.direction),
        behavior: 'smooth'
      })
    }

    const card = event.target.closest('.card[data-id], .poster-card[data-id]')
    if (card) openDetail(Number(card.dataset.id), card.dataset.type)
  })

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (navigation.classList.contains('active')) toggleNavigation(false)
      else if (canConfirmExit()) {
        event.preventDefault()
        confirmExitDialog.showModal()
      }
    }

    const isTyping = event.target instanceof Element && event.target.matches('input, textarea, [contenteditable]')
    if (event.key === '/' && !isTyping && !document.querySelector('dialog[open]')) {
      event.preventDefault()
      openSearch()
    }
  })

  window.addEventListener('resize', () => {
    if (detailDialog.open && detailMovie) updateSynopsisButton()
  })

  window.addEventListener('scroll', () => {
    header.classList.toggle('header--solid', window.scrollY > 40)
  }, { passive: true })

  myList.onChange(handleMyListChange)
  watchHistory.onChange(renderHistory)
}

setupEvents()
handleMyListChange()
renderHistory()
renderAccount()
loadHero()
loadRows()
