const watchPartyUi = (() => {
  const DEFAULT_STICKERS = ['🍿', '🔥', '😂', '😱', '❤️', '👏', '👀', '🎉', '😴', '🤯']

  function stickerList() {
    const selected = typeof salaVirtual !== 'undefined' ? salaVirtual.selectedStickers?.() : null
    return selected?.length ? selected : DEFAULT_STICKERS
  }

  const menuDialog = document.querySelector('#watch-party-menu')
  const createDialog = document.querySelector('#watch-party-create-dialog')
  const joinDialog = document.querySelector('#watch-party-join-dialog')
  const waitingDialog = document.querySelector('#watch-party-waiting')
  const createCodeEl = document.querySelector('#watch-party-create-code')
  const createStatusEl = document.querySelector('#watch-party-create-status')
  const joinInput = document.querySelector('#watch-party-join-code')
  const joinError = document.querySelector('#watch-party-join-error')
  const waitingText = document.querySelector('#watch-party-waiting-text')
  const waitingStatus = document.querySelector('#watch-party-waiting-status')
  const chatRoot = document.querySelector('#watch-party-chat')
  const chatMessages = document.querySelector('#watch-party-chat-messages')
  const chatCount = document.querySelector('#watch-party-chat-count')
  const chatInput = document.querySelector('#watch-party-chat-input')
  const chatForm = document.querySelector('#watch-party-chat-form')
  const chatStickers = document.querySelector('#watch-party-chat-stickers')
  const chatToggle = document.querySelector('#watch-party-chat-toggle')
  const chatClose = document.querySelector('#watch-party-chat-close')
  const chatVoice = document.querySelector('#watch-party-chat-voice')
  const badge = document.querySelector('#watch-party-badge')
  const watchRoot = document.querySelector('#watch')

  let callbacks = {
    onHostReady: null,
    onGuestReady: null
  }
  let pendingCreate = null
  let pendingHostRoom = null
  let stopWaiting = null
  let stopChat = null
  let stopPresence = null
  let presenceHeartbeat = null
  let chatSession = null
  let mediaRecorder = null
  let voiceChunks = []
  let voiceStartedAt = 0

  function closeDialog(dialog) {
    if (dialog?.open) dialog.close()
  }

  function showError(el, message) {
    if (!el) return
    el.hidden = !message
    el.textContent = message || ''
  }

  async function authIdentity() {
    const state = cloud.state()
    return cloud.ensureWatchPartyAuth(state.username || '')
  }

  function showMenu(options = {}) {
    callbacks.onHostReady = options.onHostReady || null
    callbacks.onGuestReady = options.onGuestReady || null
    pendingCreate = options.prefilled
      ? {
          movie: options.prefilled,
          season: options.season || 0,
          episode: options.episode || 0
        }
      : null
    menuDialog?.showModal()
  }

  function showCreateForContent(movie, season = 0, episode = 0, onHostReady) {
    callbacks.onHostReady = onHostReady || null
    callbacks.onGuestReady = null
    pendingCreate = { movie, season, episode }
    startCreate()
  }

  function showJoinOnly(onGuestReady) {
    callbacks.onGuestReady = onGuestReady || null
    callbacks.onHostReady = null
    joinDialog?.showModal()
    if (joinInput) {
      joinInput.value = ''
      joinInput.focus()
    }
    showError(joinError, '')
  }

  async function startCreate() {
    closeDialog(menuDialog)
    createStatusEl.textContent = 'Creando sala…'
    createCodeEl.textContent = '····'
    createDialog?.showModal()
    try {
      const { uid, displayName } = await authIdentity()
      const room = await watchPartyClient.createRoom(uid, displayName)
      const pin = watchPartyClient.pinFromCode(room.roomCode)
      createCodeEl.textContent = pin
      createStatusEl.textContent = `Código completo: ${room.roomCode}`
      createDialog.dataset.roomId = room.roomId
      createDialog.dataset.roomCode = room.roomCode
      createDialog.dataset.uid = uid
      createDialog.dataset.displayName = displayName
      if (pendingCreate?.movie) {
        const continueBtn = document.querySelector('#watch-party-continue-content')
        if (continueBtn) continueBtn.textContent = 'Continuar con este título'
      }
    } catch (error) {
      createStatusEl.textContent = error.message || 'No se pudo crear la sala'
    }
  }

  async function continueCreatedRoom() {
    const roomId = createDialog?.dataset.roomId
    const roomCode = createDialog?.dataset.roomCode
    const uid = createDialog?.dataset.uid
    const displayName = createDialog?.dataset.displayName
    if (!roomId || !uid) return

    const movie = pendingCreate?.movie
    if (!movie) {
      pendingHostRoom = { roomId, roomCode, uid, displayName }
      closeDialog(createDialog)
      callbacks.onHostReady?.({
        roomId,
        roomCode,
        uid,
        displayName,
        isHost: true,
        needsContent: true
      })
      return
    }

    try {
      await bindContentToRoom({
        roomId,
        roomCode,
        uid,
        displayName,
        movie,
        season: pendingCreate?.season || 0,
        episode: pendingCreate?.episode || 0
      })
      closeDialog(createDialog)
    } catch (error) {
      createStatusEl.textContent = error.message || 'No se pudo guardar el título'
    }
  }

  async function bindContentToRoom({ roomId, roomCode, uid, displayName, movie, season = 0, episode = 0 }) {
    const contentType = movie.type === 'tv' || movie.type === 'series'
      ? WatchPartyConfig.TYPE_SERIES
      : WatchPartyConfig.TYPE_MOVIE
    const poster = movie.poster
      ? (typeof api !== 'undefined' && api.imageUrl ? api.imageUrl(movie.poster, 'medium') : movie.poster)
      : ''
    await watchPartyClient.setContent(
      roomId,
      Number(movie.id),
      contentType,
      movie.title || '',
      poster,
      season,
      episode,
      uid
    )
    pendingHostRoom = null
    callbacks.onHostReady?.({
      roomId,
      roomCode,
      uid,
      displayName,
      isHost: true,
      movie,
      season,
      episode
    })
  }

  async function continuePendingHostWithContent(movie, season = 0, episode = 0, onHostReady) {
    if (!pendingHostRoom || !movie) return false
    if (onHostReady) callbacks.onHostReady = onHostReady
    const session = { ...pendingHostRoom, movie, season, episode }
    await bindContentToRoom(session)
    return true
  }

  function takePendingHostRoom() {
    const room = pendingHostRoom
    pendingHostRoom = null
    return room
  }

  async function submitJoin() {
    showError(joinError, '')
    try {
      const { uid, displayName } = await authIdentity()
      const room = await watchPartyClient.joinRoom(joinInput?.value || '')
      closeDialog(joinDialog)
      if (!room.isReadyForGuests()) {
        waitForHostReady(room, uid, displayName)
        return
      }
      callbacks.onGuestReady?.({
        room,
        uid,
        displayName,
        isHost: false
      })
    } catch (error) {
      showError(joinError, error.message || 'Sala no disponible')
    }
  }

  function waitForHostReady(room, uid, displayName) {
    stopWaiting?.()
    waitingText.textContent = room.hasContent()
      ? 'Esperando a que el anfitrión elija el servidor…'
      : 'Esperando a que el anfitrión elija el contenido…'
    waitingStatus.textContent = `Sala ${room.roomCode || ''}`
    waitingDialog?.showModal()

    stopWaiting = watchPartyClient.listenRoom(room.roomId, {
      onRoom(next) {
        if (!next.active) {
          waitingStatus.textContent = 'La sala ya no está disponible'
          return
        }
        if (!next.hasContent()) {
          waitingText.textContent = 'Esperando a que el anfitrión elija el contenido…'
          return
        }
        if (!next.hasPreferredServer()) {
          waitingText.textContent = 'Esperando a que el anfitrión elija el servidor…'
          return
        }
        waitingText.textContent = 'El anfitrión ya está reproduciendo. Entrando…'
        stopWaiting?.()
        stopWaiting = null
        closeDialog(waitingDialog)
        callbacks.onGuestReady?.({
          room: next,
          uid,
          displayName,
          isHost: false
        })
      },
      onError(message) {
        waitingStatus.textContent = message
      }
    })
  }

  function copyCreatedCode() {
    const pin = createCodeEl?.textContent?.trim()
    if (!pin) return
    navigator.clipboard?.writeText(pin).then(() => {
      createStatusEl.textContent = 'Código copiado'
    }).catch(() => {
      createStatusEl.textContent = `Código: ${pin}`
    })
  }

  function attachChat(session) {
    detachChat()
    chatSession = session
    if (!watchRoot) return
    watchRoot.dataset.watchParty = '1'
    watchRoot.classList.toggle('watch--party-guest', !session.isHost)
    if (badge) {
      badge.hidden = false
      badge.textContent = watchPartyClient.pinFromCode(session.roomCode)
      badge.title = `Copiar ${session.roomCode}`
    }
    if (chatToggle) chatToggle.hidden = false

    if (chatStickers) {
      chatStickers.replaceChildren(...stickerList().map(sticker => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'watch-party-chat__sticker'
        button.textContent = sticker
        button.addEventListener('click', () => sendSticker(sticker))
        return button
      }))
    }

    stopChat = watchPartyChat.listen(session.roomId, {
      onMessages(messages) {
        renderMessages(messages, session.uid)
      },
      onError(message) {
        console.warn('chat:', message)
      }
    })

    stopPresence = watchPartyPresence.listenParticipants(session.roomId, {
      onParticipants(list) {
        if (chatCount) chatCount.textContent = `${list.length} activos`
      },
      onError() {}
    })

    presenceHeartbeat = setInterval(() => {
      watchPartyPresence.heartbeat(session.roomId, session.uid, session.displayName).catch(() => {})
    }, WatchPartyConfig.PRESENCE_HEARTBEAT_MS)

    watchPartyPresence.markOnline(session.roomId, session.uid, session.displayName, session.isHost)
      .then(() => watchPartyChat.sendPresenceEvent(session.roomId, session.roomCode, session.uid, session.displayName, true))
      .catch(error => console.warn('presence:', error))
  }

  function detachChat() {
    stopChat?.()
    stopChat = null
    stopPresence?.()
    stopPresence = null
    if (presenceHeartbeat) {
      clearInterval(presenceHeartbeat)
      presenceHeartbeat = null
    }
    chatSession = null
    if (watchRoot) {
      delete watchRoot.dataset.watchParty
      watchRoot.classList.remove('watch--party-guest')
    }
    if (badge) badge.hidden = true
    if (chatToggle) chatToggle.hidden = true
    chatRoot?.classList.remove('is-open')
    if (chatRoot) chatRoot.hidden = true
    if (chatMessages) chatMessages.replaceChildren()
  }

  function renderMessages(messages, uid) {
    if (!chatMessages) return
    chatMessages.replaceChildren(...messages.map(message => {
      const item = document.createElement('div')
      const system = String(message.type || '').startsWith('system_')
      item.className = `watch-party-chat__item${system ? ' watch-party-chat__item--system' : ''}${message.uid === uid ? ' watch-party-chat__item--mine' : ''}`
      if (!system) {
        const name = document.createElement('span')
        name.className = 'watch-party-chat__name'
        name.textContent = message.displayName
        item.append(name)
      }
      const bubble = document.createElement('div')
      bubble.className = 'watch-party-chat__bubble'
      if (message.type === watchPartyChat.TYPE.STICKER) {
        bubble.textContent = message.text || ''
        bubble.style.fontSize = '1.6rem'
      } else if (message.type === watchPartyChat.TYPE.VOICE && message.voiceBase64) {
        const audio = document.createElement('audio')
        audio.controls = true
        audio.src = `data:audio/webm;base64,${message.voiceBase64}`
        bubble.append(audio)
      } else {
        bubble.textContent = message.text || ''
      }
      item.append(bubble)
      return item
    }))
    chatMessages.scrollTop = chatMessages.scrollHeight
  }

  async function sendText(event) {
    event?.preventDefault?.()
    if (!chatSession) return
    const text = chatInput?.value?.trim()
    if (!text) return
    chatInput.value = ''
    try {
      await watchPartyChat.sendText(
        chatSession.roomId,
        chatSession.roomCode,
        chatSession.uid,
        chatSession.displayName,
        text
      )
    } catch (error) {
      console.warn(error)
    }
  }

  async function sendSticker(sticker) {
    if (!chatSession) return
    try {
      await watchPartyChat.sendSticker(
        chatSession.roomId,
        chatSession.roomCode,
        chatSession.uid,
        chatSession.displayName,
        sticker
      )
    } catch (error) {
      console.warn(error)
    }
  }

  function toggleChat(open) {
    if (!chatRoot) return
    const next = open ?? !chatRoot.classList.contains('is-open')
    chatRoot.hidden = !next
    chatRoot.classList.toggle('is-open', next)
    chatToggle?.setAttribute('aria-expanded', String(next))
    if (next) chatInput?.focus()
  }

  async function startVoice() {
    if (!chatSession || mediaRecorder) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      voiceChunks = []
      voiceStartedAt = Date.now()
      mediaRecorder = new MediaRecorder(stream)
      mediaRecorder.ondataavailable = event => {
        if (event.data.size) voiceChunks.push(event.data)
      }
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop())
        chatVoice?.classList.remove('is-recording')
        const blob = new Blob(voiceChunks, { type: 'audio/webm' })
        const buffer = new Uint8Array(await blob.arrayBuffer())
        const durationMs = Date.now() - voiceStartedAt
        mediaRecorder = null
        if (!buffer.length || durationMs < 400) return
        try {
          await watchPartyChat.sendVoice(
            chatSession.roomId,
            chatSession.roomCode,
            chatSession.uid,
            chatSession.displayName,
            buffer,
            Math.min(durationMs, 30_000)
          )
        } catch (error) {
          console.warn(error)
        }
      }
      mediaRecorder.start()
      chatVoice?.classList.add('is-recording')
      setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop()
      }, 30_000)
    } catch (error) {
      console.warn('Micrófono no disponible:', error)
    }
  }

  function stopVoice() {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop()
  }

  document.querySelector('#watch-party-create')?.addEventListener('click', startCreate)
  document.querySelector('#watch-party-join')?.addEventListener('click', () => {
    closeDialog(menuDialog)
    showJoinOnly(callbacks.onGuestReady)
  })
  document.querySelector('#watch-party-continue-content')?.addEventListener('click', continueCreatedRoom)
  document.querySelector('#watch-party-copy-code')?.addEventListener('click', copyCreatedCode)
  document.querySelector('#watch-party-join-submit')?.addEventListener('click', submitJoin)
  joinInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter') submitJoin()
  })
  chatForm?.addEventListener('submit', sendText)
  chatToggle?.addEventListener('click', () => toggleChat())
  chatClose?.addEventListener('click', () => toggleChat(false))
  badge?.addEventListener('click', () => {
    const code = badge.textContent?.trim()
    if (code) navigator.clipboard?.writeText(code).catch(() => {})
  })
  chatVoice?.addEventListener('pointerdown', startVoice)
  chatVoice?.addEventListener('pointerup', stopVoice)
  chatVoice?.addEventListener('pointerleave', stopVoice)

  waitingDialog?.addEventListener('close', () => {
    stopWaiting?.()
    stopWaiting = null
  })

  return {
    showMenu,
    showCreateForContent,
    showJoinOnly,
    continuePendingHostWithContent,
    takePendingHostRoom,
    attachChat,
    detachChat,
    toggleChat
  }
})()
