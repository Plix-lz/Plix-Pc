// Cuenta y respaldo en Firebase con la misma lógica que Plix (FirestoreBackupClient):
// usuario + PIN → {usuario}@plix2.app / "plix:{pin}", y las preferencias en users/{uid}/prefs/{nombre}
// como {payload: JSON de valores {t, v}, updatedAt}. La web comparte Mi lista, Historial y progreso.
const cloud = (() => {
  const SDK_BASE = 'https://www.gstatic.com/firebasejs/12.19.0/'
  const config = CONFIG.FIREBASE ?? {}
  const configured = Boolean(config.apiKey && config.projectId && config.appId)
  const EMAIL_DOMAIN = '@plix2.app'
  const PASSWORD_PREFIX = 'plix:'
  const PREFS = {
    list: 'plix_my_list',
    history: 'plix_content_history',
    progress: 'plix_playback_progress',
    achievements: 'plix_achievements',
    usage: 'plix_app_usage'
  }
  const SYNCED = Object.values(PREFS)
  // Logros y tiempo de uso son de la app: la web solo suma lo suyo y no los sube si no cambió nada,
  // porque Plix borra y reescribe cada archivo de prefs al restaurar.
  const STATS_PREFS = [PREFS.achievements, PREFS.usage]
  const SESSION_KEY = 'lzplay:cuenta'
  const REMOTE_KEY = 'lzplay:cuenta-remoto'
  const PENDING_KEY = 'lzplay:cuenta-pendiente'
  const BIO_KEY = 'lzplay:perfil-bio'
  const BIO_DEFAULT = '¡Hola! Estoy viendo películas y series en PLIX 🍿'
  const BIO_MAX = 150
  const HISTORY_TAG = 'Historial'
  const MAX_HISTORY = 40
  // Mi lista e historial se suben enseguida; el progreso y el tiempo de uso cambian sin parar.
  const UPLOAD_DELAY_MS = 2000
  const PROGRESS_UPLOAD_DELAY_MS = 60_000
  const REFRESH_INTERVAL_MS = 30_000
  const USAGE_TICK_MS = 30_000
  const USAGE_UPLOAD_MS = 5 * 60_000
  const SLOW_PREFS = new Set([PREFS.progress, PREFS.usage])
  const CONFIG_ERRORS = new Set([
    'auth/network-request-failed', 'auth/invalid-api-key', 'auth/api-key-not-valid.-please-pass-a-valid-api-key.',
    'auth/unauthorized-domain', 'auth/too-many-requests', 'auth/app-not-authorized', 'auth/operation-not-allowed',
    'auth/internal-error'
  ])

  const listeners = []
  const dirty = new Set()
  let auth = null
  let db = null
  let session = readSession()
  let busy = false
  let lastError = ''
  let remotePayloads = readJson(REMOTE_KEY, {})
  // Lo que la web aportó a logros/tiempo de uso y aún no se sube.
  let pending = readPending()
  let usageTickAt = Date.now()
  let applyingRemote = false
  let authenticating = false
  let uploadTimer = null
  let uploading = null
  let lastRefreshAt = 0
  let friendsCount = null
  let bio = readBio()

  /* ---------- Utilidades compartidas con Plix (FirestoreSyncConfig) ---------- */

  function sanitizeUsername(username) {
    return String(username ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 60)
  }

  function formatPlixUserId(id) {
    return id > 0 ? `#${String(id).padStart(8, '0')}` : ''
  }

  function wrap(type, value) {
    return { t: type, v: value }
  }

  function parsePayload(text) {
    try {
      const data = JSON.parse(text || '{}')
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
    } catch {
      return {}
    }
  }

  /* ---------- Estado ---------- */

  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback
    } catch {
      return fallback
    }
  }

  function writeJson(key, value) {
    try {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, JSON.stringify(value))
    } catch (error) {
      console.warn('No se pudo guardar en el navegador:', error)
    }
  }

  function readSession() {
    const saved = readJson(SESSION_KEY, null)
    return saved?.uid ? saved : null
  }

  function saveSession() {
    writeJson(SESSION_KEY, session)
  }

  function saveRemote() {
    writeJson(REMOTE_KEY, remotePayloads)
  }

  function readPending() {
    const saved = readJson(PENDING_KEY, {})
    return {
      usageMs: Number(saved.usageMs) || 0,
      movies: Array.isArray(saved.movies) ? saved.movies : [],
      episodes: Array.isArray(saved.episodes) ? saved.episodes : []
    }
  }

  function savePending() {
    writeJson(PENDING_KEY, pending)
  }

  function sanitizeBio(text) {
    return String(text ?? '')
      .trim()
      .replace(/\n{3,}/g, '\n\n')
      .slice(0, BIO_MAX)
  }

  function readBio() {
    const saved = readJson(BIO_KEY, null)
    return {
      text: typeof saved?.text === 'string' ? saved.text : '',
      updatedAt: Number(saved?.updatedAt) || 0
    }
  }

  function saveBioLocal(text, updatedAt = Date.now()) {
    bio = { text: sanitizeBio(text), updatedAt }
    writeJson(BIO_KEY, bio)
  }

  function state() {
    return {
      configured,
      signedIn: Boolean(session && auth?.currentUser?.uid === session.uid),
      username: session?.username ?? '',
      label: session?.label ?? '',
      pin: session?.pin ?? '',
      icon: session?.icon ?? null,
      backdrop: session?.backdrop ?? null,
      bio: bio.text,
      bioUpdatedAt: bio.updatedAt,
      friendsCount,
      stats: stats(),
      lastSyncMs: session?.lastSyncMs ?? 0,
      busy,
      pending: dirty.size > 0,
      error: lastError
    }
  }

  /* ---------- Estadísticas (AccountStatsProvider) ---------- */

  function payloadSet(payload, key) {
    return new Set(Array.isArray(payload?.[key]?.v) ? payload[key].v.map(String) : [])
  }

  function usageBase() {
    const usage = remotePayloads[PREFS.usage] ?? {}
    const owner = usage.user_key?.v
    // Igual que AppUsageTimeStore: si el total era de otro usuario, empieza de cero.
    return !owner || owner === session?.uid ? Number(usage.total_ms?.v) || 0 : 0
  }

  function stats() {
    const achievements = remotePayloads[PREFS.achievements] ?? {}
    const movies = payloadSet(achievements, 'played_movies')
    const episodes = payloadSet(achievements, 'played_episodes')
    pending.movies.forEach(key => movies.add(key))
    pending.episodes.forEach(key => episodes.add(key))
    const series = new Set([...episodes]
      .map(key => key.match(/^episode:(\d+):t/)?.[1])
      .filter(id => Number(id) > 0))
    return {
      achievements: payloadSet(achievements, 'unlocked_ids').size,
      movies: movies.size,
      series: series.size,
      episodes: episodes.size,
      usageMs: usageBase() + pending.usageMs
    }
  }

  /** Como AchievementStore.addPlayedMovie / addPlayedEpisode al empezar a reproducir. */
  function recordPlayed(media, episode) {
    if (!session || !media?.id) return
    const series = media.type === 'tv'
    if (series && !episode) return
    const key = series
      ? `episode:${media.id}:t${episode.season}:e${episode.episode}`
      : `movie:${media.id}`
    const list = series ? pending.episodes : pending.movies
    const remote = payloadSet(remotePayloads[PREFS.achievements], series ? 'played_episodes' : 'played_movies')
    if (remote.has(key) || list.includes(key)) return
    list.push(key)
    savePending()
    markDirty(PREFS.achievements)
  }

  function tickUsage() {
    const now = Date.now()
    const elapsed = now - usageTickAt
    usageTickAt = now
    if (!state().signedIn || document.visibilityState !== 'visible' || elapsed <= 0) return
    // Un salto enorme indica que la PC estuvo suspendida: no cuenta como uso.
    pending.usageMs += Math.min(elapsed, USAGE_TICK_MS * 2)
    savePending()
    if (pending.usageMs >= USAGE_UPLOAD_MS) markDirty(PREFS.usage)
    else notify()
  }

  function hasPendingStats(name) {
    return name === PREFS.usage ? pending.usageMs > 0 : pending.movies.length + pending.episodes.length > 0
  }

  function notify() {
    const current = state()
    listeners.forEach(listener => listener(current))
  }

  function onChange(listener) {
    listeners.push(listener)
  }

  function setBusy(value, error = lastError) {
    busy = value
    lastError = error
    notify()
  }

  function friendlyError(error) {
    const code = error?.code ?? ''
    if (code === 'auth/network-request-failed' || code === 'unavailable') return 'Sin conexión con Firebase. Revisa tu internet.'
    if (code === 'auth/unauthorized-domain') return 'Este dominio no está autorizado en Firebase (Authentication → Configuración → Dominios autorizados).'
    if (code === 'auth/too-many-requests') return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.'
    if (code === 'auth/operation-not-allowed') return 'El acceso con correo y contraseña está deshabilitado en Firebase.'
    if (code.startsWith('auth/invalid-api-key') || code.startsWith('auth/api-key-not-valid')) return 'La apiKey de CONFIG.FIREBASE no es válida.'
    if (code === 'permission-denied') return 'Firestore rechazó la operación (revisa las reglas).'
    return error?.message || 'Ocurrió un error con Firebase.'
  }

  /* ---------- Carga del SDK ---------- */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = src
      script.onload = resolve
      script.onerror = () => reject(new Error('No se pudo cargar Firebase.'))
      document.head.append(script)
    })
  }

  async function loadSdk() {
    await loadScript(`${SDK_BASE}firebase-app-compat.js`)
    const modules = ['auth', 'firestore', config.measurementId && 'analytics'].filter(Boolean)
    await Promise.all(modules.map(name => loadScript(`${SDK_BASE}firebase-${name}-compat.js`)))
  }

  async function start() {
    if (!configured) {
      analytics.init(null)
      return false
    }
    try {
      await loadSdk()
      const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(config)
      auth = firebase.auth()
      db = firebase.firestore()
      analytics.init(app)
    } catch (error) {
      lastError = friendlyError(error)
      console.warn('Firebase no disponible:', error)
      analytics.init(null)
      notify()
      return false
    }

    return new Promise(resolve => {
      let first = true
      auth.onAuthStateChanged(user => {
        if (!authenticating) handleAuthState(user)
        if (first) {
          first = false
          resolve(true)
        }
      })
    })
  }

  function handleAuthState(user) {
    if (user && session?.uid === user.uid) {
      analytics.setUser(user.uid)
      refresh(true)
    } else if (user) {
      // Sesión de Firebase sin datos locales (p. ej. se borró el almacenamiento): se recupera el nombre.
      session = { uid: user.uid, username: user.email?.split('@')[0] ?? '', label: '', pin: '', lastSyncMs: 0 }
      saveSession()
      analytics.setUser(user.uid)
      syncNow()
    } else if (session) {
      session = null
      saveSession()
    }
    notify()
  }

  const ready = start()

  /* ---------- Referencias ---------- */

  const userRef = uid => db.collection('users').doc(uid)
  const prefsRef = (uid, name) => userRef(uid).collection('prefs').doc(name)
  const metadataRef = uid => userRef(uid).collection('metadata').doc('sync')

  /* ---------- Perfil: icono, backdrop e ID (ProfileAvatar/BackdropFirestoreClient) ---------- */

  function selectionFrom(raw, updatedAt) {
    const pick = key => String(raw?.[key] ?? '').trim()
    const selection = { folder: pick('folder'), pack: pick('pack'), id: pick('id'), updatedAt: Number(updatedAt) || 0 }
    if (pick('extension')) selection.extension = pick('extension')
    return selection.folder && selection.pack && selection.id ? selection : null
  }

  // Gana lo más reciente entre lo local y Firestore, como syncFromRemoteIfNeeded.
  function newest(local, remote) {
    if (!remote) return local ?? null
    if (!local || remote.updatedAt >= local.updatedAt) return { ...remote, extension: remote.extension ?? local?.extension }
    return local
  }

  function applyUserDoc(doc) {
    if (!session || !doc?.exists) return
    session.icon = newest(session.icon, selectionFrom(doc.get('icon'), doc.get('iconUpdatedAt')))
    session.backdrop = newest(session.backdrop, selectionFrom(doc.get('backdrop'), doc.get('backdropUpdatedAt')))
    const plixUserId = Number(doc.get('plixUserId')) || 0
    if (plixUserId > 0) {
      session.plixUserId = plixUserId
      session.label = doc.get('plixUserIdLabel') || formatPlixUserId(plixUserId)
    }
    saveSession()
  }

  async function saveSelection(kind, selection) {
    if (!state().signedIn) throw new Error('Inicia sesión para cambiar tu perfil.')
    const field = kind === 'backdrop' ? 'backdrop' : 'icon'
    const updatedAt = Date.now()
    session[field] = { ...selection, updatedAt }
    saveSession()
    notify()
    const payload = { folder: selection.folder, pack: selection.pack, id: selection.id }
    if (selection.extension) payload.extension = selection.extension
    await userRef(session.uid).set({
      [field]: payload,
      [`${field}UpdatedAt`]: updatedAt
    }, { merge: true })
    publishProfile()
    analytics.log(kind === 'backdrop' ? 'select_profile_backdrop' : 'select_profile_icon', {
      item_id: `${selection.folder}/${selection.pack}/${selection.id}`
    })
  }

  /** PublicProfilePublisher: perfil público para la búsqueda de amigos por ID Plix. */
  async function publishProfile() {
    if (!state().signedIn || !(session.plixUserId > 0)) return
    const { uid, username, plixUserId, label } = session
    const publicSelection = selection => selection && {
      folder: selection.folder,
      pack: selection.pack,
      id: selection.id,
      ...(selection.extension ? { extension: selection.extension } : {})
    }
    const data = {
      uid,
      username,
      sanitizedUsername: sanitizeUsername(username),
      plixUserId,
      plixUserIdLabel: label,
      updatedAt: Date.now(),
      stats: stats()
    }
    if (session.icon) data.icon = publicSelection(session.icon)
    if (session.backdrop) data.backdrop = publicSelection(session.backdrop)
    if (bio.updatedAt > 0) {
      data.bio = bio.text
      data.bioUpdatedAt = bio.updatedAt
    }
    if (friendsCount != null && friendsCount >= 0) data.friendsCount = friendsCount
    try {
      await db.collection('publicProfiles').doc(uid).set(data, { merge: true })
      await db.collection('plixUserIdIndex').doc(String(plixUserId)).set({
        uid,
        username,
        sanitizedUsername: sanitizeUsername(username),
        plixUserId,
        plixUserIdLabel: label
      }, { merge: true })
    } catch (error) {
      console.warn('No se pudo publicar el perfil:', error)
    }
  }

  async function setBio(text) {
    if (!state().signedIn) throw new Error('Inicia sesión para editar tu descripción.')
    saveBioLocal(text)
    notify()
    publishProfile()
  }

  /** Adopta la descripción publicada desde otro dispositivo si es más reciente. */
  async function syncBioFromRemote() {
    if (!state().signedIn || !db) return
    try {
      const doc = await db.collection('publicProfiles').doc(session.uid).get()
      if (!doc.exists) return
      const remoteAt = Number(doc.get('bioUpdatedAt')) || 0
      if (remoteAt <= bio.updatedAt) return
      saveBioLocal(String(doc.get('bio') ?? ''), remoteAt)
    } catch (error) {
      console.warn('No se pudo sincronizar la descripción:', error)
    }
  }

  async function refreshFriendsCount() {
    if (!state().signedIn || !db) {
      friendsCount = null
      return
    }
    try {
      const snap = await userRef(session.uid).collection('friends').get()
      friendsCount = snap.size
    } catch (error) {
      console.warn('No se pudo contar amigos:', error)
    }
  }

  async function ensureSessionPlixUserId() {
    if (!state().signedIn || session.plixUserId > 0) return
    try {
      const id = await ensurePlixUserId(session.uid, session.username)
      if (id > 0) {
        session.plixUserId = id
        session.label = formatPlixUserId(id)
        saveSession()
        publishProfile()
      }
    } catch (error) {
      console.warn('No se pudo asignar el ID de Plix:', error)
    }
  }

  /**
   * Como AccountActivity.onResume: pinta con lo local y luego tira de Firestore
   * (icono/backdrop, bio pública, amigos e ID Plix).
   */
  async function refreshAccount() {
    if (!state().signedIn || !db) return
    try {
      await Promise.all([
        userRef(session.uid).get().then(applyUserDoc),
        syncBioFromRemote(),
        refreshFriendsCount(),
        ensureSessionPlixUserId()
      ])
      lastError = ''
    } catch (error) {
      lastError = friendlyError(error)
      console.warn('No se pudo actualizar la cuenta:', error)
    }
    notify()
  }

  /* ---------- Cuenta (igual que FirestoreBackupClient) ---------- */

  async function ensureProfile(uid, username) {
    await userRef(uid).set({
      username,
      sanitizedUsername: sanitizeUsername(username),
      updatedAt: Date.now()
    }, { merge: true })
  }

  async function registerAccountIndex(uid, username) {
    const sanitized = sanitizeUsername(username)
    await db.collection('accounts').doc(sanitized).set({
      username: username.trim(),
      sanitizedUsername: sanitized,
      uid,
      createdAt: Date.now()
    }, { merge: true })
  }

  async function ensurePlixUserId(uid, username) {
    const sanitized = sanitizeUsername(username)
    const accountRef = db.collection('accounts').doc(sanitized)
    const counterRef = db.collection('meta').doc('plixUserIds')
    const indexPatch = id => ({
      uid,
      username: username.trim(),
      sanitizedUsername: sanitized,
      plixUserId: id,
      plixUserIdLabel: formatPlixUserId(id)
    })

    return db.runTransaction(async transaction => {
      const accountSnap = await transaction.get(accountRef)
      const existing = accountSnap.exists ? Number(accountSnap.get('plixUserId')) || 0 : 0
      if (existing > 0) {
        transaction.set(db.collection('plixUserIdIndex').doc(String(existing)), indexPatch(existing), { merge: true })
        return existing
      }

      const counterSnap = await transaction.get(counterRef)
      const stored = counterSnap.exists ? Number(counterSnap.get('nextId')) || 0 : 0
      const id = stored > 0 ? stored : 1
      const label = formatPlixUserId(id)

      transaction.set(counterRef, { nextId: id + 1 }, { merge: true })
      const accountPatch = { plixUserId: id, plixUserIdLabel: label }
      if (!accountSnap.exists) {
        Object.assign(accountPatch, { username: username.trim(), sanitizedUsername: sanitized, uid, createdAt: Date.now() })
      }
      transaction.set(accountRef, accountPatch, { merge: true })
      transaction.set(userRef(uid), { plixUserId: id, plixUserIdLabel: label }, { merge: true })
      transaction.set(db.collection('plixUserIdIndex').doc(String(id)), indexPatch(id), { merge: true })
      return id
    })
  }

  // Firebase puede responder "credenciales inválidas" aunque el usuario no exista (protección
  // anti-enumeración), así que, como Plix, si falla el acceso se intenta crear la cuenta.
  async function authenticate(email, password) {
    try {
      return { credential: await auth.signInWithEmailAndPassword(email, password), created: false }
    } catch (error) {
      if (CONFIG_ERRORS.has(error.code)) throw error
    }
    try {
      return { credential: await auth.createUserWithEmailAndPassword(email, password), created: true }
    } catch (error) {
      if (error.code === 'auth/email-already-in-use') throw new Error('El PIN es incorrecto.')
      throw error
    }
  }

  async function signIn(username, pin) {
    if (!configured) throw new Error('Falta la configuración web de Firebase en scripts/config.js (CONFIG.FIREBASE).')
    if (!(await ready) || !auth) throw new Error(lastError || 'No se pudo iniciar Firebase.')

    const name = String(username ?? '').trim()
    if (!sanitizeUsername(name)) throw new Error('Escribe un nombre de usuario válido.')
    if (!/^\d{4,8}$/.test(pin)) throw new Error('El PIN debe tener de 4 a 8 dígitos.')

    setBusy(true, '')
    authenticating = true
    try {
      const email = sanitizeUsername(name) + EMAIL_DOMAIN
      const { credential, created } = await authenticate(email, PASSWORD_PREFIX + pin)
      const uid = credential.user.uid

      await ensureProfile(uid, name)
      await registerAccountIndex(uid, name)
      let plixUserId = 0
      try {
        plixUserId = await ensurePlixUserId(uid, name)
      } catch (error) {
        console.warn('No se pudo asignar el ID de Plix:', error)
      }

      // El PIN se guarda solo en esta PC para mostrarlo en Cuenta, como AccountPinVault.
      session = { uid, username: name, label: formatPlixUserId(plixUserId), plixUserId, pin, lastSyncMs: 0 }
      saveSession()
      remotePayloads = {}
      saveRemote()
      resetPending()
      analytics.setUser(uid)
      analytics.log(created ? 'sign_up' : 'login', { method: 'usuario_pin' })

      try {
        const profile = await userRef(uid).get()
        applyUserDoc(profile)
        if (profile.get('hasBackup') === true) await download({ merge: true })
        await upload(SYNCED)
        setBusy(false, '')
        publishProfile()
      } catch (error) {
        console.warn('Sesión iniciada, pero falló la sincronización:', error)
        setBusy(false, friendlyError(error))
      }
      return { created }
    } catch (error) {
      if (auth.currentUser && !session) await auth.signOut().catch(() => {})
      setBusy(false, '')
      throw new Error(friendlyError(error))
    } finally {
      authenticating = false
    }
  }

  function resetPending() {
    pending = { usageMs: 0, movies: [], episodes: [] }
    savePending()
    usageTickAt = Date.now()
  }

  async function signOut() {
    tickUsage()
    if (pending.usageMs > 0) dirty.add(PREFS.usage)
    await flush().catch(() => {})
    cancelUpload()
    dirty.clear()
    await auth?.signOut().catch(() => {})
    session = null
    saveSession()
    remotePayloads = {}
    saveRemote()
    resetPending()
    friendsCount = null
    saveBioLocal('', 0)
    analytics.setUser(null)
    // Igual que Plix al cerrar sesión: los datos locales pertenecen a la cuenta.
    applyingRemote = true
    try {
      myList.replace([])
      watchHistory.clear()
      playbackProgress.replace({})
    } finally {
      applyingRemote = false
    }
    lastError = ''
    notify()
  }

  /* ---------- Conversión entre la web y Plix ---------- */

  function tmdbPath(url) {
    if (!url) return null
    const match = String(url).match(/image\.tmdb\.org\/t\/p\/[^/]+(\/.+)$/)
    return match ? match[1] : url
  }

  function fromPlixHistory(entry) {
    const rating = Number(entry.rating)
    return {
      id: Number(entry.id),
      type: entry.contentType === 'series' ? 'tv' : 'movie',
      title: entry.title ?? '',
      originalTitle: entry.originalTitle ?? '',
      overview: entry.overview ?? '',
      rating: rating > 0 ? rating.toFixed(1) : '–',
      year: entry.year ?? '',
      backdrop: tmdbPath(entry.backdropUrl),
      poster: tmdbPath(entry.posterUrl),
      openedAt: Number(entry.openedAt) || 0
    }
  }

  function toPlixHistory(entry) {
    return {
      id: Number(entry.id),
      tag: HISTORY_TAG,
      contentType: entry.type === 'tv' ? 'series' : 'movie',
      openedAt: entry.openedAt ?? Date.now(),
      title: entry.title ?? '',
      originalTitle: entry.originalTitle || entry.title || '',
      overview: entry.overview ?? '',
      posterUrl: api.imageUrl(entry.poster, 'small'),
      backdropUrl: api.imageUrl(entry.backdrop, 'large'),
      year: String(entry.year ?? ''),
      rating: Number(entry.rating) || 0
    }
  }

  function remoteHistory(payload) {
    try {
      const entries = JSON.parse(payload.entries?.v ?? '[]')
      return Array.isArray(entries)
        ? entries.filter(entry => entry?.tag === HISTORY_TAG && Number(entry.id) > 0).map(fromPlixHistory)
        : []
    } catch {
      return []
    }
  }

  function remoteListKeys(payload) {
    const ids = key => (Array.isArray(payload[key]?.v) ? payload[key].v : [])
    return [
      ...ids('movie_ids').map(id => `movie:${id}`),
      ...ids('serie_ids').map(id => `tv:${id}`)
    ]
  }

  async function buildList(keys) {
    const local = new Map(myList.all().map(item => [`${item.type}:${item.id}`, item]))
    const ordered = [...local.keys()].filter(key => keys.has(key))
    const missing = [...keys].filter(key => !local.has(key))
    const fetched = await Promise.all(missing.map(async key => {
      const [type, id] = key.split(':')
      try {
        return await api.getMedia(Number(id), type)
      } catch {
        // Se conserva el ID para no borrarlo de la cuenta aunque TMDB falle ahora.
        return { id: Number(id), type, title: `#${id}`, overview: '', rating: '–', backdrop: null, poster: null }
      }
    }))
    return [...ordered.map(key => local.get(key)), ...fetched]
  }

  /* ---------- Descarga ---------- */

  async function fetchRemote(uid) {
    const names = Object.values(PREFS)
    const docs = await Promise.all(names.map(name => prefsRef(uid, name).get()))
    const payloads = {}
    docs.forEach((doc, index) => {
      payloads[names[index]] = doc.exists ? parsePayload(doc.get('payload')) : {}
    })
    return payloads
  }

  /** merge: une lo local con la nube (al iniciar sesión); sin merge la nube reemplaza lo local. */
  async function download({ merge }) {
    const uid = session.uid
    const [payloads, metadata] = await Promise.all([fetchRemote(uid), metadataRef(uid).get()])
    remotePayloads = payloads
    saveRemote()

    const listKeys = new Set(remoteListKeys(payloads[PREFS.list]))
    if (merge) myList.all().forEach(item => listKeys.add(`${item.type}:${item.id}`))
    const list = await buildList(listKeys)

    const history = remoteHistory(payloads[PREFS.history])
    const progress = merge
      ? { ...payloads[PREFS.progress], ...playbackProgress.raw() }
      : payloads[PREFS.progress]

    applyingRemote = true
    try {
      myList.replace(list)
      watchHistory.replace(merge ? [...watchHistory.all(), ...history] : history)
      playbackProgress.replace(progress)
    } finally {
      applyingRemote = false
    }

    session.lastSyncMs = Math.max(session.lastSyncMs ?? 0, Number(metadata.get?.('lastUploadMs')) || 0)
    saveSession()
  }

  /* ---------- Subida ---------- */

  function unionSet(payload, key, values) {
    payload[key] = wrap('ss', [...new Set([...payloadSet(payload, key), ...values])])
  }

  /** consumed recibe lo pendiente que entra en esta subida, para descontarlo si se confirma. */
  function buildPayload(name, consumed) {
    // Se conservan las claves que la web no maneja para no borrar datos de la app.
    const base = { ...(remotePayloads[name] ?? {}) }
    if (name === PREFS.achievements) {
      consumed.movies = [...pending.movies]
      consumed.episodes = [...pending.episodes]
      unionSet(base, 'played_movies', consumed.movies)
      unionSet(base, 'played_episodes', consumed.episodes)
      unionSet(base, 'played_contents', [...consumed.movies, ...consumed.episodes])
      return base
    }
    if (name === PREFS.usage) {
      consumed.usageMs = pending.usageMs
      base.total_ms = wrap('l', usageBase() + consumed.usageMs)
      base.user_key = wrap('s', session.uid)
      return base
    }
    if (name === PREFS.list) {
      const items = myList.all()
      base.movie_ids = wrap('ss', items.filter(item => item.type !== 'tv').map(item => String(item.id)))
      base.serie_ids = wrap('ss', items.filter(item => item.type === 'tv').map(item => String(item.id)))
      return base
    }
    if (name === PREFS.history) {
      base.entries = wrap('s', JSON.stringify(watchHistory.all().slice(0, MAX_HISTORY).map(toPlixHistory)))
      return base
    }
    return playbackProgress.raw()
  }

  async function upload(requested) {
    const names = requested.filter(name => !STATS_PREFS.includes(name) || hasPendingStats(name))
    if (!session || !db || !names.length) return
    const uid = session.uid
    const now = Date.now()
    const batch = db.batch()
    const payloads = {}
    const consumed = {}
    names.forEach(name => {
      payloads[name] = buildPayload(name, consumed)
      batch.set(prefsRef(uid, name), { payload: JSON.stringify(payloads[name]), updatedAt: now })
    })
    batch.set(metadataRef(uid), { lastUploadMs: now, lastSync: now, version: 1 })
    batch.set(userRef(uid), { hasBackup: true, updatedAt: now }, { merge: true })
    await batch.commit()
    Object.assign(remotePayloads, payloads)
    saveRemote()
    if (consumed.usageMs) pending.usageMs = Math.max(0, pending.usageMs - consumed.usageMs)
    if (consumed.movies) pending.movies = pending.movies.filter(key => !consumed.movies.includes(key))
    if (consumed.episodes) pending.episodes = pending.episodes.filter(key => !consumed.episodes.includes(key))
    savePending()
    session.lastSyncMs = now
    saveSession()
  }

  async function flush() {
    cancelUpload()
    if (uploading) await uploading.catch(() => {})
    if (!dirty.size || !state().signedIn) return
    const names = [...dirty]
    dirty.clear()
    uploading = (async () => {
      // Si la app subió algo después de la última sincronización, primero se une con eso.
      const metadata = await metadataRef(session.uid).get()
      if ((Number(metadata.get?.('lastUploadMs')) || 0) > (session.lastSyncMs ?? 0)) {
        await download({ merge: true })
        return upload(SYNCED)
      }
      return upload(names)
    })()
    try {
      await uploading
      lastError = ''
    } catch (error) {
      names.forEach(name => dirty.add(name))
      lastError = friendlyError(error)
      console.warn('No se pudo sincronizar con Firebase:', error)
    } finally {
      uploading = null
      notify()
    }
  }

  function cancelUpload() {
    clearTimeout(uploadTimer)
    uploadTimer = null
  }

  function markDirty(name) {
    if (applyingRemote || !session) return
    dirty.add(name)
    // Un cambio lento no reprograma una subida ya pendiente: si no, nunca llegaría a subirse.
    if (!(uploadTimer && SLOW_PREFS.has(name))) {
      cancelUpload()
      const onlySlow = [...dirty].every(item => SLOW_PREFS.has(item))
      uploadTimer = setTimeout(() => {
        uploadTimer = null
        flush()
      }, onlySlow ? PROGRESS_UPLOAD_DELAY_MS : UPLOAD_DELAY_MS)
    }
    notify()
  }

  /* ---------- Sincronización ---------- */

  /** Trae los cambios hechos desde la app si la nube es más reciente que la última sincronización. */
  async function refresh(force = false) {
    if (!state().signedIn || busy || dirty.size || uploading) return
    if (!force && Date.now() - lastRefreshAt < REFRESH_INTERVAL_MS) return
    lastRefreshAt = Date.now()
    try {
      const [metadata, profile] = await Promise.all([metadataRef(session.uid).get(), userRef(session.uid).get()])
      applyUserDoc(profile)
      const remoteMs = Number(metadata.get?.('lastUploadMs')) || 0
      if (remoteMs > (session.lastSyncMs ?? 0) && !dirty.size) await download({ merge: false })
      lastError = ''
    } catch (error) {
      lastError = friendlyError(error)
      console.warn('No se pudo actualizar desde Firebase:', error)
    }
    notify()
  }

  async function syncNow() {
    if (!state().signedIn || busy) return
    setBusy(true, '')
    try {
      cancelUpload()
      dirty.clear()
      tickUsage()
      applyUserDoc(await userRef(session.uid).get())
      await download({ merge: true })
      await upload(SYNCED)
      setBusy(false, '')
      publishProfile()
    } catch (error) {
      setBusy(false, friendlyError(error))
    }
  }

  // Guarda lo acumulado al ocultar la pestaña, salvo que ya no haya sesión.
  function flushOnLeave() {
    tickUsage()
    if (session && pending.usageMs > 0) dirty.add(PREFS.usage)
    if (session && hasPendingStats(PREFS.achievements)) dirty.add(PREFS.achievements)
    flush()
  }

  myList.onChange(() => markDirty(PREFS.list))
  watchHistory.onChange(() => markDirty(PREFS.history))
  playbackProgress.onChange(() => markDirty(PREFS.progress))

  setInterval(tickUsage, USAGE_TICK_MS)
  window.addEventListener('focus', () => refresh())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushOnLeave()
    } else {
      usageTickAt = Date.now()
      refresh()
    }
  })
  window.addEventListener('pagehide', flushOnLeave)

  async function ensureFirebase() {
    const ok = await ready
    if (!ok || !db || !auth || typeof firebase === 'undefined') {
      throw new Error('Firebase no disponible. Revisa la configuración.')
    }
    return { db, auth, firebase }
  }

  async function ensureWatchPartyAuth(preferredName = '') {
    const { auth: firebaseAuth } = await ensureFirebase()
    let user = firebaseAuth.currentUser
    if (!user) {
      const result = await firebaseAuth.signInAnonymously()
      user = result.user
    }
    if (!user) throw new Error('No se pudo iniciar sesión para Cine Virtual.')
    try {
      await user.getIdToken(true)
    } catch { /* token fresco opcional */ }
    const name = String(preferredName || session?.username || '').trim()
      || `Invitado-${user.uid.slice(-4)}`
    return { uid: user.uid, displayName: name, user }
  }

  function parsePlixUserId(raw) {
    const digits = String(raw ?? '').replace(/\D/g, '')
    const id = Number(digits)
    return Number.isFinite(id) && id > 0 ? id : 0
  }

  function resolveAvatarUrl(avatar, fallbackUrl = '') {
    if (typeof avatar === 'string' && avatar) return avatar
    if (avatar?.imageUrl) return String(avatar.imageUrl)
    if (avatar?.folder && avatar?.pack && avatar?.id) {
      return profileCatalog.imageUrl('icon', {
        folder: String(avatar.folder),
        pack: String(avatar.pack),
        id: String(avatar.id),
        extension: avatar.extension ? String(avatar.extension) : undefined
      })
    }
    return fallbackUrl || profileCatalog.DEFAULT_AVATAR || ''
  }

  async function listFriends() {
    if (!state().signedIn || !db) return []
    const snap = await userRef(session.uid).collection('friends').get()
    const friends = await Promise.all(snap.docs.map(async doc => {
      const data = doc.data() || {}
      let username = String(data.username || '')
      let plixUserId = Number(data.plixUserId) || 0
      let plixUserIdLabel = String(data.plixUserIdLabel || formatPlixUserId(plixUserId))
      let avatarUrl = resolveAvatarUrl(data.avatar, String(data.avatarUrl || ''))

      // Igual que Android: refrescar icono/nombre desde publicProfiles.
      try {
        const profile = await db.collection('publicProfiles').doc(doc.id).get()
        if (profile.exists) {
          const remote = profile.data() || {}
          if (remote.username) username = String(remote.username)
          if (remote.plixUserId) {
            plixUserId = Number(remote.plixUserId) || plixUserId
            plixUserIdLabel = String(remote.plixUserIdLabel || formatPlixUserId(plixUserId))
          }
          const remoteUrl = resolveAvatarUrl(remote.icon || remote.avatar, String(remote.iconUrl || ''))
          if (remoteUrl) avatarUrl = remoteUrl
        }
      } catch { /* ignore */ }

      return {
        uid: doc.id,
        username,
        plixUserId,
        plixUserIdLabel,
        avatarUrl: avatarUrl || profileCatalog.DEFAULT_AVATAR || '',
        sinceMs: Number(data.sinceMs || data.createdAt) || 0
      }
    }))
    friends.sort((a, b) => a.username.localeCompare(b.username, 'es'))
    return friends
  }

  async function findPublicProfileByPlixId(rawId) {
    await ensureFirebase()
    const plixUserId = parsePlixUserId(rawId)
    if (!plixUserId) throw new Error('ID inválido')
    const index = await db.collection('plixUserIdIndex').doc(String(plixUserId)).get()
    if (!index.exists) throw new Error('No se encontró ese ID')
    const uid = String(index.get('uid') || '')
    if (!uid) throw new Error('No se encontró ese ID')
    const profile = await db.collection('publicProfiles').doc(uid).get()
    const data = profile.exists ? (profile.data() || {}) : {}
    const icon = data.icon || data.avatar || null
    return {
      uid,
      username: String(data.username || index.get('username') || ''),
      plixUserId,
      plixUserIdLabel: String(data.plixUserIdLabel || formatPlixUserId(plixUserId)),
      icon: avatarPayload(icon),
      avatarUrl: resolveAvatarUrl(icon, String(data.iconUrl || '')),
      bio: String(data.bio || '')
    }
  }

  async function listIncomingFriendRequests() {
    if (!state().signedIn || !db) return []
    const snap = await db.collection('friendRequests')
      .where('toUid', '==', session.uid)
      .where('status', '==', 'pending')
      .get()
    const requests = []
    snap.forEach(doc => {
      const data = doc.data() || {}
      requests.push({
        id: doc.id,
        fromUid: String(data.fromUid || ''),
        fromUsername: String(data.fromUsername || ''),
        fromPlixUserId: Number(data.fromPlixUserId) || 0,
        fromPlixUserIdLabel: String(data.fromPlixUserIdLabel || formatPlixUserId(Number(data.fromPlixUserId) || 0)),
        fromAvatar: data.fromAvatar || null,
        fromAvatarUrl: resolveAvatarUrl(data.fromAvatar),
        createdAt: Number(data.createdAt) || 0
      })
    })
    requests.sort((a, b) => b.createdAt - a.createdAt)
    return requests
  }

  async function sendFriendRequest(target) {
    if (!state().signedIn || !db) throw new Error('Iniciá sesión primero')
    if (!target?.uid) throw new Error('Usuario inválido')
    if (target.uid === session.uid) throw new Error('No podés agregarte a vos mismo')
    const friendDoc = await userRef(session.uid).collection('friends').doc(target.uid).get()
    if (friendDoc.exists) throw new Error('Ya son amigos')
    const id = `${session.uid}_${target.uid}`
    const existing = await db.collection('friendRequests').doc(id).get()
    if (existing.exists && existing.get('status') === 'pending') {
      throw new Error('Ya enviaste una solicitud')
    }
    const reverseId = `${target.uid}_${session.uid}`
    const reverse = await db.collection('friendRequests').doc(reverseId).get()
    if (reverse.exists && reverse.get('status') === 'pending') {
      await acceptFriendRequest({
        id: reverseId,
        fromUid: target.uid,
        fromUsername: target.username,
        fromPlixUserId: target.plixUserId,
        fromPlixUserIdLabel: target.plixUserIdLabel,
        fromAvatar: target.icon || null,
        fromAvatarUrl: target.avatarUrl
      })
      return { acceptedExisting: true }
    }
    const now = Date.now()
    const payload = {
      fromUid: session.uid,
      toUid: target.uid,
      fromUsername: session.username || '',
      toUsername: target.username || '',
      fromPlixUserId: session.plixUserId || 0,
      fromPlixUserIdLabel: session.label || '',
      toPlixUserId: target.plixUserId || 0,
      toPlixUserIdLabel: target.plixUserIdLabel || '',
      status: 'pending',
      createdAt: now,
      updatedAt: now
    }
    if (session.icon?.folder && session.icon?.pack && session.icon?.id) {
      payload.fromAvatar = {
        folder: session.icon.folder,
        pack: session.icon.pack,
        id: session.icon.id,
        ...(session.icon.extension ? { extension: session.icon.extension } : {})
      }
    }
    await db.collection('friendRequests').doc(id).set(payload)
    return { acceptedExisting: false }
  }

  function avatarPayload(selection) {
    if (!selection?.folder || !selection?.pack || !selection?.id) return null
    return {
      folder: selection.folder,
      pack: selection.pack,
      id: selection.id,
      ...(selection.extension ? { extension: selection.extension } : {})
    }
  }

  async function acceptFriendRequest(request) {
    if (!state().signedIn || !db || !request?.fromUid) throw new Error('Solicitud inválida')
    const now = Date.now()
    let fromAvatar = avatarPayload(request.fromAvatar)
    let fromUsername = request.fromUsername || ''
    let fromPlixUserId = Number(request.fromPlixUserId) || 0
    let fromPlixUserIdLabel = request.fromPlixUserIdLabel || ''
    try {
      const profile = await db.collection('publicProfiles').doc(request.fromUid).get()
      if (profile.exists) {
        const remote = profile.data() || {}
        if (!fromAvatar) fromAvatar = avatarPayload(remote.icon || remote.avatar)
        if (remote.username) fromUsername = String(remote.username)
        if (remote.plixUserId) {
          fromPlixUserId = Number(remote.plixUserId) || fromPlixUserId
          fromPlixUserIdLabel = String(remote.plixUserIdLabel || formatPlixUserId(fromPlixUserId))
        }
      }
    } catch { /* ignore */ }

    const meSide = {
      friendUid: request.fromUid,
      username: fromUsername,
      plixUserId: fromPlixUserId,
      plixUserIdLabel: fromPlixUserIdLabel,
      sinceMs: now
    }
    if (fromAvatar) meSide.avatar = fromAvatar
    else if (request.fromAvatarUrl) meSide.avatarUrl = request.fromAvatarUrl

    const themSide = {
      friendUid: session.uid,
      username: session.username || '',
      plixUserId: session.plixUserId || 0,
      plixUserIdLabel: session.label || '',
      sinceMs: now
    }
    const myAvatar = avatarPayload(session.icon)
    if (myAvatar) themSide.avatar = myAvatar

    const batch = db.batch()
    batch.set(userRef(session.uid).collection('friends').doc(request.fromUid), meSide, { merge: true })
    batch.set(userRef(request.fromUid).collection('friends').doc(session.uid), themSide, { merge: true })
    batch.set(db.collection('friendRequests').doc(request.id), {
      status: 'accepted',
      updatedAt: now
    }, { merge: true })
    await batch.commit()
    await refreshFriendsCount()
    notify()
  }

  return {
    configured, ready, state, onChange, signIn, signOut, syncNow, flush, sanitizeUsername,
    recordPlayed, refreshAccount, setBio, BIO_DEFAULT, BIO_MAX,
    ensureFirebase, ensureWatchPartyAuth,
    listFriends, findPublicProfileByPlixId, listIncomingFriendRequests,
    sendFriendRequest, acceptFriendRequest, parsePlixUserId, formatPlixUserId,
    setIcon: selection => saveSelection('icon', selection),
    setBackdrop: selection => saveSelection('backdrop', selection)
  }
})()
