// Tarjeta del paso humano (HumanCheckDialog de Plix): muestra en vivo el embed abierto en el Chrome
// del servidor local, le reenvía clics, rueda y teclado, y entrega el HLS en cuanto aparece.
const humanCheckView = (() => {
  const root = document.querySelector('#watch .human')
  const title = root.querySelector('.human__title')
  const hint = root.querySelector('.human__hint')
  const reloadButton = root.querySelector('.human__reload')
  const screen = root.querySelector('.human__screen')
  const view = root.querySelector('.human__view')
  const loading = root.querySelector('.human__loading')

  const HINT = 'Resuelve la verificación y luego pulsa reproducir en el video.'
  const FAILED = 'No apareció el video a tiempo. Pulsa Recargar para intentarlo de nuevo.'
  const BUTTONS = ['left', 'middle', 'right']
  const KEYS = new Set([
    'Enter', 'Backspace', 'Tab', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'
  ])

  let check = null
  let handlers = null

  function point(event) {
    const rect = screen.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
  }

  function send(event) {
    check?.input(event)
  }

  function fail(current) {
    if (check !== current) return
    current.events.close()
    loading.hidden = true
    hint.textContent = FAILED
  }

  /** Cierra la tarjeta; si el video aún no apareció, también se destruye la sesión del servidor. */
  function hide() {
    if (check) {
      check.events.close()
      check.cancel()
    }
    check = null
    handlers = null
    root.hidden = true
    view.hidden = true
    view.removeAttribute('src')
  }

  /** `current` viene de servers.startHumanCheck(); onReady recibe { type, url, session }. */
  function open(serverName, current, { onReady, onReload }) {
    hide()
    check = current
    handlers = { onReady, onReload }
    title.textContent = `Verificación de ${serverName}`
    hint.textContent = HINT
    loading.hidden = false
    root.hidden = false
    screen.focus({ preventScroll: true })

    current.events.addEventListener('frame', event => {
      if (check !== current) return
      view.src = `data:image/jpeg;base64,${event.data}`
      view.hidden = false
      loading.hidden = true
    })
    current.events.addEventListener('ready', event => {
      if (check !== current) return
      const ready = handlers.onReady
      current.events.close()
      check = null
      hide()
      ready(JSON.parse(event.data))
    })
    current.events.addEventListener('failed', () => fail(current))
    current.events.addEventListener('error', () => {
      if (current.events.readyState === EventSource.CLOSED) fail(current)
    })
  }

  reloadButton.addEventListener('click', () => handlers?.onReload())

  screen.addEventListener('pointerdown', event => {
    if (!check) return
    event.preventDefault()
    screen.focus({ preventScroll: true })
    screen.setPointerCapture(event.pointerId)
    send({ type: 'down', ...point(event), button: BUTTONS[event.button] ?? 'left' })
  })
  screen.addEventListener('pointermove', event => {
    if (check) send({ type: 'move', ...point(event) })
  })
  screen.addEventListener('pointerup', event => {
    if (check) send({ type: 'up', ...point(event), button: BUTTONS[event.button] ?? 'left' })
  })
  screen.addEventListener('contextmenu', event => event.preventDefault())
  screen.addEventListener('wheel', event => {
    if (!check) return
    event.preventDefault()
    send({ type: 'wheel', ...point(event), deltaX: event.deltaX, deltaY: event.deltaY })
  }, { passive: false })

  screen.addEventListener('keydown', event => {
    // Escape sigue cerrando el reproductor; los atajos del sistema no se reenvían.
    if (!check || event.key === 'Escape' || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key.length === 1) send({ type: 'text', text: event.key })
    else if (KEYS.has(event.key)) send({ type: 'key', key: event.key })
    else return
    event.preventDefault()
    event.stopPropagation()
  })
  screen.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text')
    if (!check || !text) return
    event.preventDefault()
    send({ type: 'text', text })
  })

  return { open, hide }
})()
