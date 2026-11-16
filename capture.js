// Versión PC del HlsCaptureEngine de Plix: el embed se abre en un Chrome oculto (el equivalente al
// WebView de 1×1 px), se bloquean anuncios y popups, se fuerza el play silenciado y se escucha la
// red hasta encontrar el HLS. La sesión sigue viva hasta que el reproductor confirma que ya
// reproduce; entonces se destruye, igual que destroyWebView() en STATE_READY.
const fs = require('node:fs')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')

let puppeteer = null
try {
  puppeteer = require('puppeteer-core')
} catch {}

const BROWSER_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

// El embed se carga dentro de un iframe de esta página falsa: los anuncios no pueden reemplazar la
// página principal (como el modo "wrapped" de Plix) y el embed recibe el Referer de PelixPlay.
const WRAPPER_URL = 'https://pelixplay.app/__lzplay_captura__'
const REPORT_PREFIX = '__lzplay_hls__'
const SESSION_TTL_MS = 2 * 60 * 1000
const COOKIE_TTL_MS = 6 * 60 * 60 * 1000
const BROWSER_IDLE_MS = 5 * 60 * 1000
const CLICK_INTERVAL_MS = 2500
// HumanCheckDialog.CAPTURE_TIMEOUT_MS: margen para que la persona resuelva el captcha y pulse Play.
const HUMAN_TIMEOUT_MS = 120_000
const HUMAN_LINGER_MS = 30_000
const VIEWPORT = { width: 1280, height: 720 }
const DEBUG = process.env.LZPLAY_CAPTURE_DEBUG === '1'
const debug = (...args) => { if (DEBUG) console.log('[captura]', ...args) }

/* ---------- StreamUrlUtils ---------- */

function normalize(url) {
  if (!url) return ''
  let clean = String(url).trim().replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&')
  if (clean.startsWith('//')) clean = `https:${clean}`
  return clean
}

const isHttp = url => /^https?:\/\//i.test(url ?? '')

function isJunk(url) {
  const lower = (url ?? '').toLowerCase()
  return lower.includes('aliexpress') ||
    lower.includes('alicdn') ||
    lower.includes('alibaba') ||
    lower.includes('googletagmanager') ||
    lower.includes('google-analytics') ||
    lower.includes('googleads') ||
    lower.includes('doubleclick') ||
    lower.includes('zoneid=') ||
    lower.includes('request_ab') ||
    lower.includes('betwinner') ||
    lower.includes('amd-cdn-') ||
    (lower.includes('/content/stream/agl/') && lower.includes('.mp4'))
}

// Videos de prueba públicos que algunos embeds cargan como señuelo antes (o en vez) del contenido.
function isDecoy(url) {
  return /test-videos\.co\.uk|sample-videos\.com|samplelib\.com|gtv-videos-bucket|big_?buck_?bunny|elephants_?dream|sintel|tears_?of_?steel/i.test(url ?? '')
}

function isEnhancedJunk(url) {
  if (isJunk(url) || isDecoy(url)) return true
  const lower = (url ?? '').toLowerCase()
  return lower.includes('googlevideo') ||
    lower.includes('/pre-roll/') ||
    lower.includes('preroll') ||
    lower.includes('vast.') ||
    lower.includes('/ads/') ||
    lower.includes('pagead')
}

function isSegment(url) {
  const lower = (url ?? '').toLowerCase()
  return lower.includes('init-') ||
    lower.includes('fragment-') ||
    lower.endsWith('.m4s') || lower.includes('.m4s?') ||
    lower.endsWith('.ts') || lower.includes('.ts?') ||
    lower.includes('bytes=')
}

// StreamWish y VidHide sirven el master como /hls3/…/master.txt, que la regla genérica no reconoce.
function isStreamWishHls(url) {
  return /\/hls\d*\/.+\/(master|index)[^/]*\.txt/i.test(url ?? '')
}

function isHls(url) {
  url = normalize(url)
  if (!isHttp(url)) return false
  const lower = url.toLowerCase()
  if (isStreamWishHls(lower)) return true
  if (!lower.includes('.m3u8') && !lower.includes('/m3u8') && !lower.includes('m3u8?')) {
    if (!lower.includes('/hls/') && !lower.includes('/hls2/')) return false
    return lower.includes('playlist') || lower.includes('master') || lower.includes('index')
  }
  return true
}

