// Historial de contenido visto, misma lógica que Plix (ContentHistoryStore): independiente de Mi lista,
// el más reciente primero, sin repetidos por ID + tipo y con un máximo de 40 títulos.
const watchHistory = (() => {
  const STORAGE_KEY = 'lzplay:historial'
  const MAX_ENTRIES = 40
  const listeners = []
  let entries = read()

  function keyOf(item) {
    return `${item.type ?? 'movie'}:${item.id}`
  }

  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
      return Array.isArray(saved) ? saved.filter(entry => entry?.id && (entry.type === 'movie' || entry.type === 'tv')) : []
    } catch {
      return []
    }
  }

  function notify() {
    listeners.forEach(listener => listener(all()))
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    } catch (error) {
      console.warn('No se pudo guardar el historial:', error)
    }
    notify()
  }

  function all() {
    return [...entries]
  }

  function record(item) {
    if (!item?.id) return
    const { id, type = 'movie', title, overview, rating, genre, year, runtime, backdrop, poster } = item
    const entry = { id, type, title, overview, rating, genre, year, runtime, backdrop, poster, openedAt: Date.now() }
    entries = [entry, ...entries.filter(saved => keyOf(saved) !== keyOf(entry))].slice(0, MAX_ENTRIES)
    persist()
  }

  function clear() {
    entries = []
    persist()
  }

  function replace(list) {
    entries = list
      .filter(entry => entry?.id && (entry.type === 'movie' || entry.type === 'tv'))
      .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))
      .filter((entry, index, sorted) => sorted.findIndex(other => keyOf(other) === keyOf(entry)) === index)
      .slice(0, MAX_ENTRIES)
    persist()
  }

  function onChange(listener) {
    listeners.push(listener)
  }

  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY) return
    entries = read()
    notify()
  })

  return { all, record, clear, replace, onChange }
})()
