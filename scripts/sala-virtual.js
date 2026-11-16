const salaVirtual = (() => {
  const STICKERS_KEY = 'plix_sala_virtual_stickers'
  const STICKER_OPTIONS = ['🍿', '🔥', '😂', '😱', '❤️', '👏', '👀', '🎉', '😴', '🤯', '🎬', '✨', '😭', '🫡', '🫶']
  const MAX_STICKERS = 8

  const screen = document.querySelector('#sala-virtual')
  const profileCard = document.querySelector('#sala-profile-card')
  const usernameEl = document.querySelector('.sala-virtual__username')
  const userIdEl = document.querySelector('.sala-virtual__user-id')
  const friendsCountEl = document.querySelector('.sala-virtual__friends-count')
  const bioEl = document.querySelector('.sala-virtual__bio')
  const avatarEl = document.querySelector('.sala-virtual__avatar')
  const myIdEl = document.querySelector('#sala-my-id')
  const stickersSubtitle = document.querySelector('#sala-stickers-subtitle')
  const requestsBadge = document.querySelector('#sala-requests-badge')
  const friendsEmpty = document.querySelector('#sala-friends-empty')
  const friendsList = document.querySelector('#sala-friends-list')
  const recentsEmpty = document.querySelector('#sala-recents-empty')
  const recentsList = document.querySelector('#sala-recents-list')
  const searchDialog = document.querySelector('#sala-friend-search')
  const searchInput = document.querySelector('#sala-friend-search-input')
  const searchError = document.querySelector('#sala-friend-search-error')
  const searchResult = document.querySelector('#sala-friend-search-result')
  const requestsDialog = document.querySelector('#sala-friend-requests')
  const requestsEmpty = document.querySelector('#sala-friend-requests-empty')
  const requestsList = document.querySelector('#sala-friend-requests-list')
  const stickersDialog = document.querySelector('#sala-stickers-dialog')
  const stickerGrid = document.querySelector('#sala-sticker-grid')

  let onOpenDetail = null
  let onJoinRoom = null
  let onEditAvatar = null
  let onEditBackdrop = null
  let onEditBio = null
  let lastSearchProfile = null

  function readStickers() {
    try {
      const data = JSON.parse(localStorage.getItem(STICKERS_KEY) || '[]')
      return Array.isArray(data) ? data.filter(Boolean).slice(0, MAX_STICKERS) : []
    } catch {
      return []
    }
  }

  function writeStickers(list) {
    localStorage.setItem(STICKERS_KEY, JSON.stringify(list.slice(0, MAX_STICKERS)))
  }

  function setImage(img, url) {
    if (!img) return
    if (url) {
      img.src = url
      img.hidden = false
    } else {
      img.removeAttribute('src')
    }
  }

  function bindBackdrop(url) {
    const box = profileCard?.querySelector('.profile-card__backdrop')
    if (!box || !profileCard) return
    const img = box.querySelector('img')
    const video = box.querySelector('video')
    box.hidden = !url
    profileCard.classList.toggle('profile-card--backdrop', Boolean(url))
    if (!url) {
      if (video) {
        video.pause()
        video.hidden = true
        video.removeAttribute('src')
      }
      if (img) img.removeAttribute('src')
      return
    }
    const isVideo = /\.(mp4|webm)(\?|$)/i.test(url)
    if (video && isVideo) {
      img?.removeAttribute('src')
      video.hidden = false
      video.src = url
      video.play().catch(() => {})
    } else {
      if (video) {
        video.pause()
        video.hidden = true
        video.removeAttribute('src')
      }
      setImage(img, url)
    }
  }

  function renderProfile(state = cloud.state()) {
    const signedIn = Boolean(state.signedIn)
    usernameEl.textContent = signedIn ? (state.username || '—') : 'Sin sesión'
    if (state.label) {
      userIdEl.hidden = false
      userIdEl.textContent = state.label
      myIdEl.textContent = `MI ID: ${state.label}`
    } else {
      userIdEl.hidden = true
      myIdEl.textContent = 'MI ID: —'
    }
    friendsCountEl.textContent = state.friendsCount == null ? '—' : String(state.friendsCount)
    bioEl.textContent = state.bio || cloud.BIO_DEFAULT
    setImage(avatarEl, profileCatalog.imageUrl('icon', state.icon))
    bindBackdrop(profileCatalog.imageUrl('backdrop', state.backdrop))
    const stickers = readStickers()
    stickersSubtitle.textContent = stickers.length
      ? `${stickers.length} de ${MAX_STICKERS} stickers`
      : 'Todavía no elegiste stickers'
  }

  function renderRecents() {
    const entries = salaVirtualRecents.list()
    if (!entries.length) {
      recentsEmpty.hidden = false
      recentsList.replaceChildren()
      return
    }
    recentsEmpty.hidden = true
    recentsList.replaceChildren(...entries.map(entry => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'sala-virtual__recent'
      const poster = document.createElement('img')
      poster.alt = ''
      if (entry.posterUrl) poster.src = entry.posterUrl
      const meta = document.createElement('div')
      meta.className = 'sala-virtual__recent-meta'
      const title = document.createElement('strong')
      title.className = 'sala-virtual__recent-title'
      title.textContent = entry.title || 'Título'
      const type = document.createElement('span')
      type.className = 'sala-virtual__recent-type'
      type.textContent = entry.contentType === 'series' || entry.type === 'tv' ? 'Serie' : 'Película'
      const date = document.createElement('span')
      date.className = 'sala-virtual__recent-date'
      if (entry.openedAt) {
        date.textContent = new Date(entry.openedAt).toLocaleString('es-ES', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
      }
      meta.append(title, type, date)
      button.append(poster, meta)
      button.addEventListener('click', () => {
        onOpenDetail?.(entry.id, entry.type === 'tv' || entry.contentType === 'series' ? 'tv' : 'movie')
      })
      return button
    }))
  }

  async function renderFriends() {
    if (!cloud.state().signedIn) {
      friendsEmpty.hidden = false
      friendsEmpty.textContent = 'Iniciá sesión para ver tus amigos.'
      friendsList.hidden = true
      friendsList.replaceChildren()
      return
    }
    try {
      const friends = await cloud.listFriends()
      if (!friends.length) {
        friendsEmpty.hidden = false
        friendsEmpty.textContent = 'Sin amigos.'
        friendsList.hidden = true
        friendsList.replaceChildren()
        return
      }
      friendsEmpty.hidden = true
      friendsList.hidden = false
      friendsList.replaceChildren(...friends.map(friend => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'sala-virtual__friend'
        const img = document.createElement('img')
        img.alt = friend.username || 'Amigo'
        img.loading = 'lazy'
        img.referrerPolicy = 'no-referrer'
        img.src = friend.avatarUrl || profileCatalog.DEFAULT_AVATAR
        img.addEventListener('error', () => {
          if (img.dataset.fallback === '1') return
          img.dataset.fallback = '1'
          img.src = profileCatalog.DEFAULT_AVATAR
        })
        const name = document.createElement('span')
        name.textContent = friend.username || friend.plixUserIdLabel || 'Amigo'
        button.append(img, name)
        button.title = friend.plixUserIdLabel || friend.username
        return button
      }))
    } catch (error) {
      friendsEmpty.hidden = false
      friendsEmpty.textContent = error.message || 'No se pudieron cargar los amigos'
      friendsList.hidden = true
    }
  }

  async function refreshRequestsBadge() {
    if (!cloud.state().signedIn) {
      requestsBadge.hidden = true
      return
    }
    try {
      const requests = await cloud.listIncomingFriendRequests()
      if (!requests.length) {
        requestsBadge.hidden = true
        return
      }
      requestsBadge.hidden = false
      requestsBadge.textContent = requests.length > 99 ? '99+' : String(requests.length)
    } catch {
      requestsBadge.hidden = true
    }
  }

  async function open() {
    if (!screen) return
    renderProfile()
    renderRecents()
    renderFriends()
    refreshRequestsBadge()
    screen.showModal()
    if (cloud.state().signedIn) cloud.refreshAccount().then(() => {
      renderProfile()
      refreshRequestsBadge()
    })
  }

  function close() {
    screen?.close()
  }

  function copyId() {
    const state = cloud.state()
    if (!state.label) {
      alert('MI ID: —')
      return
    }
    navigator.clipboard?.writeText(state.label).then(() => {
      myIdEl.textContent = 'ID copiado'
      setTimeout(() => { myIdEl.textContent = `MI ID: ${state.label}` }, 1200)
    }).catch(() => {
      myIdEl.textContent = `MI ID: ${state.label}`
    })
  }

  function openStickers() {
    const selected = new Set(readStickers())
    stickerGrid.replaceChildren(...STICKER_OPTIONS.map(sticker => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `sala-virtual__sticker${selected.has(sticker) ? ' is-selected' : ''}`
      button.textContent = sticker
      button.addEventListener('click', () => {
        if (selected.has(sticker)) selected.delete(sticker)
        else if (selected.size < MAX_STICKERS) selected.add(sticker)
        writeStickers([...selected])
        openStickers()
        renderProfile()
      })
      return button
    }))
    stickersDialog?.showModal()
  }

  async function openRequests() {
    requestsList.replaceChildren()
    requestsEmpty.hidden = false
    requestsEmpty.textContent = 'Cargando…'
    requestsDialog?.showModal()
    try {
      const requests = await cloud.listIncomingFriendRequests()
      if (!requests.length) {
        requestsEmpty.hidden = false
        requestsEmpty.textContent = 'No hay solicitudes pendientes.'
        return
      }
      requestsEmpty.hidden = true
      requestsList.replaceChildren(...requests.map(request => {
        const row = document.createElement('div')
        row.className = 'sala-virtual__request'
        const img = document.createElement('img')
        img.alt = request.fromUsername || 'Usuario'
        img.loading = 'lazy'
        img.referrerPolicy = 'no-referrer'
        img.src = request.fromAvatarUrl || profileCatalog.DEFAULT_AVATAR
        img.addEventListener('error', () => {
          if (img.dataset.fallback === '1') return
          img.dataset.fallback = '1'
          img.src = profileCatalog.DEFAULT_AVATAR
        })
        const meta = document.createElement('div')
        meta.className = 'sala-virtual__request-meta'
        const name = document.createElement('strong')
        name.textContent = request.fromUsername || 'Usuario'
        const id = document.createElement('span')
        id.textContent = request.fromPlixUserIdLabel
        meta.append(name, id)
        const accept = document.createElement('button')
        accept.type = 'button'
        accept.className = 'button button--primary'
        accept.textContent = 'Aceptar'
        accept.addEventListener('click', async () => {
          accept.disabled = true
          try {
            await cloud.acceptFriendRequest(request)
            openRequests()
            renderFriends()
            refreshRequestsBadge()
            renderProfile()
          } catch (error) {
            accept.disabled = false
            alert(error.message || 'No se pudo aceptar')
          }
        })
        row.append(img, meta, accept)
        return row
      }))
    } catch (error) {
      requestsEmpty.hidden = false
      requestsEmpty.textContent = error.message || 'No se pudieron cargar las solicitudes'
    }
  }

  function openFindFriends() {
    lastSearchProfile = null
    searchResult.hidden = true
    searchResult.replaceChildren()
    searchError.hidden = true
    if (searchInput) searchInput.value = ''
    searchDialog?.showModal()
    searchInput?.focus()
  }

  async function submitSearch() {
    searchError.hidden = true
    searchResult.hidden = true
    searchResult.replaceChildren()
    try {
      const profile = await cloud.findPublicProfileByPlixId(searchInput?.value || '')
      lastSearchProfile = profile
      searchResult.hidden = false
      const row = document.createElement('div')
      row.className = 'sala-virtual__person'
      const img = document.createElement('img')
      img.alt = profile.username || 'Usuario'
      img.loading = 'lazy'
      img.referrerPolicy = 'no-referrer'
      img.src = profile.avatarUrl || profileCatalog.DEFAULT_AVATAR
      img.addEventListener('error', () => {
        if (img.dataset.fallback === '1') return
        img.dataset.fallback = '1'
        img.src = profileCatalog.DEFAULT_AVATAR
      })
      const meta = document.createElement('div')
      meta.className = 'sala-virtual__person-meta'
      const name = document.createElement('strong')
      name.textContent = profile.username || 'Usuario'
      const id = document.createElement('span')
      id.textContent = profile.plixUserIdLabel
      meta.append(name, id)
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'button button--primary'
      add.textContent = 'Agregar'
      add.addEventListener('click', async () => {
        add.disabled = true
        try {
          const result = await cloud.sendFriendRequest(profile)
          add.textContent = result.acceptedExisting ? 'Amigos' : 'Enviada'
          refreshRequestsBadge()
          renderFriends()
          renderProfile()
        } catch (error) {
          add.disabled = false
          searchError.hidden = false
          searchError.textContent = error.message || 'No se pudo enviar'
        }
      })
      row.append(img, meta, add)
      searchResult.append(row)
    } catch (error) {
      searchError.hidden = false
      searchError.textContent = error.message || 'No se encontró'
    }
  }

  function configure(handlers = {}) {
    onOpenDetail = handlers.onOpenDetail || null
    onJoinRoom = handlers.onJoinRoom || null
    onEditAvatar = handlers.onEditAvatar || null
    onEditBackdrop = handlers.onEditBackdrop || null
    onEditBio = handlers.onEditBio || null
  }

  document.querySelector('#sala-copy-id')?.addEventListener('click', copyId)
  document.querySelector('#sala-join')?.addEventListener('click', () => {
    close()
    onJoinRoom?.()
  })
  document.querySelector('#sala-stickers')?.addEventListener('click', openStickers)
  document.querySelector('#sala-requests')?.addEventListener('click', openRequests)
  document.querySelector('#sala-find-friends')?.addEventListener('click', openFindFriends)
  document.querySelector('#sala-edit-avatar')?.addEventListener('click', () => onEditAvatar?.())
  document.querySelector('#sala-edit-backdrop')?.addEventListener('click', () => onEditBackdrop?.())
  document.querySelector('#sala-edit-bio')?.addEventListener('click', () => onEditBio?.())
  document.querySelector('#sala-friend-search-submit')?.addEventListener('click', submitSearch)
  searchInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter') submitSearch()
  })

  cloud.onChange(state => {
    if (screen?.open) {
      renderProfile(state)
      renderFriends()
      refreshRequestsBadge()
    }
  })

  return {
    open,
    close,
    configure,
    renderProfile,
    renderRecents,
    selectedStickers: readStickers
  }
})()
