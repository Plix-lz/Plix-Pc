const salaVirtualRecents = (() => {
  const KEY = 'plix_sala_virtual_recents'
  const TAG = 'SalaVirtual'
  const MAX = 40

  function read() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY) || '[]')
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }

  function write(entries) {
    try {
      localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX)))
    } catch (error) {
      console.warn('No se pudieron guardar recientes de sala:', error)
    }
  }

  function record(movie) {
    if (!movie?.id) return
    const contentType = movie.type === 'tv' || movie.type === 'series'
      ? WatchPartyConfig.TYPE_SERIES
      : WatchPartyConfig.TYPE_MOVIE
    const entry = {
      id: Number(movie.id),
      tag: TAG,
      contentType,
      openedAt: Date.now(),
      title: movie.title || '',
      overview: movie.overview || '',
      posterUrl: movie.poster || '',
      backdropUrl: movie.backdrop || '',
      year: movie.year || '',
      rating: movie.rating ?? 0,
      type: contentType === WatchPartyConfig.TYPE_SERIES ? 'tv' : 'movie'
    }
    const previous = read().filter(item => !(item.id === entry.id && item.contentType === contentType))
    write([entry, ...previous])
  }

  function list() {
    return read().filter(item => item.tag === TAG)
  }

  return { record, list }
})()
