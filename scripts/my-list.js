const myList = (() => {
  const STORAGE_KEY = 'disney-plus:mi-lista'
  const listeners = []
  let items = read()

  // Lo guardado antes de agregar series no tiene type: eran películas.
  function keyOf(item) {
    return `${item.type ?? 'movie'}:${item.id}`
  }

  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
      return Array.isArray(saved) ? saved.map(item => ({ type: 'movie', ...item })) : []
    } catch {
      return []
    }
  }

  function notify() {
    listeners.forEach(listener => listener(all()))
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    } catch (error) {
      console.warn('No se pudo guardar Mi lista:', error)
    }
    notify()
  }

  function all() {
    return [...items]
  }

  function has(item) {
    return items.some(saved => keyOf(saved) === keyOf(item))
  }

  function toggle(item) {
    const { seasons, seasonCount, ...saved } = item
    items = has(item) ? items.filter(entry => keyOf(entry) !== keyOf(item)) : [saved, ...items]
    persist()
  }

  function replace(list) {
    items = list.map(({ seasons, seasonCount, ...saved }) => ({ type: 'movie', ...saved }))
    persist()
  }

  function onChange(listener) {
    listeners.push(listener)
  }

  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY) return
    items = read()
    notify()
  })

  return { all, has, toggle, replace, onChange }
})()