function isProgressiveMp4(url) {
  url = normalize(url)
  return isHttp(url) && !isSegment(url) && url.toLowerCase().includes('.mp4')
}

// StreamUrlUtils.isDash(): PowVideo (pkcdn) solo entrega DASH; la web lo reproduce con dash.js.
function isDash(url) {
  url = normalize(url)
  return isHttp(url) && !isSegment(url) && /\.mpd(\?|#|$)/i.test(url)
}

const isCapturable = url => isHls(url) || isDash(url) || isProgressiveMp4(url)
const streamType = url => (isHls(url) ? 'hls' : isDash(url) ? 'dash' : 'mp4')

function playlistQualityScore(url) {
  url = normalize(url)
  if (!isHttp(url) || isJunk(url) || isSegment(url)) return 0
  const lower = url.toLowerCase()
  let score = 0
  if (lower.includes('master.m3u8') || lower.includes('master.txt') || lower.includes('/master.')) score += 100
  else if (lower.includes('playlist.m3u8') || lower.includes('playlist.m3u')) score += 80
  else if (lower.includes('index-v1') || lower.includes('index.m3u8')) score += 70
  else if (isHls(url)) score += 50
  else if (isDash(url)) score += 45
  else if (isProgressiveMp4(url)) score += 20
  if (lower.includes('/hls2/') || lower.includes('/hls/')) score += 8
  return score
}

const HLS_PATTERN = /https?:[/\\]{2}[^\s"'<>]+?(?:\.m3u8|\/m3u8|m3u8\?|master\.m3u8|index\.m3u8|index-v1-a1\.m3u8|playlist\.m3u8|\/hls2\/[^\s"'<>]+\.m3u8)(?:[^\s"'<>]*)?/i

function extractFromText(text) {
  const match = (text ?? '').match(HLS_PATTERN)
  return match ? normalize(match[0]) : null
}

/* ---------- ServerFamily / ProblemServerPolicy ---------- */

function family(url) {
  const lower = (url ?? '').toLowerCase()
  if (lower.includes('vidmoly')) return 'vidmoly'
  if (lower.includes('voe')) return 'voe'
  if (lower.includes('goodstream') || lower.includes('gscdn')) return 'gscdn'
  if (/lulustream|luluvdo|luluvid/.test(lower)) return 'lulustream'
  if (lower.includes('uqload')) return 'uqload'
  if (lower.includes('vimeos')) return 'vimeos'
  if (lower.includes('primeload')) return 'primeload'
  // PowVideo y Streamplay (mismo script y CDN pkcdn) rotan de dominio, como en ServerFamily de Plix.
  if (/powvideo|powwideo|powvldeo|povvldeo|powv1deo|povvideo|pouvideo|povw1deo/.test(lower)) return 'powvideo'
  if (/streamplay|straemplay|streamp1ay|stre4mplay|steamplay|streampiay/.test(lower)) return 'streamplay'
  if (lower.includes('abyss') || lower.includes('short.icu')) return 'abyss'
  return 'unknown'
}

// VOE rota de dominio (teresapoliticallearn.com…): si la URL no lo delata, cuenta el nombre en la lista.
function familyOf(url, label = '') {
  const fromUrl = family(url)
  return fromUrl !== 'unknown' ? fromUrl : family(label)
}

/**
 * requiresHumanStep(): servidores con captcha que no entregan el HLS hasta que una persona lo
 * resuelve y pulsa Play (VOE, PowVideo…).
 */
function requiresHumanStep(url, label = '') {
  return ['voe', 'powvideo', 'streamplay', 'primeload', 'abyss'].includes(familyOf(url, label))
}

// acceptHls() de Plix: VOE y compañía solo entregan el contenido por HLS; un MP4 suelto en su
// página es la publicidad o el video señuelo (Big Buck Bunny de test-videos.co.uk).
function acceptsKind(fam, kind) {
  switch (fam) {
    case 'voe':
    case 'vimeos':
    case 'uqload':
    case 'primeload':
      return kind === 'hls'
    case 'gscdn':
      return kind !== 'mp4'
    default:
      return true
  }
}

const acceptsStream = (fam, url) => isCapturable(url) && acceptsKind(fam, streamType(url))

