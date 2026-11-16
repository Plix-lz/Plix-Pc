const watchPartyClient = (() => {
  const CODE_ALPHABET = WatchPartyConfig.CODE_ALPHABET
  const MAX_CODE_ATTEMPTS = 8

  function str(value, fallback = '') {
    if (value == null) return fallback
    const text = String(value)
    return text || fallback
  }

  function bool(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback
  }

  function num(value, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  function emptyToNull(value) {
    return value ? value : null
  }

  function normalizeCode(raw) {
    if (!raw) return ''
    const cleaned = String(raw).trim().toUpperCase().replace(/\s+/g, '')
    if (/^[A-Z0-9]{4}$/.test(cleaned)) return `LZ-${cleaned}`
    return cleaned
  }

  function docIdForCode(roomCode) {
    return cloud.sanitizeUsername(`cine-${normalizeCode(roomCode)}`)
  }

  function pinFromCode(roomCode) {
    const code = normalizeCode(roomCode)
    return code.startsWith('LZ-') ? code.slice(3) : code
  }

  function generateRoomCode() {
    let code = 'LZ-'
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    }
    return code
  }

  function resolveUpdatedAt(data) {
    const serverTime = data.serverTime
    if (serverTime?.toMillis) return serverTime.toMillis()
    if (serverTime?.seconds != null) return serverTime.seconds * 1000
    return num(data.updatedAtMs, Date.now())
  }

  function parseRoom(roomId, data) {
    if (!data) return null
    let hostId = str(data.hostId)
    if (!hostId) hostId = str(data.uid)
    let hostName = str(data.hostName)
    if (!hostName) hostName = str(data.username)
    const room = {
      roomId,
      roomCode: str(data.roomCode),
      hostId,
      hostName,
      active: bool(data.isActive, true),
      controlMode: str(data.controlMode, WatchPartyConfig.CONTROL_HOST_ONLY),
      contentId: num(data.contentId),
      contentType: emptyToNull(str(data.contentType)),
      contentTitle: emptyToNull(str(data.contentTitle)),
      posterUrl: emptyToNull(str(data.posterUrl)),
      season: num(data.season),
      episode: num(data.episode),
      preferredServerName: emptyToNull(str(data.preferredServerName)),
      preferredServerLanguage: emptyToNull(str(data.preferredServerLanguage)),
      preferredServerUrl: emptyToNull(str(data.preferredServerUrl)),
      playbackState: str(data.playbackState, WatchPartyConfig.STATE_PAUSED),
      positionMs: num(data.positionMs),
      durationMs: num(data.durationMs),
      playbackSpeed: num(data.playbackSpeed, 1) || 1,
      updatedAtMs: resolveUpdatedAt(data),
      updatedByUid: str(data.updatedByUid),
      seq: num(data.seq),
      participantCount: num(data.participantCount, 1),
      createdAtMs: num(data.createdAtMs, num(data.createdAt)),
      syncEpoch: Math.max(0, num(data.syncEpoch))
    }
    room.hasContent = () => room.contentId > 0 && Boolean(room.contentType)
    room.hasPreferredServer = () => Boolean(room.preferredServerName || room.preferredServerUrl)
    room.isReadyForGuests = () => room.hasContent() && room.hasPreferredServer()
    room.isPlaying = () => room.playbackState === WatchPartyConfig.STATE_PLAYING
    room.isHostOnly = () => room.controlMode !== WatchPartyConfig.CONTROL_EVERYONE
    return room
  }

  async function roomRef(roomId) {
    const { db } = await cloud.ensureFirebase()
    return db.collection(WatchPartyConfig.ROOMS_COLLECTION).doc(roomId)
  }

  async function createRoomAttempt(hostId, hostName, attempt) {
    if (attempt >= MAX_CODE_ATTEMPTS) throw new Error('No se pudo generar un código libre.')
    const roomCode = generateRoomCode()
    const roomId = docIdForCode(roomCode)
    const ref = await roomRef(roomId)
    const existing = await ref.get()
    if (existing.exists) {
      const data = existing.data() || {}
      if (data.isActive && data.isWatchParty) {
        return createRoomAttempt(hostId, hostName, attempt + 1)
      }
    }

    const now = Date.now()
    const room = {
      uid: hostId,
      sanitizedUsername: roomId,
      username: hostName || 'CineVirtual',
      createdAt: now,
      isWatchParty: true,
      roomId,
      roomCode,
      hostId,
      hostName: hostName || '',
      isActive: true,
      controlMode: WatchPartyConfig.CONTROL_HOST_ONLY,
      contentId: 0,
      contentType: '',
      contentTitle: '',
      posterUrl: '',
      season: 0,
      episode: 0,
      preferredServerName: '',
      preferredServerLanguage: '',
      preferredServerUrl: '',
      playbackState: WatchPartyConfig.STATE_PAUSED,
      positionMs: 0,
      durationMs: 0,
      playbackSpeed: 1,
      updatedAtMs: now,
      updatedByUid: hostId,
      seq: 0,
      syncEpoch: 0,
      participantCount: 1,
      createdAtMs: now,
      serverTime: firebase.firestore.FieldValue.serverTimestamp()
    }
    await ref.set(room)
    return parseRoom(roomId, room)
  }

  async function createRoom(hostId, hostName) {
    return createRoomAttempt(hostId, hostName, 0)
  }

  async function closeRoom(roomId, hostId) {
    if (!roomId) return
    const updates = {
      isActive: false,
      roomCode: '',
      playbackState: WatchPartyConfig.STATE_PAUSED,
      updatedAtMs: Date.now(),
      closedAtMs: Date.now(),
      serverTime: firebase.firestore.FieldValue.serverTimestamp()
    }
    if (hostId) updates.updatedByUid = hostId
    await (await roomRef(roomId)).update(updates)
  }

  async function transferHost(roomId, previousHostId, newHostId, newHostName) {
    if (!roomId || !newHostId) return
    const name = newHostName || 'Anfitrión'
    await (await roomRef(roomId)).update({
      hostId: newHostId,
      hostName: name,
      uid: newHostId,
      username: name,
      updatedAtMs: Date.now(),
      updatedByUid: previousHostId || newHostId,
      serverTime: firebase.firestore.FieldValue.serverTimestamp()
    })
  }

  async function handleHostLeave(roomId, leavingHostId, leavingHostName, roomCode) {
    if (!roomId || !leavingHostId) return
    await watchPartyPresence.markOffline(roomId, leavingHostId)
    const others = await watchPartyPresence.listActiveParticipants(roomId, leavingHostId)
    if (!others.length) {
      await closeRoom(roomId, leavingHostId)
    } else {
      await transferHost(roomId, leavingHostId, others[0].uid, others[0].displayName)
    }
    await watchPartyChat.sendHostLeftNotice(roomId, roomCode, leavingHostId, leavingHostName)
  }

  async function getRoom(roomId) {
    const snap = await (await roomRef(roomId)).get()
    if (!snap.exists) throw new Error('Sala no disponible')
    const data = snap.data() || {}
    if (!data.isWatchParty) throw new Error('Sala no disponible')
    if (data.isActive === false) throw new Error('Sala no disponible')
    return parseRoom(roomId, data)
  }

  async function joinRoom(rawCode) {
    const code = normalizeCode(rawCode)
    if (!code) throw new Error('Código vacío')
    return getRoom(docIdForCode(code))
  }

  async function setContent(roomId, contentId, contentType, contentTitle, posterUrl, season, episode, hostId) {
    await (await roomRef(roomId)).update({
      contentId,
      contentType,
      contentTitle: contentTitle || '',
      posterUrl: posterUrl || '',
      season: Math.max(0, season || 0),
      episode: Math.max(0, episode || 0),
      preferredServerName: '',
      preferredServerLanguage: '',
      preferredServerUrl: '',
      playbackState: WatchPartyConfig.STATE_PAUSED,
      positionMs: 0,
      durationMs: 0,
      playbackSpeed: 1,
      updatedAtMs: Date.now(),
      updatedByUid: hostId,
      seq: firebase.firestore.FieldValue.increment(1),
      serverTime: firebase.firestore.FieldValue.serverTimestamp()
    })
  }

  async function setPreferredServer(roomId, serverName, serverLanguage, serverUrl, hostId) {
    await (await roomRef(roomId)).update({
      preferredServerName: serverName || '',
      preferredServerLanguage: serverLanguage || '',
      preferredServerUrl: serverUrl || '',
      updatedAtMs: Date.now(),
      updatedByUid: hostId,
      seq: firebase.firestore.FieldValue.increment(1),
      serverTime: firebase.firestore.FieldValue.serverTimestamp()
    })
  }

  async function publishPlayback(roomId, uid, state, positionMs, durationMs, speed, syncEpoch) {
    await (await roomRef(roomId)).update({
      playbackState: state,
      positionMs: Math.max(0, positionMs || 0),
      durationMs: Math.max(0, durationMs || 0),
      playbackSpeed: speed > 0 ? speed : 1,
      syncEpoch: Math.max(0, syncEpoch || 0),
      updatedAtMs: Date.now(),
      updatedByUid: uid,
      seq: firebase.firestore.FieldValue.increment(1),
      serverTime: firebase.firestore.FieldValue.serverTimestamp()
    })
  }

  function listenRoom(roomId, { onRoom, onError }) {
    let unsub = () => {}
    cloud.ensureFirebase().then(({ db }) => {
      unsub = db.collection(WatchPartyConfig.ROOMS_COLLECTION).doc(roomId).onSnapshot(
        snapshot => {
          if (!snapshot.exists) {
            onError?.('La sala ya no existe')
            return
          }
          const data = snapshot.data() || {}
          if (!data.isWatchParty) {
            onError?.('Código inválido')
            return
          }
          onRoom?.(parseRoom(roomId, data))
        },
        error => onError?.(error.message || 'Error de sincronización')
      )
    }).catch(error => onError?.(error.message || 'Error de sincronización'))
    return () => unsub()
  }

  return {
    normalizeCode,
    docIdForCode,
    pinFromCode,
    generateRoomCode,
    parseRoom,
    createRoom,
    closeRoom,
    transferHost,
    handleHostLeave,
    getRoom,
    joinRoom,
    setContent,
    setPreferredServer,
    publishPlayback,
    listenRoom
  }
})()
