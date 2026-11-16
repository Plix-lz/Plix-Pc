const title = document.getElementById('title')
const detail = document.getElementById('detail')
const bar = document.getElementById('bar')
const fill = document.getElementById('fill')
const actions = document.getElementById('actions')

const BUTTONS = {
  allow: { label: 'Permitir y descargar', style: 'primary' },
  retry: { label: 'Reintentar', style: 'primary' },
  update: { label: 'Actualizar ahora', style: 'primary' },
  edge: { label: 'Usar Microsoft Edge', style: 'secondary' },
  quit: { label: 'Salir', style: 'secondary' }
}

function render(state) {
  title.textContent = state.title ?? ''
  detail.textContent = state.detail ?? ''

  bar.hidden = state.progress === undefined
  bar.classList.toggle('bar--indeterminate', state.progress === null)
  fill.style.width = typeof state.progress === 'number' ? `${Math.round(state.progress * 100)}%` : ''

  actions.replaceChildren(...(state.buttons ?? []).map(id => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = BUTTONS[id].style
    button.textContent = BUTTONS[id].label
    button.addEventListener('click', () => {
      actions.hidden = true
      window.plixSetup.choose(id)
    })
    return button
  }))
  actions.hidden = !state.buttons?.length
  actions.querySelector('.primary')?.focus()
}

window.plixSetup.onState(render)
window.plixSetup.version().then(version => {
  document.getElementById('version').textContent = `Plix ${version}`
})
