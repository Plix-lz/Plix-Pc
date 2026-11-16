const watchPartyManager = (() => {
  let host = null
  let roomId = null
  let uid = null
  let isHost = false
  let attached = false
  let applyingRemote = false
  let lastAppliedSeq = -1
  let currentSyncEpoch = 0
  let lastPublishedPositionMs = -1
  let lastGuestAckedEpoch = -1
  let lastRoom = null
  let joinHoldActive = false
  let resumeAfterJoinHold = false
  let guestCatchUpPending = false
  let stopRoomListen = null
  let stopPresenceListen = null
  let heartbeatTimer = null
  let joinHoldTimer = null
  let applyingTimer = null

  function attach(playerHost, nextRoomId, nextUid, hostRole) {
    detach()
    host = playerHost
    roomId = nextRoomId
    uid = nextUid
    isHost = Boolean(hostRole)
    attached = true
    applyingRemote = false
    lastAppliedSeq = -1
    currentSyncEpoch = 0
    lastPublishedPositionMs = -1
    lastGuestAckedEpoch = -1
    joinHoldActive = false
    resumeAfterJoinHold = false
    guestCatchUpPending = false
    lastRoom = null

    stopRoomListen = watchPartyClient.listenRoom(roomId, {
      onRoom(room) {
        if (!attached || !host) return
        lastRoom = room
        if (isHost) currentSyncEpoch = Math.max(currentSyncEpoch, room.syncEpoch)
        host.onWatchPartyRoom?.(room)
        applyRemoteRoom(room)
      },
      onError(message) {
        host?.onWatchPartyError?.(message)
      }
    })

    if (isHost) {
      startHeartbeat()
      startPresenceWatch()
    }
  }

  function detach() {
    attached = false
    guestCatchUpPending = false
    clearJoinHold(false)
    stopHeartbeat()
    stopPresenceWatch()
    stopRoomListen?.()
    stopRoomListen = null
    host = null
    roomId = null
    uid = null
    lastRoom = null
  }

  function setHost(hostRole) {
    if (isHost === hostRole) return
    isHost = hostRole
    if (hostRole) {
      startHeartbeat()
      startPresenceWatch()
    } else {
      clearJoinHold(false)
      stopHeartbeat()
      stopPresenceWatch()
    }
  }

  function publishFromLocal(state) {
    if (!attached || !host || !roomId || !uid || applyingRemote) return
    if (joinHoldActive && state === WatchPartyConfig.STATE_PLAYING) return
    lastPublishedPositionMs = host.getPositionMs()
    watchPartyClient.publishPlayback(
      roomId,
      uid,
      state,
      host.getPositionMs(),
      host.getDurationMs(),
      host.getPlaybackSpeed(),
      currentSyncEpoch
    ).catch(error => console.warn('publishPlayback:', error))
  }

  function publishPlay() {
    publishFromLocal(WatchPartyConfig.STATE_PLAYING)
  }

  function publishPause() {
    publishFromLocal(WatchPartyConfig.STATE_PAUSED)
  }

  function publishSeek() {
    if (!attached || !host || !roomId || !uid || applyingRemote) return
    const positionMs = host.getPositionMs()
    const largeJump = lastPublishedPositionMs >= 0
      && Math.abs(positionMs - lastPublishedPositionMs) >= WatchPartyConfig.SYNC_HARD_MS
    lastPublishedPositionMs = positionMs

    if (isHost && largeJump) {
      currentSyncEpoch += 1
      beginSyncHold(true)
      watchPartyClient.publishPlayback(
        roomId,
        uid,
        WatchPartyConfig.STATE_PAUSED,
        positionMs,
        host.getDurationMs(),
        host.getPlaybackSpeed(),
        currentSyncEpoch
      ).catch(error => console.warn('publishSeek:', error))
      return
    }

    let state = host.isPlaying() ? WatchPartyConfig.STATE_PLAYING : WatchPartyConfig.STATE_PAUSED
    if (joinHoldActive) state = WatchPartyConfig.STATE_PAUSED
    watchPartyClient.publishPlayback(
      roomId,
      uid,
      state,
      positionMs,
      host.getDurationMs(),
      host.getPlaybackSpeed(),
      currentSyncEpoch
    ).catch(error => console.warn('publishSeek:', error))
  }

  function startPresenceWatch() {
    stopPresenceWatch()
    if (!roomId) return
    stopPresenceListen = watchPartyPresence.listenParticipants(roomId, {
      onParticipants: handleParticipantsForSyncHold,
      onError() { /* silent */ }
    })
  }

  function stopPresenceWatch() {
    stopPresenceListen?.()
    stopPresenceListen = null
    if (joinHoldTimer) {
      clearTimeout(joinHoldTimer)
      joinHoldTimer = null
    }
  }

  function handleParticipantsForSyncHold(participants) {
    if (!attached || !isHost || !host) return
    const epoch = Math.max(currentSyncEpoch, lastRoom?.syncEpoch || 0)
    let waitingForGuest = false
    for (const participant of participants) {
      if (!participant?.uid || participant.uid === uid) continue
      if (participant.syncedEpoch < epoch) {
        waitingForGuest = true
        break
      }
    }

    if (waitingForGuest) {
      const alreadyHolding = joinHoldActive
      beginSyncHold(false)
      if (!alreadyHolding && roomId && uid) {
        lastPublishedPositionMs = host.getPositionMs()
        watchPartyClient.publishPlayback(
          roomId,
          uid,
          WatchPartyConfig.STATE_PAUSED,
          host.getPositionMs(),
          host.getDurationMs(),
          host.getPlaybackSpeed(),
          currentSyncEpoch
        ).catch(() => {})
      }
    } else {
      endSyncHold()
    }
  }

  function beginSyncHold(bumpResumeFromPlaying) {
    if (!host) return
    if (!joinHoldActive) {
      joinHoldActive = true
      resumeAfterJoinHold = bumpResumeFromPlaying ? true : (resumeAfterJoinHold || host.isPlaying())
      host.onJoinSyncHoldChanged?.(true)
      runRemote(() => host.applyPause())
      if (joinHoldTimer) clearTimeout(joinHoldTimer)
      joinHoldTimer = setTimeout(endSyncHold, WatchPartyConfig.JOIN_SYNC_TIMEOUT_MS)
    } else if (bumpResumeFromPlaying) {
      resumeAfterJoinHold = true
      runRemote(() => host.applyPause())
    }
  }

  function endSyncHold() {
    clearJoinHold(true)
  }

  function clearJoinHold(mayResume) {
    if (joinHoldTimer) {
      clearTimeout(joinHoldTimer)
      joinHoldTimer = null
    }
    if (!joinHoldActive) return
    joinHoldActive = false
    const shouldResume = mayResume && resumeAfterJoinHold
    resumeAfterJoinHold = false
    host?.onJoinSyncHoldChanged?.(false)
    if (shouldResume && host && attached && isHost) {
      runRemote(() => host.applyPlay())
      lastPublishedPositionMs = host.getPositionMs()
      watchPartyClient.publishPlayback(
        roomId,
        uid,
        WatchPartyConfig.STATE_PLAYING,
        host.getPositionMs(),
        host.getDurationMs(),
        host.getPlaybackSpeed(),
        currentSyncEpoch
      ).catch(() => {})
    }
  }

  function applyRemoteRoom(room) {
    if (!host || !room) return

    if (isHost) {
      if (uid && uid === room.updatedByUid && room.seq <= lastAppliedSeq) {
        lastAppliedSeq = Math.max(lastAppliedSeq, room.seq)
        return
      }
      if (room.seq <= lastAppliedSeq) return
      if (uid && uid === room.updatedByUid) {
        lastAppliedSeq = room.seq
        return
      }
      lastAppliedSeq = room.seq
      return
    }

    if (room.syncEpoch > lastGuestAckedEpoch) {
      guestCatchUpPending = true
      applyGuestCatchUp(room)
      host.onGuestCatchUpRequired?.(room.syncEpoch)
      return
    }
    if (guestCatchUpPending) {
      applyGuestCatchUp(room)
      return
    }
    applyGuestMirror(room, false)
  }

  function applyGuestCatchUp(room) {
    if (!host || !room) return
    const now = Date.now()
    const target = room.playbackState === WatchPartyConfig.STATE_PLAYING
      ? PlaybackSyncEngine.expectedPositionMs(room, now)
      : Math.max(0, room.positionMs)
    lastAppliedSeq = Math.max(lastAppliedSeq, room.seq)
    runRemote(() => {
      host.applySeek(target)
      host.applyPause()
    })
  }

  function applyGuestMirror(room, forcePlayState) {
    if (!host || !room) return
    if (guestCatchUpPending) {
      applyGuestCatchUp(room)
      return
    }
    if (applyingRemote && !forcePlayState) return
    if (!forcePlayState && room.seq <= lastAppliedSeq) return
    lastAppliedSeq = Math.max(lastAppliedSeq, room.seq)

    const now = Date.now()
    const expected = PlaybackSyncEngine.expectedPositionMs(room, now)
    const drift = Math.abs(expected - host.getPositionMs())
    const targetSpeed = room.playbackSpeed > 0 ? room.playbackSpeed : 1
    const shouldPlay = room.playbackState === WatchPartyConfig.STATE_PLAYING
    const needSpeed = Math.abs(host.getPlaybackSpeed() - targetSpeed) > 0.01
    const needPlayPause = shouldPlay !== host.isPlaying() || forcePlayState
    let needSeek = shouldPlay
      ? drift >= WatchPartyConfig.SYNC_HARD_MS
      : drift >= WatchPartyConfig.SYNC_SOFT_MS
    if (forcePlayState && drift >= WatchPartyConfig.SYNC_SOFT_MS) needSeek = true

    if (!needSpeed && !needPlayPause && !needSeek) return

    runRemote(() => {
      if (needSpeed) host.applySpeed(targetSpeed)
      if (needSeek) host.applySeek(expected)
      if (needPlayPause) {
        if (shouldPlay) host.applyPlay()
        else host.applyPause()
      } else if (needSeek && shouldPlay) {
        host.applyPlay()
      }
    })
  }

  function runRemote(action) {
    applyingRemote = true
    try {
      action()
    } finally {
      if (applyingTimer) clearTimeout(applyingTimer)
      applyingTimer = setTimeout(() => { applyingRemote = false }, 500)
    }
  }

  function startHeartbeat() {
    stopHeartbeat()
    const tick = () => {
      if (!attached || !isHost || !host || !roomId) return
      if (host.isPlaying() && !applyingRemote && !joinHoldActive) {
        publishFromLocal(WatchPartyConfig.STATE_PLAYING)
      }
      heartbeatTimer = setTimeout(tick, WatchPartyConfig.HOST_HEARTBEAT_MS)
    }
    heartbeatTimer = setTimeout(tick, WatchPartyConfig.HOST_HEARTBEAT_MS)
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function startGuestCatchUp() {
    if (!attached || isHost || !host) return
    guestCatchUpPending = true
    if (lastRoom) applyGuestCatchUp(lastRoom)
  }

  function finishGuestCatchUp() {
    guestCatchUpPending = false
  }

  function noteGuestAckedEpoch(epoch) {
    lastGuestAckedEpoch = Math.max(lastGuestAckedEpoch, epoch)
  }

  function resyncFromLastRoom() {
    if (!attached || isHost || !host || !lastRoom) return
    applyGuestMirror(lastRoom, true)
  }

  return {
    attach,
    detach,
    setHost,
    isAttached: () => attached,
    isHost: () => isHost,
    isApplyingRemote: () => applyingRemote,
    isJoinSyncHolding: () => joinHoldActive,
    isGuestCatchUpPending: () => guestCatchUpPending,
    currentSyncEpoch: () => Math.max(currentSyncEpoch, lastRoom?.syncEpoch || 0),
    lastRoom: () => lastRoom,
    publishPlay,
    publishPause,
    publishSeek,
    publishFromLocal,
    startGuestCatchUp,
    finishGuestCatchUp,
    noteGuestAckedEpoch,
    resyncFromLastRoom
  }
})()
