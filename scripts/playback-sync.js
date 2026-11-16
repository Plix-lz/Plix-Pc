const PlaybackSyncEngine = (() => {
  const Action = Object.freeze({
    NONE: 'NONE',
    SOFT_SEEK: 'SOFT_SEEK',
    HARD_SEEK: 'HARD_SEEK',
    PAUSE: 'PAUSE',
    PLAY: 'PLAY'
  })

  function expectedPositionMs(room, nowMs = Date.now()) {
    let position = Math.max(0, Number(room.positionMs) || 0)
    if (room.playbackState !== WatchPartyConfig.STATE_PLAYING) return position
    const elapsed = Math.max(0, nowMs - (Number(room.updatedAtMs) || nowMs))
    const speed = room.playbackSpeed > 0 ? room.playbackSpeed : 1
    let expected = position + elapsed * speed
    if (room.durationMs > 0) expected = Math.min(expected, room.durationMs)
    return Math.max(0, expected)
  }

  function decide(room, localPositionMs, localPlaying, localSpeed, nowMs = Date.now()) {
    const expected = expectedPositionMs(room, nowMs)
    const drift = Math.abs(expected - localPositionMs)
    const targetSpeed = room.playbackSpeed > 0 ? room.playbackSpeed : 1
    const playing = room.playbackState === WatchPartyConfig.STATE_PLAYING

    if (playing && !localPlaying) {
      if (drift >= WatchPartyConfig.SYNC_HARD_MS) {
        return { action: Action.HARD_SEEK, targetPositionMs: expected, targetSpeed, drift }
      }
      return { action: Action.PLAY, targetPositionMs: expected, targetSpeed, drift }
    }
    if (!playing && localPlaying) {
      return { action: Action.PAUSE, targetPositionMs: expected, targetSpeed, drift }
    }
    if (!playing) {
      if (drift >= WatchPartyConfig.SYNC_HARD_MS) {
        return { action: Action.HARD_SEEK, targetPositionMs: expected, targetSpeed, drift }
      }
      if (drift >= WatchPartyConfig.SYNC_SOFT_MS) {
        return { action: Action.SOFT_SEEK, targetPositionMs: expected, targetSpeed, drift }
      }
      return { action: Action.NONE, targetPositionMs: expected, targetSpeed, drift }
    }
    if (drift >= WatchPartyConfig.SYNC_HARD_MS) {
      return { action: Action.HARD_SEEK, targetPositionMs: expected, targetSpeed, drift }
    }
    if (drift >= WatchPartyConfig.SYNC_SOFT_MS) {
      return { action: Action.SOFT_SEEK, targetPositionMs: expected, targetSpeed, drift }
    }
    return { action: Action.NONE, targetPositionMs: expected, targetSpeed, drift }
  }

  return { Action, expectedPositionMs, decide }
})()
