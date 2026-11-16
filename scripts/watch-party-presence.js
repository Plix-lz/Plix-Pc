const watchPartyPresence = (() => {
  const FLAG = 'isWatchPartyPresence'
  const ROOM_FIELD = 'presenceRoomId'

  function presenceDocId(roomId, uid) {
    return cloud.sanitizeUsername(`cpres-${roomId}-${uid}`)
  }

  async function accounts() {
    const { db } = await cloud.ensureFirebase()
    return db.collection(WatchPartyConfig.ROOMS_COLLECTION)
  }

  function parseActive(data, cutoff) {
    if (!data || !data[FLAG] || !data.active) return null
    const lastSeenMs = Number(data.lastSeenMs) || 0
    if (lastSeenMs < cutoff) return null
    const uid = String(data.uid || '')
    if (!uid) return null
    const displayName = String(data.displayName || data.username || 'Usuario')
    const synced = Boolean(data.playbackSynced)
    const syncedEpoch = Number(data.syncedEpoch)
    return {
      uid,
      displayName,
      joinedAtMs: Number(data.joinedAtMs) || lastSeenMs,
      lastSeenMs,
      playbackSynced: synced,
      syncedEpoch: Number.isFinite(syncedEpoch) ? syncedEpoch : (synced ? 0 : -1)
    }
  }

  async function markOnline(roomId, uid, displayName, playbackSynced = false) {
    if (!roomId || !uid) throw new Error('Sala o usuario vacío')
    const col = await accounts()
    const docId = presenceDocId(roomId, uid)
    const ref = col.doc(docId)
    const snap = await ref.get()
    const now = Date.now()
    let joinedAtMs = now
    if (snap.exists) {
      const existing = Number(snap.data()?.joinedAtMs)
      if (existing > 0) joinedAtMs = existing
    }
    await ref.set({
      uid,
      sanitizedUsername: docId,
      username: displayName || 'Usuario',
      displayName: displayName || 'Usuario',
      createdAt: now,
      [FLAG]: true,
      [ROOM_FIELD]: roomId,
      active: true,
      lastSeenMs: now,
      joinedAtMs,
      playbackSynced: Boolean(playbackSynced),
      syncedEpoch: playbackSynced ? 0 : -1
    })
  }

  async function markSynced(roomId, uid, syncEpoch = 0) {
    if (!roomId || !uid) return
    const col = await accounts()
    const docId = presenceDocId(roomId, uid)
    const updates = {
      playbackSynced: true,
      syncedEpoch: Math.max(0, syncEpoch || 0),
      lastSeenMs: Date.now()
    }
    try {
      await col.doc(docId).update(updates)
    } catch {
      await markOnline(roomId, uid, 'Usuario', true)
      await col.doc(docId).update(updates)
    }
  }

  async function heartbeat(roomId, uid, displayName) {
    if (!roomId || !uid) return
    const col = await accounts()
    const docId = presenceDocId(roomId, uid)
    const updates = {
      active: true,
      lastSeenMs: Date.now()
    }
    if (displayName) {
      updates.displayName = displayName
      updates.username = displayName
    }
    try {
      await col.doc(docId).update(updates)
    } catch {
      await markOnline(roomId, uid, displayName, true)
    }
  }

  async function markOffline(roomId, uid) {
    if (!roomId || !uid) return
    const col = await accounts()
    try {
      await col.doc(presenceDocId(roomId, uid)).update({
        active: false,
        playbackSynced: false,
        syncedEpoch: -1,
        lastSeenMs: Date.now()
      })
    } catch { /* ignore */ }
  }

  async function listActiveParticipants(roomId, excludeUid = null) {
    if (!roomId) return []
    const col = await accounts()
    const snap = await col.where(ROOM_FIELD, '==', roomId).get()
    const cutoff = Date.now() - WatchPartyConfig.PRESENCE_STALE_MS
    const active = []
    snap.forEach(doc => {
      const participant = parseActive(doc.data(), cutoff)
      if (!participant) return
      if (excludeUid && participant.uid === excludeUid) return
      active.push(participant)
    })
    active.sort((a, b) => a.joinedAtMs - b.joinedAtMs)
    return active
  }

  function listenParticipants(roomId, { onParticipants, onError }) {
    let unsub = () => {}
    cloud.ensureFirebase().then(({ db }) => {
      unsub = db.collection(WatchPartyConfig.ROOMS_COLLECTION)
        .where(ROOM_FIELD, '==', roomId)
        .onSnapshot(
          snapshot => {
            const cutoff = Date.now() - WatchPartyConfig.PRESENCE_STALE_MS
            const active = []
            snapshot.forEach(doc => {
              const participant = parseActive(doc.data(), cutoff)
              if (participant) active.push(participant)
            })
            active.sort((a, b) => a.joinedAtMs - b.joinedAtMs)
            onParticipants?.(active)
          },
          error => onError?.(error.message || 'Error de presencia')
        )
    }).catch(error => onError?.(error.message || 'Error de presencia'))
    return () => unsub()
  }

  return {
    presenceDocId,
    markOnline,
    markSynced,
    heartbeat,
    markOffline,
    listActiveParticipants,
    listenParticipants
  }
})()