// captureTimeoutMs() para el servidor elegido por el usuario.
function captureTimeoutMs(fam) {
  switch (fam) {
    case 'uqload': return 35_000
    case 'voe':
    case 'vidmoly':
    case 'gscdn':
    case 'vimeos':
    case 'lulustream':
    case 'primeload':
      return 30_000
    default:
      return 25_000
  }
}

function settleDelayMs(fam, afterManualPlay = false) {
  switch (fam) {
    case 'vidmoly': return 250
    case 'voe': return afterManualPlay ? 800 : 400
    case 'gscdn':
    case 'lulustream':
      return 550
    default:
      return 400
  }
}

function familyBonus(fam, hlsUrl) {
  const lower = hlsUrl.toLowerCase()
  switch (fam) {
    case 'voe': return /voe|cloudwindow|master\.m3u8/.test(lower) ? 20 : 0
    case 'uqload': return lower.includes('uqload') ? 15 : 0
    case 'lulustream': return /lulustream|luluvdo|luluvid/.test(lower) ? 15 : 0
    case 'vidmoly': return isHls(hlsUrl) ? 20 : 0
    case 'gscdn': return /goodstream|gscdn/.test(lower) ? 20 : 0
    default: return 0
  }
}

/* ---------- HlsJsHooks ---------- */

// Se instala antes que los scripts del embed en todos sus frames. Guarda console.debug al inicio
// porque muchos embeds lo anulan para dificultar la depuración.
const PAGE_HOOKS = `(() => {
  if (window.__lzplayHooks) return
  window.__lzplayHooks = true
  const send = console.debug.bind(console)
  try { Object.defineProperty(navigator, 'webdriver', { get: () => false }) } catch (e) {}

  // Sin ventanas nuevas: setSupportMultipleWindows(false) de Plix.
  try {
    window.open = function () {
      return { closed: false, focus() {}, blur() {}, close() {}, postMessage() {}, document: { write() {}, close() {} }, location: { href: '' } }
    }
  } catch (e) {}

  function norm(u) { try { u = (u || '').toString().replace(/\\\\\\//g, '/'); try { u = decodeURIComponent(u) } catch (e) {} return u } catch (e) { return u || '' } }
  function abs(u) { try { return new URL(norm(u), location.href).href } catch (e) { return norm(u) || '' } }
  function isStream(u) {
    u = norm(u).toLowerCase()
    if (!u || u.indexOf('init-') >= 0 || u.indexOf('fragment-') >= 0 || u.indexOf('.m4s') >= 0) return false
    if (u.indexOf('betwinner') >= 0 || u.indexOf('amd-cdn-') >= 0) return false
    if (u.indexOf('/content/stream/agl/') >= 0 && u.indexOf('.mp4') >= 0) return false
    if (/test-videos\\.co\\.uk|sample-videos\\.com|samplelib\\.com|gtv-videos-bucket|big_?buck_?bunny/.test(u)) return false
    if (u.indexOf('.m3u8') >= 0 || u.indexOf('%2em3u8') >= 0 || u.indexOf('/m3u8') >= 0 || u.indexOf('m3u8?') >= 0) return true
    if (/\\/hls\\d*\\/.+\\/(master|index)[^/]*\\.txt/.test(u)) return true
    if (/\\.mpd(\\?|#|$)/.test(u)) return true
    if (u.indexOf('.mp4') >= 0) return true
    return (u.indexOf('/hls/') >= 0 || u.indexOf('/hls2/') >= 0) && (u.indexOf('playlist') >= 0 || u.indexOf('master') >= 0 || u.indexOf('index') >= 0)
  }
  function report(u) { u = abs(u); if (!u || !isStream(u)) return; try { send('${REPORT_PREFIX}' + location.href + '||' + u) } catch (e) {} }
  function scan() {
    try {
      document.querySelectorAll('video,source,a,iframe,script,link').forEach(el => {
        const c = el.src || el.href || ''
        if (c) report(c)
        if (el.tagName === 'VIDEO') { try { if (el.currentSrc) report(el.currentSrc) } catch (e) {} }
        if (el.tagName === 'SCRIPT' && el.textContent) {
          const t = norm(el.textContent)
          ;(t.match(/https?:[\\/\\\\]{2}[^\\s"'<>]+?(?:\\.m3u8|\\/m3u8|m3u8\\?|\\.mp4)(?:[^\\s"'<>]*)?/gi) || []).forEach(report)
        }
      })
      if (window.performance && performance.getEntriesByType) performance.getEntriesByType('resource').forEach(e => report(e && e.name))
    } catch (e) {}
  }
  const of = window.fetch
  if (of) window.fetch = function (input) { try { report(typeof input === 'string' ? input : input && input.url) } catch (e) {} return of.apply(this, arguments) }
  if (window.XMLHttpRequest && XMLHttpRequest.prototype) {
    const ox = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (method, url) { try { report(url) } catch (e) {} return ox.apply(this, arguments) }
  }
  function hookHls() {
    try {
      const H = window.Hls
      if (!H || !H.prototype || H.prototype.__lzplayHooked) return
      H.prototype.__lzplayHooked = true
      const old = H.prototype.loadSource
      H.prototype.loadSource = function (u) { try { report(u) } catch (e) {} return old.apply(this, arguments) }
    } catch (e) {}
  }

  // FORCE_PLAY: play silenciado y toques en los botones de reproducir del embed.
  function ev(el, t) { try { el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })) } catch (e) {} }
  function tap(el) { try { if (!el) return; ev(el, 'pointerdown'); ev(el, 'mousedown'); ev(el, 'mouseup'); ev(el, 'click') } catch (e) {} }
  function forcePlay() {
    // En el paso humano los toques automáticos pulsarían el captcha por la persona.
    if (window.__lzplayCaptured || window.__lzplayManual) return
    try {
      document.querySelectorAll('video').forEach(v => {
        try { v.muted = true; v.autoplay = true; v.playsInline = true; const p = v.play && v.play(); if (p && p.catch) p.catch(() => {}) } catch (e) {}
      })
      document.querySelectorAll('.jw-icon-playback,.vjs-big-play-button,button,[class*=play],.plyr__control--overlaid').forEach(tap)
    } catch (e) {}
  }

  hookHls(); setInterval(hookHls, 400)
  setInterval(scan, 700)
  setInterval(forcePlay, 900)
  document.addEventListener('DOMContentLoaded', () => { scan(); forcePlay() })
})()`

