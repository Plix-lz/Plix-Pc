// Controles personalizados del reproductor (#watch): barra de progreso, saltos, gestos de
// volumen (mitad izquierda) y brillo (mitad derecha) y menú de calidad con los niveles de hls.js.
const videoPlayer = (() => {
  const root = document.querySelector('#watch')
  const video = root.querySelector('video')
  const title = root.querySelector('.watch__title')
  const playButton = root.querySelector('.watch__play')
  const seek = root.querySelector('.watch__seek')
  const preview = root.querySelector('.watch__preview')
  const currentTime = root.querySelector('.watch__time--current')
  const totalTime = root.querySelector('.watch__time--total')
  const buffering = root.querySelector('.watch__buffering')
  const toast = root.querySelector('.watch__toast')
  const settingsToggle = root.querySelector('.watch__settings-toggle')
  const settings = root.querySelector('.watch__settings')
  const volumeLevel = root.querySelector('.watch__level--volume')
  const brightnessLevel = root.querySelector('.watch__level--brightness')
  const previousButton = root.querySelector('.watch__previous-episode')
  const nextButton = root.querySelector('.watch__next-episode')
  const episodesToggle = root.querySelector('.watch__episodes-toggle')
  const episodesPanel = root.querySelector('.watch__episodes')
  const episodesSeason = root.querySelector('.watch__episodes-season')
  const episodesList = root.querySelector('.watch__episodes-list')

  const IDLE_MS = 3000
  const LEVEL_MS = 1000
  const MIN_BRIGHTNESS = 0.3
  const MAX_BRIGHTNESS = 1.5
  // Arrastrar el 60 % del alto de la pantalla recorre todo el rango.
  const GESTURE_RANGE = 0.6
  const GESTURE_THRESHOLD_PX = 10

  let hls = null
  let dragging = false
  let idleTimer = null
  let toastTimer = null
  let brightness = 1
  let gesture = null
  let suppressClick = false
  let episodes = null
  let partyGuestLocked = false
  let partyHooks = null
  const levelTimers = new Map()

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
    const total = Math.floor(seconds)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = String(total % 60).padStart(2, '0')
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
  }

  function setIcon(element, name) {
    element.querySelector('use').setAttribute('href', `#icon-${name}`)
  }

  function showToast(text, duration = 900) {
    toast.textContent = text
    toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toast.hidden = true }, duration)
  }

  /* ---------- Visibilidad de los controles ---------- */

  function showControls() {
    root.classList.remove('watch--idle')
    clearTimeout(idleTimer)
    if (root.dataset.mode !== 'video' || video.paused || !settings.hidden || !episodesPanel.hidden || gesture) return
    idleTimer = setTimeout(() => root.classList.add('watch--idle'), IDLE_MS)
  }

  /* ---------- Reproducción y tiempo ---------- */

  function togglePlay() {
    if (root.dataset.mode !== 'video') return
    if (partyGuestLocked) return
    if (video.paused) video.play().catch(() => {})
    else video.pause()
  }

  function skip(seconds) {
    if (partyGuestLocked) return
    if (!Number.isFinite(video.duration)) return
    video.currentTime = clamp(video.currentTime + seconds, 0, video.duration - 0.5)
    showToast(`${seconds > 0 ? '+' : '−'}${Math.abs(seconds)} s`)
    showControls()
    partyHooks?.onSeek?.()
  }

  function getPositionMs() {
    return Math.max(0, Math.round((video.currentTime || 0) * 1000))
  }

  function getDurationMs() {
    return Number.isFinite(video.duration) ? Math.max(0, Math.round(video.duration * 1000)) : 0
  }

  function isPlaying() {
    return root.dataset.mode === 'video' && !video.paused && !video.ended
  }

  function getSpeed() {
    return video.playbackRate || 1
  }

  function applyPlay() {
    if (root.dataset.mode !== 'video') return
    video.play().catch(() => {})
  }

  function applyPause() {
    video.pause()
  }

  function applySeek(positionMs) {
    if (!Number.isFinite(video.duration) && !video.seekable?.length) {
      video.currentTime = Math.max(0, positionMs / 1000)
      return
    }
    const seconds = Math.max(0, positionMs / 1000)
    const max = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.25) : seconds
    video.currentTime = clamp(seconds, 0, max)
    updateProgress()
  }

  function applySpeed(speed) {
    video.playbackRate = speed > 0 ? speed : 1
  }

  function setWatchPartyGuest(locked) {
    partyGuestLocked = Boolean(locked)
    root.classList.toggle('watch--party-guest', partyGuestLocked)
  }

  function setWatchPartyHooks(hooks) {
    partyHooks = hooks || null
  }

  function updateProgress() {
    const duration = video.duration
    if (!Number.isFinite(duration) || !duration) return
    if (!dragging) {
      seek.value = Math.round((video.currentTime / duration) * 1000)
      currentTime.textContent = formatTime(video.currentTime)
    }
    seek.style.setProperty('--progress', `${(seek.value / 10).toFixed(2)}%`)
  }

  function updateBuffered() {
    const duration = video.duration
    if (!Number.isFinite(duration) || !duration || !video.buffered.length) return
    let end = 0
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime + 1) end = Math.max(end, video.buffered.end(i))
    }
    seek.style.setProperty('--buffered', `${((end / duration) * 100).toFixed(2)}%`)
  }

  function updatePlayButton() {
    const paused = video.paused
    setIcon(playButton, paused ? 'play-solid' : 'pause')
    playButton.setAttribute('aria-label', paused ? 'Reproducir' : 'Pausar')
    root.classList.toggle('watch--paused', paused)
    showControls()
  }

  function seekPreview(event) {
    const duration = video.duration
    if (!Number.isFinite(duration)) return
    const rect = seek.getBoundingClientRect()
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1)
    preview.textContent = formatTime(ratio * duration)
    preview.style.left = `${ratio * 100}%`
    preview.hidden = false
  }

  /* ---------- Volumen y brillo ---------- */

  function showLevel(element, ratio, text) {
    element.style.setProperty('--level', `${(ratio * 100).toFixed(1)}%`)
    element.querySelector('.watch__level-value').textContent = text
    element.hidden = false
    clearTimeout(levelTimers.get(element))
    levelTimers.set(element, setTimeout(() => { element.hidden = true }, LEVEL_MS))
  }

  function setVolume(value) {
    video.volume = clamp(value, 0, 1)
    video.muted = video.volume === 0
    showVolume()
  }

  function showVolume() {
    const level = video.muted ? 0 : video.volume
    setIcon(volumeLevel, level === 0 ? 'volume-mute' : 'volume')
    showLevel(volumeLevel, level, level === 0 ? 'Silencio' : `${Math.round(level * 100)}%`)
  }

  function toggleMute() {
    if (video.muted && video.volume === 0) video.volume = 0.5
    video.muted = !video.muted
    showVolume()
  }

  function setBrightness(value) {
    brightness = clamp(value, MIN_BRIGHTNESS, MAX_BRIGHTNESS)
    video.style.filter = brightness === 1 ? '' : `brightness(${brightness})`
    showLevel(
      brightnessLevel,
      (brightness - MIN_BRIGHTNESS) / (MAX_BRIGHTNESS - MIN_BRIGHTNESS),
      `${Math.round(brightness * 100)}%`
    )
  }

  function sideAt(clientX) {
    const rect = root.getBoundingClientRect()
    return clientX - rect.left < rect.width / 2 ? 'volume' : 'brightness'
  }

  function adjust(side, delta) {
    if (side === 'volume') setVolume((video.muted ? 0 : video.volume) + delta)
    else setBrightness(brightness + delta * (MAX_BRIGHTNESS - MIN_BRIGHTNESS))
  }

  function startGesture(event) {
    if (event.button !== 0 || root.dataset.mode !== 'video' || !settings.hidden || !episodesPanel.hidden) return
    const side = sideAt(event.clientX)
    gesture = {
      id: event.pointerId,
      y: event.clientY,
      side,
      start: side === 'volume' ? (video.muted ? 0 : video.volume) : brightness,
      height: root.clientHeight,
      moved: false
    }
    video.setPointerCapture(event.pointerId)
  }

  function moveGesture(event) {
    if (!gesture || event.pointerId !== gesture.id) return
    const distance = gesture.y - event.clientY
    if (!gesture.moved && Math.abs(distance) < GESTURE_THRESHOLD_PX) return
    gesture.moved = true
    const ratio = distance / (gesture.height * GESTURE_RANGE)
    if (gesture.side === 'volume') setVolume(gesture.start + ratio)
    else setBrightness(gesture.start + ratio * (MAX_BRIGHTNESS - MIN_BRIGHTNESS))
  }

  function endGesture(event) {
    if (!gesture || event.pointerId !== gesture.id) return
    suppressClick = gesture.moved
    gesture = null
    showControls()
  }

  /* ---------- Recuperación al volver a la ventana ---------- */

  const FRAME_CHECK_MS = 800

  // Resuelve true si el navegador pinta al menos un cuadro nuevo dentro del plazo.
  function waitForFrame(timeout) {
    return new Promise(resolve => {
      if (!video.requestVideoFrameCallback) {
        const start = video.currentTime
        setTimeout(() => resolve(video.currentTime !== start), timeout)
        return
      }
      const timer = setTimeout(() => resolve(false), timeout)
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  // Chrome deja de decodificar la imagen en segundo plano y, con MSE, a veces no la reanuda:
  // el audio sigue pero el cuadro queda congelado. Un salto al mismo punto reinicia el decodificador.
  let recovering = false

  async function recoverFrozenVideo() {
    if (recovering || document.hidden || root.dataset.mode !== 'video' || video.paused || video.ended) return
    recovering = true
    try {
      if (await waitForFrame(FRAME_CHECK_MS)) return
      if (video.paused || root.dataset.mode !== 'video') return

      video.currentTime = Math.max(video.currentTime - 0.1, 0)
      if (await waitForFrame(FRAME_CHECK_MS * 2)) return
      if (hls && !video.paused) {
        const time = video.currentTime
        hls.recoverMediaError()
        video.currentTime = time
        video.play().catch(() => {})
      }
    } finally {
      recovering = false
    }
  }

  /* ---------- Calidad ---------- */

  function qualityOptions() {
    if (!(hls?.levels?.length > 1)) {
      const height = hls?.levels?.[0]?.height || video.videoHeight
      return [{ label: height ? `${height}p` : 'Original', active: true, select: () => {} }]
    }

    const levels = hls.levels
      .map((level, index) => ({ level, index }))
      .sort((a, b) => (b.level.height || b.level.bitrate) - (a.level.height || a.level.bitrate))
    const current = hls.levels[hls.currentLevel]?.height
    return [
      {
        label: hls.autoLevelEnabled && current ? `Automática (${current}p)` : 'Automática',
        active: hls.autoLevelEnabled,
        select: () => { hls.currentLevel = -1 }
      },
      ...levels.map(({ level, index }) => ({
        label: level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)} kbps`,
        active: !hls.autoLevelEnabled && hls.currentLevel === index,
        select: () => { hls.currentLevel = index }
      }))
    ]
  }

  function renderSettings() {
    if (settings.hidden) return

    const group = document.createElement('section')
    group.className = 'watch__settings-group'

    const heading = document.createElement('h3')
    heading.textContent = 'Calidad'

    const list = document.createElement('div')
    list.className = 'watch__options'
    list.setAttribute('role', 'radiogroup')
    list.setAttribute('aria-label', 'Calidad')

    qualityOptions().forEach(option => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'watch__option'
      button.setAttribute('role', 'radio')
      button.setAttribute('aria-checked', option.active)
      button.textContent = option.label
      button.addEventListener('click', () => {
        option.select()
        renderSettings()
      })
      list.append(button)
    })

    group.append(heading, list)
    settings.replaceChildren(group)
  }

  function toggleSettings(force = settings.hidden) {
    if (force) toggleEpisodes(false)
    settings.hidden = !force
    settingsToggle.setAttribute('aria-expanded', force)
    renderSettings()
    showControls()
  }

  /* ---------- Episodios (como el panel del reproductor de Plix) ---------- */

  function createEpisodeCard(item, state) {
    const playing = item.season === state.season && item.episode === state.episode
    const watched = state.watched?.has(item.episode)

    const entry = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'watch__episode'
    if (playing) button.setAttribute('aria-current', 'true')
    button.addEventListener('click', () => {
      toggleEpisodes(false)
      if (!playing) episodes?.select(item)
    })

    const thumb = document.createElement('div')
    thumb.className = 'watch__episode-thumb'
    if (item.image) {
      const image = document.createElement('img')
      image.src = item.image
      image.alt = ''
      image.loading = 'lazy'
      thumb.append(image)
    }

    const badge = document.createElement('span')
    badge.className = 'watch__episode-badge'
    badge.textContent = `T${item.season} - E${item.episode}`
    thumb.append(badge)

    if (playing || watched) {
      const status = document.createElement('span')
      status.className = 'watch__episode-status'
      status.textContent = playing ? 'Reproduciendo' : 'Visto'
      thumb.append(status)
    }

    const name = document.createElement('strong')
    name.className = 'watch__episode-name'
    name.textContent = item.name || 'Desconocido'

    button.append(thumb, name)
    entry.append(button)
    return entry
  }

  function renderEpisodes() {
    const state = episodes?.state()
    previousButton.hidden = !state
    nextButton.hidden = !state
    episodesToggle.hidden = !state?.items.length
    if (!state) {
      toggleEpisodes(false)
      return
    }
    // Ocultarlos con visibility mantiene centrado el botón de reproducir.
    previousButton.classList.toggle('watch__button--unavailable', !state.hasPrevious)
    nextButton.classList.toggle('watch__button--unavailable', !state.hasNext)
    previousButton.disabled = !state.hasPrevious
    nextButton.disabled = !state.hasNext
    if (episodesPanel.hidden) return

    episodesSeason.textContent = state.seasonName ?? `Temporada ${state.season}`
    episodesList.replaceChildren(...state.items.map(item => createEpisodeCard(item, state)))
    const current = episodesList.querySelector('[aria-current="true"]')
    current?.scrollIntoView({ block: 'nearest', inline: 'center' })
    ;(current ?? episodesList.querySelector('button'))?.focus({ preventScroll: true })
  }

  function toggleEpisodes(force = episodesPanel.hidden) {
    const open = Boolean(force && episodes?.state()?.items.length)
    if (open === !episodesPanel.hidden) return
    episodesPanel.hidden = !open
    episodesToggle.setAttribute('aria-expanded', open)
    root.classList.toggle('watch--episodes', open)
    if (open) {
      toggleSettings(false)
      renderEpisodes()
    } else {
      episodesList.replaceChildren()
      if (root.dataset.mode === 'video') episodesToggle.focus({ preventScroll: true })
    }
    showControls()
  }

  /**
   * null para películas. Para series, un objeto con state() → { season, episode, seasonName,
   * items: [{ season, episode, name, image }], watched: Set, hasPrevious, hasNext },
   * y las acciones select(item), previous() y next().
   */
  function setEpisodes(provider) {
    episodes = provider
    renderEpisodes()
  }

  /* ---------- API pública ---------- */

  function setTitle(text) {
    title.textContent = text
  }

  /** 'loading' (extrayendo), 'message' (error), 'video' (controles propios) o 'frame' (reproductor del embed). */
  function setMode(mode) {
    root.dataset.mode = mode
    if (mode === 'video') {
      buffering.hidden = video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
      // Con el foco dentro del reproductor funcionan los atajos de teclado.
      playButton.focus({ preventScroll: true })
    } else {
      toggleSettings(false)
      toggleEpisodes(false)
    }
    showControls()
  }

  function attachHls(instance) {
    hls = instance
    if (!hls || !window.Hls) return
    const { Events } = window.Hls
    ;[Events.MANIFEST_PARSED, Events.LEVEL_SWITCHED, Events.LEVELS_UPDATED]
      .forEach(event => hls.on(event, renderSettings))
  }

  function reset() {
    hls = null
    dragging = false
    gesture = null
    partyGuestLocked = false
    partyHooks = null
    root.classList.remove('watch--party-guest')
    clearTimeout(idleTimer)
    toggleSettings(false)
    toggleEpisodes(false)
    buffering.hidden = true
    toast.hidden = true
    preview.hidden = true
    volumeLevel.hidden = true
    brightnessLevel.hidden = true
    seek.value = 0
    seek.style.setProperty('--progress', '0%')
    seek.style.setProperty('--buffered', '0%')
    currentTime.textContent = '0:00'
    totalTime.textContent = '0:00'
    root.classList.remove('watch--idle')
    root.dataset.mode = 'loading'
    updatePlayButton()
  }

  /* ---------- Eventos ---------- */

  video.addEventListener('play', () => {
    updatePlayButton()
    if (!partyGuestLocked) partyHooks?.onPlay?.()
  })
  video.addEventListener('pause', () => {
    updatePlayButton()
    if (!partyGuestLocked) partyHooks?.onPause?.()
  })
  video.addEventListener('timeupdate', updateProgress)
  video.addEventListener('progress', updateBuffered)
  video.addEventListener('durationchange', () => {
    totalTime.textContent = formatTime(video.duration)
    updateProgress()
  })
  video.addEventListener('waiting', () => { buffering.hidden = false })
  ;['playing', 'canplay', 'seeked', 'emptied'].forEach(event => {
    video.addEventListener(event, () => { buffering.hidden = true })
  })
  video.addEventListener('loadedmetadata', renderSettings)

  video.addEventListener('pointerdown', startGesture)
  video.addEventListener('pointermove', moveGesture)
  video.addEventListener('pointerup', endGesture)
  video.addEventListener('pointercancel', endGesture)
  video.addEventListener('click', () => {
    if (suppressClick) {
      suppressClick = false
      return
    }
    if (!episodesPanel.hidden) toggleEpisodes(false)
    else if (!settings.hidden) toggleSettings(false)
    else togglePlay()
  })

  playButton.addEventListener('click', togglePlay)
  root.querySelectorAll('[data-skip]').forEach(button => {
    button.addEventListener('click', () => skip(Number(button.dataset.skip)))
  })
  settingsToggle.addEventListener('click', () => toggleSettings())
  previousButton.addEventListener('click', () => episodes?.previous())
  nextButton.addEventListener('click', () => episodes?.next())
  episodesToggle.addEventListener('click', () => toggleEpisodes())
  // Esc cierra primero el panel de episodios y no el reproductor.
  root.addEventListener('cancel', event => {
    if (episodesPanel.hidden) return
    event.preventDefault()
    toggleEpisodes(false)
  })
  episodesList.addEventListener('wheel', event => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    event.preventDefault()
    episodesList.scrollLeft += event.deltaY
  }, { passive: false })

  seek.addEventListener('input', () => {
    dragging = true
    const time = (seek.value / 1000) * (video.duration || 0)
    currentTime.textContent = formatTime(time)
    seek.style.setProperty('--progress', `${(seek.value / 10).toFixed(2)}%`)
  })
  seek.addEventListener('change', () => {
    if (partyGuestLocked) {
      dragging = false
      updateProgress()
      return
    }
    if (Number.isFinite(video.duration)) video.currentTime = (seek.value / 1000) * video.duration
    dragging = false
    partyHooks?.onSeek?.()
  })
  seek.addEventListener('pointermove', seekPreview)
  seek.addEventListener('pointerleave', () => { preview.hidden = true })

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) recoverFrozenVideo()
  })
  window.addEventListener('focus', recoverFrozenVideo)

  root.addEventListener('pointermove', showControls)
  root.addEventListener('pointerdown', showControls)
  root.addEventListener('wheel', event => {
    if (root.dataset.mode !== 'video' || settings.contains(event.target) || episodesPanel.contains(event.target)) return
    event.preventDefault()
    adjust(sideAt(event.clientX), event.deltaY > 0 ? 0.05 : -0.05)
  }, { passive: false })

  root.addEventListener('keydown', event => {
    if (root.dataset.mode !== 'video' || event.altKey || event.ctrlKey || event.metaKey) return
    if (episodesPanel.contains(event.target)) {
      const cards = [...episodesList.querySelectorAll('button')]
      const index = cards.indexOf(event.target)
      const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
      if (step && index >= 0) {
        event.preventDefault()
        cards[Math.min(Math.max(index + step, 0), cards.length - 1)].focus()
      }
      return
    }
    // Sobre un botón o la barra, Espacio/Enter/flechas laterales conservan su comportamiento nativo.
    const onControl = event.target instanceof Element && event.target.matches('button, input')
    if (onControl && [' ', 'Enter', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return

    if (event.shiftKey && episodes && ['N', 'P'].includes(event.key.toUpperCase())) {
      event.preventDefault()
      const state = episodes.state()
      if (event.key.toUpperCase() === 'N' && state.hasNext) episodes.next()
      if (event.key.toUpperCase() === 'P' && state.hasPrevious) episodes.previous()
      return
    }

    const actions = {
      e: () => toggleEpisodes(),
      ' ': togglePlay,
      k: togglePlay,
      ArrowLeft: () => skip(-10),
      ArrowRight: () => skip(10),
      j: () => skip(-10),
      l: () => skip(10),
      ArrowUp: () => adjust('volume', 0.1),
      ArrowDown: () => adjust('volume', -0.1),
      m: toggleMute,
      b: () => adjust('brightness', 0.1),
      n: () => adjust('brightness', -0.1)
    }
    const action = actions[event.key.length === 1 ? event.key.toLowerCase() : event.key]
    if (!action) return
    event.preventDefault()
    action()
    showControls()
  })

  return {
    setTitle,
    setMode,
    attachHls,
    reset,
    showToast,
    formatTime,
    setEpisodes,
    getPositionMs,
    getDurationMs,
    isPlaying,
    getSpeed,
    applyPlay,
    applyPause,
    applySeek,
    applySpeed,
    setWatchPartyGuest,
    setWatchPartyHooks,
    video
  }
})()
