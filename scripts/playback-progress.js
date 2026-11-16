// Progreso de reproducción con las mismas claves y reglas que Plix (PlaybackProgressStore y
// PlayerActivity). Se guarda con el formato {t, v} de LocalPrefsBackup para subirlo sin convertir.
const playbackProgress = (() => {
  const STORAGE_KEY = 'lzplay:progreso'
  const MIN_RESUME_MS = 10_000
  const END_MARGIN_MS = 30_000
  const listeners = []
  let data = read()

  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
    } catch {
      return {}
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch (error) {
      console.warn('No se pudo guardar el progreso:', error)
    }
    listeners.forEach(listener => listener())
  }

  function positionKey(media, episode) {
    return media.type === 'tv' && episode
      ? `series:${media.id}:t${episode.season}:e${episode.episode}`
      : `movie:${media.id}`
  }

  function value(key) {
    return data[key]?.v
  }

  function savedPosition(media, episode) {
    return Number(value(positionKey(media, episode))) || 0
  }

  /** Posición (ms) desde la que reanudar, o 0. Igual que Plix: menos de 10 s o en los últimos 30 s se descarta. */
  function resumePosition(media, episode, durationMs) {
    const key = positionKey(media, episode)
    const saved = Number(value(key)) || 0
    const nearEnd = durationMs > 0 && saved >= durationMs - END_MARGIN_MS
    if (nearEnd) {
      delete data[key]
      persist()
    }
    return saved < MIN_RESUME_MS || nearEnd ? 0 : saved
  }

  function save(media, episode, positionMs, durationMs) {
    const key = positionKey(media, episode)
    const finished = durationMs > 0 && positionMs >= durationMs - END_MARGIN_MS
    if (finished) {
      if (!(key in data)) return
      delete data[key]
    } else {
      const position = Math.max(0, Math.round(positionMs))
      if (value(key) === position) return
      data[key] = { t: 'l', v: position }
    }
    persist()
  }

  function markStarted(media, episode) {
    const series = media.type === 'tv'
    data[`started:${series ? 'series' : 'movie'}:${media.id}`] = { t: 'b', v: true }
    if (series && episode) {
      const { season, episode: number } = episode
      data[`watched:series:${media.id}:t${season}:e${number}`] = { t: 'b', v: true }
      data[`series:${media.id}:t${season}:last_episode`] = { t: 'i', v: number }
      data[`series:${media.id}:selected_season`] = { t: 'i', v: season }
    }
    persist()
  }

  function setSelectedSeason(seriesId, season) {
    data[`series:${seriesId}:selected_season`] = { t: 'i', v: season }
    persist()
  }

  function selectedSeason(seriesId) {
    return Number(value(`series:${seriesId}:selected_season`)) || null
  }

  function lastEpisode(seriesId, season) {
    return Number(value(`series:${seriesId}:t${season}:last_episode`)) || null
  }

  function watchedEpisodes(seriesId, season) {
    const prefix = `watched:series:${seriesId}:t${season}:e`
    return new Set(Object.keys(data)
      .filter(key => key.startsWith(prefix) && value(key) === true)
      .map(key => Number(key.slice(prefix.length)))
      .filter(Number.isFinite))
  }

  /** Datos crudos {clave: {t, v}} para la sincronización. */
  function raw() {
    return { ...data }
  }

  function replace(next) {
    data = next && typeof next === 'object' ? { ...next } : {}
    persist()
  }

  function onChange(listener) {
    listeners.push(listener)
  }

  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY) return
    data = read()
    listeners.forEach(listener => listener())
  })

  return {
    savedPosition, resumePosition, save, markStarted, setSelectedSeason, selectedSeason,
    lastEpisode, watchedEpisodes, raw, replace, onChange
  }
})()