// HlsJsHooks.MUTE (silenceAndPause): se llama en cuanto se entrega el HLS.
const MUTE = `(() => {
  window.__lzplayCaptured = true
  try { document.querySelectorAll('video').forEach(v => { try { v.muted = true; v.pause() } catch (e) {} }) } catch (e) {}
})()`

function wrapperHtml(embedUrl) {
  const src = embedUrl.replace(/"/g, '&quot;')
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}' +
    'iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}</style></head><body>' +
    `<iframe src="${src}" allow="autoplay; fullscreen; encrypted-media" allowfullscreen></iframe></body></html>`
}

/* ---------- Chrome oculto ---------- */

let browserPromise = null
let idleTimer = null
let activeCaptures = 0
const sessions = new Map()
const cookieJar = new Map()

function browserPath() {
  return BROWSER_PATHS.find(candidate => candidate && fs.existsSync(candidate)) ?? null
}

function available() {
  return Boolean(puppeteer && browserPath())
}

async function closePopup(target) {
  if (target.type() !== 'page' || !target.opener()) return
  const page = await target.page().catch(() => null)
  page?.close().catch(() => {})
}

function getBrowser() {
  clearTimeout(idleTimer)
  browserPromise ??= puppeteer.launch({
    executablePath: browserPath(),
    headless: true,
    timeout: 60_000,
    defaultViewport: VIEWPORT,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      // Todo el embed en un solo proceso: los hooks y la intercepción alcanzan a sus iframes.
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials',
      '--disable-blink-features=AutomationControlled',
      '--disable-popup-blocking',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`
    ]
  }).then(browser => {
    browser.on('targetcreated', closePopup)
    browser.on('disconnected', () => { browserPromise = null })
    return browser
  }).catch(error => {
    browserPromise = null
    throw error
  })
  return browserPromise
}

function scheduleBrowserIdle() {
  clearTimeout(idleTimer)
  if (activeCaptures > 0 || sessions.size > 0) return
  idleTimer = setTimeout(async () => {
    const browser = await browserPromise?.catch(() => null)
    browserPromise = null
    browser?.close().catch(() => {})
  }, BROWSER_IDLE_MS)
}

async function destroy(session) {
  if (!session || session.closed) return
  session.closed = true
  clearTimeout(session.ttlTimer)
  sessions.delete(session.id)
  await session.context.close().catch(() => {})
  scheduleBrowserIdle()
}

/** destroyWebView(): el reproductor ya reproduce y el embed oculto sobra. */
function release(id) {
  return destroy(sessions.get(id))
}

function cookiesFor(id) {
  const entry = cookieJar.get(id)
  if (!entry) return ''
  if (Date.now() > entry.expires) {
    cookieJar.delete(id)
    return ''
  }
  return entry.value
}

function eachFrame(page, script) {
  for (const frame of page.frames()) frame.evaluate(script).catch(() => {})
}

async function cookieHeader(page, url) {
  const cookies = await page.cookies(url).catch(() => [])
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

async function validate(candidate, page, userAgent) {
  const headers = { 'User-Agent': userAgent, Accept: '*/*' }
  if (candidate.referer) {
    headers.Referer = candidate.referer
    try { headers.Origin = new URL(candidate.referer).origin } catch {}
  }
  const cookie = await cookieHeader(page, candidate.url)
  if (cookie) headers.Cookie = cookie
  const type = candidate.type ?? streamType(candidate.url)
  if (type === 'mp4') headers.Range = 'bytes=0-1'
  try {
    const response = await fetch(candidate.url, { headers, signal: AbortSignal.timeout(15000) })
    if (!response.ok) return false
    if (type === 'mp4') {
      response.body?.cancel().catch(() => {})
      return !/text\/html/i.test(response.headers.get('content-type') ?? '')
    }
    const text = await response.text()
    return type === 'dash' ? /<MPD[\s>]/.test(text.slice(0, 1024)) : text.trimStart().startsWith('#EXTM3U')
  } catch {
    return false
  }
}

/**
 * Resuelve { url, type, referer, session } o null si el embed no entrega un stream a tiempo.
 * `signal` cancela la captura (el usuario cambió de servidor o salió).
 */
async function capture(embedUrl, { signal, userAgent, label = '', human = null } = {}) {
  if (!available() || signal?.aborted) return null
  if (!human && requiresHumanStep(embedUrl, label)) return null
  const browser = await getBrowser().catch(error => {
    console.warn('No se pudo abrir el navegador oculto:', error.message)
    return null
  })
  if (!browser || signal?.aborted) return null

  activeCaptures++
  const fam = familyOf(embedUrl, label)
  const context = await browser.createBrowserContext()
  const session = { id: crypto.randomUUID(), context, closed: false, ttlTimer: null }
  const page = await context.newPage()
  // Toda pestaña o popup que abra el embed queda en segundo plano (nunca se muestra) y se destruye.
  context.on('targetcreated', target => {
    if (target.type() !== 'page' || target === page.target()) return
    debug('popup destruido', target.url().slice(0, 120))
    target.page().then(popup => popup?.close()).catch(() => {})
  })
  let screencast = null

  return new Promise(resolve => {
    const rejected = new Set()
    let candidate = null
    let validating = false
    let timedOut = false
    let done = false
    let settleTimer = null
    let clickTimer = null
    let timeoutTimer = null

    const finish = async result => {
      if (done) return
      done = true
      clearTimeout(settleTimer)
      clearTimeout(timeoutTimer)
      clearInterval(clickTimer)
      signal?.removeEventListener('abort', onAbort)
      activeCaptures--
      if (human) human.page = null
      if (screencast) {
        screencast.send('Page.stopScreencast').catch(() => {})
        screencast.detach().catch(() => {})
      }

      if (!result) {
        await destroy(session)
        resolve(null)
        return
      }
      eachFrame(page, MUTE)
      cookieJar.set(session.id, { value: await cookieHeader(page, result.url), expires: Date.now() + COOKIE_TTL_MS })
      sessions.set(session.id, session)
      // Si el reproductor nunca confirma, la sesión oculta se destruye sola.
      session.ttlTimer = setTimeout(() => release(session.id), SESSION_TTL_MS)
      resolve({ ...result, session: session.id })
    }

    const onAbort = () => finish(null)
    signal?.addEventListener('abort', onAbort, { once: true })

    const flush = async () => {
      settleTimer = null
      if (done || validating || !candidate) return
      const current = candidate
      validating = true
      const valid = await validate(current, page, userAgent)
      validating = false
      debug(valid ? 'válido' : 'rechazado', current.url.slice(0, 160), 'referer', current.referer?.slice(0, 80))
      if (done) return
      if (valid) {
        finish({ url: current.url, type: current.type ?? streamType(current.url), referer: current.referer })
        return
      }
      rejected.add(current.url)
      if (candidate === current) candidate = null
      if (candidate) flush()
      else if (timedOut) finish(null)
    }

    // considerCandidate(): se queda con la mejor playlist y espera a que se asiente antes de validar.
    // `kind` llega cuando la respuesta ya se identificó como playlist ('hls') o manifiesto ('dash').
    const consider = (rawUrl, referer, kind = null) => {
      if (done) return
      let url = normalize(rawUrl)
      const isPlaylist = Boolean(kind)
      if (!isHttp(url) || isEnhancedJunk(url) || isSegment(url) || rejected.has(url)) return
      if (!isPlaylist && !acceptsStream(fam, url)) {
        const fromText = extractFromText(url)
        if (!fromText || isEnhancedJunk(fromText) || !acceptsStream(fam, fromText) || rejected.has(fromText)) return
        url = fromText
      }
      let score = playlistQualityScore(url) + familyBonus(fam, url)
      if (isPlaylist) score = Math.max(score, 60)
      if (score < 20 || (candidate && score < candidate.score)) return
      const usableReferer = isHttp(referer) && !referer.startsWith(WRAPPER_URL) ? referer : null
      candidate = { url, score, type: kind ?? streamType(url), referer: usableReferer ?? candidate?.referer ?? embedUrl }
      debug('candidato', score, human && !human.touched ? '(pendiente del toque)' : '', url.slice(0, 160))
      // waitingManualPlay de Plix: lo que aparezca antes del primer toque de la persona queda pendiente.
      if (validating || (human && !human.touched)) return
      clearTimeout(settleTimer)
      settleTimer = setTimeout(flush, settleDelayMs(fam, Boolean(human)))
    }

    if (human) {
      human.onTouch = () => {
        if (done || validating || !candidate) return
        clearTimeout(settleTimer)
        settleTimer = setTimeout(flush, settleDelayMs(fam, true))
      }
    }

    ;(async () => {
      await page.setUserAgent(userAgent)
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-ES,es;q=0.9' })
      if (human) await page.evaluateOnNewDocument('window.__lzplayManual = true')
      await page.evaluateOnNewDocument(PAGE_HOOKS)
      await page.setRequestInterception(true)

      page.on('request', request => {
        const url = request.url()
        if (url === WRAPPER_URL) {
          request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: wrapperHtml(embedUrl) }).catch(() => {})
          return
        }
        // Anuncios: peticiones basura fuera y la página principal no se deja reemplazar.
        if (isJunk(url) || (request.isNavigationRequest() && request.frame() === page.mainFrame())) {
          debug('bloqueado', request.resourceType(), url.slice(0, 120))
          request.abort('blockedbyclient').catch(() => {})
          return
        }
        if (request.isNavigationRequest()) debug('navega', url.slice(0, 120))
        else if (/xhr|fetch|media/.test(request.resourceType())) debug(request.resourceType(), url.slice(0, 120))
        consider(url, request.headers().referer ?? request.frame()?.url())
        request.continue().catch(() => {})
      })

      page.on('response', response => {
        const type = response.headers()['content-type'] ?? ''
        if (DEBUG && response.request().isNavigationRequest()) {
          debug('respuesta', response.status(), response.request().method(), type.split(';')[0], response.url().slice(0, 120))
        } else if (DEBUG && /video|mpegurl|octet-stream/i.test(type)) {
          debug('medio', response.status(), type.split(';')[0], response.url().slice(0, 160))
        }
        const kind = /mpegurl/i.test(type) ? 'hls' : /dash\+xml/i.test(type) ? 'dash' : null
        if (kind && acceptsKind(fam, kind)) {
          consider(response.url(), response.request().headers().referer ?? response.frame()?.url(), kind)
        }
      })

      page.on('console', message => {
        const text = message.text()
        if (!text.startsWith(REPORT_PREFIX)) return
        const payload = text.slice(REPORT_PREFIX.length)
        const separator = payload.indexOf('||')
        consider(payload.slice(separator + 2), payload.slice(0, separator))
      })

      timeoutTimer = setTimeout(async () => {
        if (DEBUG) {
          await page.screenshot({ path: `captura-${fam}.png` }).catch(() => {})
          debug('frames', page.frames().map(frame => frame.url().slice(0, 100)))
        }
        if (done) return
        timedOut = true
        if (validating) return
        if (candidate) flush()
        else finish(null)
      }, human ? HUMAN_TIMEOUT_MS : captureTimeoutMs(fam))

      if (human) {
        // La tarjeta del paso humano: la web ve esta página en vivo y le reenvía clics y teclas.
        screencast = await page.createCDPSession()
        screencast.on('Page.screencastFrame', ({ data, sessionId }) => {
          screencast.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
          human.frame = data
          human.emitter.emit('frame', data)
        })
        await screencast.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height })
        human.page = page
      }

      await page.goto(WRAPPER_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
      if (human) return
      // Toque real en el centro, como el usuario sobre el reproductor del embed.
      clickTimer = setInterval(() => {
        if (!done) page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2).catch(() => {})
      }, CLICK_INTERVAL_MS)
    })().catch(error => {
      console.warn('Captura oculta fallida:', error.message)
      finish(null)
    })
  })
}

/* ---------- HumanCheckDialog ---------- */

const humanChecks = new Map()

/**
 * Paso humano: abre el embed en el Chrome oculto, emite sus fotogramas ('frame') y espera a que la
 * persona resuelva el captcha y pulse Play. Emite 'ready' con el stream o 'failed'.
 */
function startHuman(embedUrl, { userAgent, label = '' } = {}) {
  if (!available()) return null
  const check = {
    id: crypto.randomUUID(),
    emitter: new EventEmitter(),
    controller: new AbortController(),
    page: null,
    frame: null,
    state: 'loading',
    result: null,
    touched: false,
    onTouch: null
  }
  check.emitter.setMaxListeners(20)
  humanChecks.set(check.id, check)
  capture(embedUrl, { signal: check.controller.signal, userAgent, label, human: check }).then(result => {
    check.state = result ? 'ready' : 'failed'
    check.result = result
    check.frame = null
    check.emitter.emit(check.state, result)
    setTimeout(() => humanChecks.delete(check.id), HUMAN_LINGER_MS)
  })
  return check.id
}

function humanCheck(id) {
  return humanChecks.get(id) ?? null
}

function cancelHuman(id) {
  const check = humanChecks.get(id)
  if (!check) return
  check.controller.abort()
  humanChecks.delete(id)
}

const clamp01 = value => Math.min(Math.max(Number(value) || 0, 0), 1)
const MOUSE_BUTTONS = ['left', 'middle', 'right']

/** Reenvía al embed un evento de la tarjeta; x e y llegan normalizados entre 0 y 1. */
async function humanInput(id, event) {
  const check = humanChecks.get(id)
  const page = check?.page
  if (!page || !event) return
  if (event.type === 'down' && !check.touched) {
    check.touched = true
    check.onTouch?.()
  }
  const x = clamp01(event.x) * VIEWPORT.width
  const y = clamp01(event.y) * VIEWPORT.height
  const button = MOUSE_BUTTONS.includes(event.button) ? event.button : 'left'
  try {
    switch (event.type) {
      case 'move':
        await page.mouse.move(x, y)
        break
      case 'down':
        await page.mouse.move(x, y)
        await page.mouse.down({ button })
        break
      case 'up':
        await page.mouse.move(x, y)
        await page.mouse.up({ button })
        break
      case 'wheel':
        await page.mouse.move(x, y)
        await page.mouse.wheel({ deltaX: Number(event.deltaX) || 0, deltaY: Number(event.deltaY) || 0 })
        break
      case 'key':
        if (typeof event.key === 'string' && event.key) await page.keyboard.press(event.key)
        break
      case 'text':
        if (typeof event.text === 'string' && event.text) await page.keyboard.type(event.text.slice(0, 200))
        break
    }
  } catch (error) {
    debug('entrada rechazada', event.type, error.message)
  }
}

module.exports = { available, requiresHumanStep, capture, release, cookiesFor, startHuman, humanCheck, cancelHuman, humanInput }
