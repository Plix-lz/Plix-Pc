const watchPartyChat = (() => {
  const FLAG = 'isWatchPartyMessage'
  const CHAT_ROOM_FIELD = 'chatRoomId'
  const MAX_VOICE_BYTES = 500_000

  const TYPE = Object.freeze({
    TEXT: 'text',
    VOICE: 'voice',
    STICKER: 'sticker',
    JOIN: 'system_join',
    LEAVE: 'system_leave',
    HOST_LEFT: 'system_host_left'
  })

  function messageId() {
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    return cloud.sanitizeUsername(`cmsg-${hex}`)
  }

  async function writeMessage(roomId, roomCode, uid, displayName, type, text, voiceBase64, voiceDurationMs) {
    const id = messageId()
    const now = Date.now()
    const { db } = await cloud.ensureFirebase()
    await db.collection(WatchPartyConfig.ROOMS_COLLECTION).doc(id).set({
      uid,
      sanitizedUsername: id,
      username: displayName || 'Usuario',
      createdAt: now,
      [FLAG]: true,
      [CHAT_ROOM_FIELD]: roomId,
      roomId,
      roomCode: roomCode || '',
      displayName: displayName || 'Usuario',
      type,
      text: text || '',
      voiceBase64: voiceBase64 || '',
      voiceDurationMs: voiceDurationMs || 0,
      createdAtMs: now
    })
  }

  async function sendText(roomId, roomCode, uid, displayName, text) {
    const trimmed = String(text || '').trim()
    if (!trimmed) throw new Error('Mensaje vacío')
    return writeMessage(roomId, roomCode, uid, displayName, TYPE.TEXT, trimmed, null, 0)
  }

  async function sendSticker(roomId, roomCode, uid, displayName, stickerKey) {
    const key = String(stickerKey || '').trim()
    if (!key) throw new Error('Sticker inválido')
    return writeMessage(roomId, roomCode, uid, displayName, TYPE.STICKER, key, null, 0)
  }

  async function sendVoice(roomId, roomCode, uid, displayName, audioBytes, durationMs) {
    if (!audioBytes?.length) throw new Error('Audio vacío')
    if (audioBytes.length > MAX_VOICE_BYTES) throw new Error('La nota de voz es demasiado larga')
    let binary = ''
    const bytes = audioBytes instanceof Uint8Array ? audioBytes : new Uint8Array(audioBytes)
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    const encoded = btoa(binary)
    return writeMessage(roomId, roomCode, uid, displayName, TYPE.VOICE, '', encoded, Math.max(0, durationMs || 0))
  }

  async function sendPresenceEvent(roomId, roomCode, uid, displayName, joined) {
    const name = displayName || 'Alguien'
    const type = joined ? TYPE.JOIN : TYPE.LEAVE
    const text = joined ? `${name} se unió a la sala` : `${name} salió de la sala`
    return writeMessage(roomId, roomCode, uid, displayName, type, text, null, 0)
  }

  async function sendHostLeftNotice(roomId, roomCode, uid, displayName) {
    return writeMessage(
      roomId,
      roomCode,
      uid,
      displayName,
      TYPE.HOST_LEFT,
      'El anfitrión ha salido de la sala',
      null,
      0
    )
  }

  function parse(id, data) {
    if (!data || !data[FLAG]) return null
    return {
      messageId: id,
      roomId: String(data[CHAT_ROOM_FIELD] || data.roomId || ''),
      roomCode: String(data.roomCode || ''),
      uid: String(data.uid || ''),
      displayName: String(data.displayName || data.username || 'Usuario'),
      type: String(data.type || TYPE.TEXT),
      text: data.text || null,
      voiceBase64: data.voiceBase64 || null,
      voiceDurationMs: Number(data.voiceDurationMs) || 0,
      createdAtMs: Number(data.createdAtMs) || Number(data.createdAt) || 0
    }
  }

  function listen(roomId, { onMessages, onError }) {
    let unsub = () => {}
    cloud.ensureFirebase().then(({ db }) => {
      unsub = db.collection(WatchPartyConfig.ROOMS_COLLECTION)
        .where(CHAT_ROOM_FIELD, '==', roomId)
        .onSnapshot(
          snapshot => {
            const messages = []
            snapshot.forEach(doc => {
              const message = parse(doc.id, doc.data())
              if (message) messages.push(message)
            })
            messages.sort((a, b) => a.createdAtMs - b.createdAtMs)
            const added = []
            snapshot.docChanges().forEach(change => {
              if (change.type !== 'added') return
              const message = parse(change.doc.id, change.doc.data())
              if (message) added.push(message)
            })
            onMessages?.(messages, added)
          },
          error => onError?.(error.message || 'Error de chat')
        )
    }).catch(error => onError?.(error.message || 'Error de chat'))
    return () => unsub()
  }

  return {
    TYPE,
    sendText,
    sendSticker,
    sendVoice,
    sendPresenceEvent,
    sendHostLeftNotice,
    listen
  }
})()
