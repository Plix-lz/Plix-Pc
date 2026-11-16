// Servidor local para PC: sirve la web y extrae el HLS de los embeds (StreamWish, VidHide, Vidmoly…)
// igual que Plix lo captura en el teléfono. Los navegadores no pueden leer esas páginas ni sus
// playlists por CORS y Referer, así que la descarga se hace aquí y el video pasa por /api/hls.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const hiddenCapture = require('./capture')

const PORT = Number(process.env.PORT) || 3000
const ROOT = __dirname
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
const PAGE_TIMEOUT_MS = 15000
const MAX_EMBED_DEPTH = 2
// hglink.to y similares solo redirigen por JS ofuscado a un espejo de StreamWish con el mismo código.
const STREAMWISH_ALIASES = /hglink|streamwish|swish|wishembed|wishfast|playerwish|hgplay|hlswish/i
const STREAMWISH_MIRRORS = ['flaswish.com', 'audinifer.com']
// APIs de servidores sin cabeceras CORS que la web consulta a través de /api/json.
const JSON_PROXY_HOSTS = ['pelixplay.app']

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Access-Control-Allow-Private-Network': 'true'
}

/* ---------- Extracción ---------- */

function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function upstreamHeaders(referer, extra = {}) {
  const headers = { 'User-Agent': USER_AGENT, Accept: '*/*', ...extra }
  if (referer) {
    headers.Referer = referer
    headers.Origin = originOf(referer)
  }
  return headers
}

// Desempaqueta eval(function(p,a,c,k,e,d){…}) de Dean Edwards, que usan StreamWish y VidHide.
function unpack(packed) {
  const match = packed.match(/}\s*\(\s*'([\s\S]*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*?)'\.split\('\|'\)/)
  if (!match) return ''
  let [, payload, base, count, words] = match
  base = Number(base)
  count = Number(count)
  words = words.split('|')
  const encode = n => (n < base ? '' : encode(Math.floor(n / base))) +
    ((n %= base) > 35 ? String.fromCharCode(n + 29) : n.toString(36))
  while (count--) {
    if (words[count]) payload = payload.replace(new RegExp(`\\b${encode(count)}\\b`, 'g'), words[count])
  }
  return payload
}

function readableCode(html) {
  const packed = html.match(/eval\(function\(p,a,c,k,e,[rd]\)[\s\S]*?\.split\('\|'\)[^)]*\)\)/g) ?? []
  return [html, ...packed.map(unpack)].join('\n').replace(/\\\//g, '/')
}

// Videos de prueba públicos que algunos embeds usan como señuelo en lugar del contenido.
const DECOY_VIDEO = /test-videos\.co\.uk|sample-videos\.com|samplelib\.com|gtv-videos-bucket|big_?buck_?bunny/i

function findCandidates(code, pageUrl) {
  const found = []
  const add = (raw, type) => {
    try {
      const url = new URL(raw, pageUrl).href
      if (!DECOY_VIDEO.test(url) && !found.some(item => item.url === url)) found.push({ url, type })
    } catch {}
  }

  for (const [raw] of code.matchAll(/https?:\/\/[^"'\s<>\\]+?\.m3u8(?:\?[^"'\s<>\\]*)?/g)) add(raw, 'hls')
  for (const [raw] of code.matchAll(/https?:\/\/[^"'\s<>\\]+?\/(?:hls\d*|master)[^"'\s<>\\]*?\.txt(?:\?[^"'\s<>\\]*)?/g)) add(raw, 'hls')
  for (const [, raw] of code.matchAll(/["'](\/[^"'\s<>]+?\.m3u8[^"'\s<>]*)["']/g)) add(raw, 'hls')
  for (const [raw] of code.matchAll(/https?:\/\/[^"'\s<>\\]+?\.mp4(?:\?[^"'\s<>\\]*)?/g)) add(raw, 'mp4')
  return found
}

function nextEmbed(html, pageUrl) {
  const redirect = html.match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/)?.[1]
  const iframe = html.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1]
  const target = redirect ?? iframe
  if (!target) return null
  try {
    return new URL(target, pageUrl).href
  } catch {
    return null
  }
}

async function validate(candidate, referer) {
  try {
    const response = await fetch(candidate.url, {
      headers: upstreamHeaders(referer, candidate.type === 'mp4' ? { Range: 'bytes=0-1' } : {}),
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
    })
    if (!response.ok) return false
    if (candidate.type === 'mp4') {
      response.body?.cancel()
      return !/text\/html/i.test(response.headers.get('content-type') ?? '')
    }
    return (await response.text()).trimStart().startsWith('#EXTM3U')
  } catch {
    return false
  }
}

async function extract(embedUrl, depth = 0) {
  const page = await fetch(embedUrl, {
    headers: upstreamHeaders('https://pelixplay.app/', { Accept: 'text/html,*/*' }),
    redirect: 'follow',
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
  })
  if (!page.ok) throw new Error(`El servidor del video respondió ${page.status}.`)

  const html = await page.text()
  const referer = `${originOf(page.url)}/`
  const candidates = findCandidates(readableCode(html), page.url)
    .sort((a, b) => (a.type === b.type ? 0 : a.type === 'hls' ? -1 : 1))

  const checks = await Promise.all(candidates.map(candidate => validate(candidate, referer)))
  const stream = candidates.find((_, index) => checks[index])
  if (stream) return { ...stream, referer }

  const next = depth < MAX_EMBED_DEPTH && nextEmbed(html, page.url)
  if (next && next !== embedUrl) return extract(next, depth + 1)
  return null
}

function mirrorsFor(embedUrl) {
  const url = new URL(embedUrl)
  if (!STREAMWISH_ALIASES.test(url.hostname)) return []
  return STREAMWISH_MIRRORS
    .filter(host => host !== url.hostname)
    .map(host => `https://${host}${url.pathname}${url.search}`)
}

async function extractWithMirrors(embedUrl) {
  const direct = await extract(embedUrl).catch(() => null)
  if (direct) return direct
  for (const mirror of mirrorsFor(embedUrl)) {
    const stream = await extract(mirror).catch(() => null)
    if (stream) return stream
  }
  return null
}

/* ---------- OK.ru ---------- */

const OKRU_VIDEO = /^https?:\/\/(?:www\.|m\.|mobile\.)?(?:ok|odnoklassniki)\.ru\/(?:video|videoembed)\/(\d+)/i
const OKRU_REFERER = 'https://ok.ru/'
const OKRU_QUALITIES = ['ultra', 'quad', 'full', 'hd', 'sd', 'low', 'lowest', 'mobile']

function htmlUnescape(value) {
  return value
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;|&#38;/g, '&')
}

function okRuMetadata(html) {
  const options = html.match(/data-options="([^"]+)"/)?.[1]
  if (!options) return null
  try {
    const root = JSON.parse(htmlUnescape(options))
    const flashvars = root.flashvars ?? (root.metadata ? root : null)
    const metadata = flashvars?.metadata
    return typeof metadata === 'string' ? JSON.parse(metadata) : metadata ?? null
  } catch {
    return null
  }
}

// Como OkRuExtractor de Plix: el videoembed trae en data-options → flashvars.metadata las URLs firmadas
// del CDN. Plix toma el MPD (DASH) porque ExoPlayer lo reproduce; en la web se usa el HLS del mismo bloque
// y, si falta, los MP4 por calidad. Las firmas van ligadas a la IP, por eso todo pasa por este servidor.
async function extractOkRu(embedUrl) {
  const id = embedUrl.match(OKRU_VIDEO)?.[1]
  if (!id) return null
  const page = await fetch(`https://ok.ru/videoembed/${id}`, {
    headers: upstreamHeaders(OKRU_REFERER, { Accept: 'text/html,application/xhtml+xml,*/*' }),
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
  })
  if (!page.ok) return null
  const metadata = okRuMetadata(await page.text())
  if (!metadata) return null

  const candidates = [metadata.hlsManifestUrl, metadata.hlsMasterPlaylistUrl, metadata.ondemandHls]
    .filter(isHttpUrl)
    .map(url => ({ type: 'hls', url }))
  const rank = name => {
    const index = OKRU_QUALITIES.indexOf(String(name).toLowerCase())
    return index === -1 ? OKRU_QUALITIES.length : index
  }
  ;(metadata.videos ?? [])
    .filter(video => isHttpUrl(video?.url))
    .sort((a, b) => rank(a.name) - rank(b.name))
    .forEach(video => candidates.push({ type: 'mp4', url: video.url }))

  for (const candidate of candidates) {
    if (await validate(candidate, OKRU_REFERER)) return { ...candidate, referer: OKRU_REFERER }
  }
  return null
}

// Como Plix: el embed se abre en el navegador oculto mientras, en paralelo, se lee su HTML.
// Gana el primero que entregue un stream válido y el otro se cancela.
async function resolveEmbed(embedUrl, signal) {
  // OK.ru tiene su propia sesión aislada, igual que en Plix; el navegador oculto solo entra si falla.
  if (OKRU_VIDEO.test(embedUrl)) {
    const stream = await extractOkRu(embedUrl).catch(() => null)
    if (stream || signal.aborted) return stream
  }
  return raceEmbed(embedUrl, signal)
}

function raceEmbed(embedUrl, signal) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal.addEventListener('abort', cancel, { once: true })

  const direct = extractWithMirrors(embedUrl).catch(() => null)
  const hidden = hiddenCapture.capture(embedUrl, { signal: controller.signal, userAgent: USER_AGENT }).catch(() => null)

  return new Promise(resolve => {
    let pending = 2
    let winner = null
    const settle = stream => {
      if (stream && !winner) {
        winner = stream
        controller.abort()
        resolve(stream)
      } else if (stream?.session && stream !== winner) {
        hiddenCapture.release(stream.session)
      }
      if (--pending === 0) {
        signal.removeEventListener('abort', cancel)
        if (!winner) resolve(null)
      }
    }
    direct.then(settle)
    hidden.then(settle)
  })
}

/* ---------- Proxy HLS ---------- */

function proxiedUrl(url, referer, session = '') {
  return `/api/hls?url=${encodeURIComponent(url)}&ref=${encodeURIComponent(referer)}${session ? `&sid=${session}` : ''}`
}

function rewritePlaylist(text, playlistUrl, referer, session) {
  const absolute = uri => proxiedUrl(new URL(uri, playlistUrl).href, referer, session)
  return text
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (trimmed.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${absolute(uri)}"`)
      return absolute(trimmed)
    })
    .join('\n')
}

const xmlUnescape = value => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const xmlEscape = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// DASH (PowVideo y otros CDN pkcdn): las URLs del MPD pasan por el proxy conservando las plantillas
// $Number$, $RepresentationID$… para que dash.js las sustituya. Como hace ExoPlayer en Plix.
function rewriteMpd(text, mpdUrl, referer, session) {
  const baseText = text.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i)?.[1]
  const base = baseText ? new URL(xmlUnescape(baseText.trim()), mpdUrl).href : mpdUrl
  const proxy = raw => {
    const absolute = new URL(xmlUnescape(raw), base).href
    const proxied = proxiedUrl(absolute, referer, session).replace(/%24([A-Za-z]+(?:%25\d*[dxX])?)%24/g, (_, token) => `$${decodeURIComponent(token)}$`)
    return xmlEscape(proxied)
  }
  return text
    .replace(/<BaseURL[^>]*>[^<]*<\/BaseURL>/gi, '')
    .replace(/\b(media|initialization|sourceURL|href)="([^"]+)"/g, (_, name, value) => `${name}="${proxy(value)}"`)
}

const isMpd = buffer => /<MPD[\s>]/.test(buffer.subarray(0, 1024).toString('utf8'))

const HLS_ATTEMPTS = 3
const HLS_HEADERS_TIMEOUT_MS = 20000
const HLS_BODY_TIMEOUT_MS = 45000
// Playlists y segmentos se descargan completos; un MP4 entero o un rango grande se transmite.
const HLS_MAX_BUFFER_BYTES = 40 * 1024 * 1024
const HLS_RANGE_BUFFER_BYTES = 1024 * 1024
const TS_PACKET = 188
const IMAGE_SIGNATURES = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from('GIF8'),
  Buffer.from('BM')
]

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// Reintenta caídas de red y respuestas 5xx del CDN; el plazo cubre solo hasta recibir las cabeceras.
async function fetchUpstream(url, headers) {
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HLS_HEADERS_TIMEOUT_MS)
    try {
      const upstream = await fetch(url, { headers, signal: controller.signal })
      if (upstream.status >= 500 && attempt < HLS_ATTEMPTS) {
        upstream.body?.cancel().catch(() => {})
        await delay(attempt * 600)
        continue
      }
      return { upstream, controller }
    } catch (error) {
      if (attempt >= HLS_ATTEMPTS) throw error
      await delay(attempt * 600)
    } finally {
      clearTimeout(timer)
    }
  }
}

async function readBody(upstream, controller) {
  const timer = setTimeout(() => controller.abort(), HLS_BODY_TIMEOUT_MS)
  try {
    return Buffer.from(await upstream.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

// Algunos CDN de StreamWish anteponen una imagen falsa (PNG/JPEG) a cada segmento .ts para
// esquivar filtros; hls.js no puede leerlos, así que se recorta hasta el primer paquete TS real.
function stripFakeImage(buffer) {
  if (!IMAGE_SIGNATURES.some(signature => buffer.subarray(0, signature.length).equals(signature))) return null
  const limit = Math.min(buffer.length - TS_PACKET * 2, 64 * 1024)
  for (let index = 1; index < limit; index++) {
    if (buffer[index] === 0x47 && buffer[index + TS_PACKET] === 0x47 && buffer[index + TS_PACKET * 2] === 0x47) {
      return buffer.subarray(index)
    }
  }
  return null
}

function copyHeaders(upstream, names) {
  const headers = { ...CORS_HEADERS }
  for (const name of names) {
    const value = upstream.headers.get(name)
    if (value) headers[name] = value
  }
  return headers
}

async function proxyHls(request, response, url, referer, session) {
  const range = request.headers.range
  // Los streams capturados en el navegador oculto pueden exigir sus cookies (tokens de sesión).
  const cookie = session ? hiddenCapture.cookiesFor(session) : ''
  const headers = upstreamHeaders(referer, { ...(range ? { Range: range } : {}), ...(cookie ? { Cookie: cookie } : {}) })

  for (let attempt = 1; ; attempt++) {
    const { upstream, controller } = await fetchUpstream(url, headers)
    const size = Number(upstream.headers.get('content-length')) || 0
    // El HLS nativo de Chrome pide la playlist con Range: si es pequeña se lee igual para reescribirla.
    const smallRange = range && size > 0 && size <= HLS_RANGE_BUFFER_BYTES
    if ((range && !smallRange) || size > HLS_MAX_BUFFER_BYTES) {
      streamUpstream(response, upstream, controller)
      return
    }

    let body
    try {
      body = await readBody(upstream, controller)
    } catch (error) {
      // El CDN cortó la descarga a medias: se pide de nuevo antes de responder al reproductor.
      if (attempt >= HLS_ATTEMPTS) throw error
      await delay(attempt * 600)
      continue
    }

    // Algunos CDN disfrazan las playlists de .txt o text/html: se detectan por su contenido.
    if (upstream.ok && body.subarray(0, 64).toString('utf8').trimStart().startsWith('#EXTM3U')) {
      const playlist = rewritePlaylist(body.toString('utf8'), upstream.url || url, referer, session)
      response.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' })
      response.end(playlist)
      return
    }

    if (upstream.ok && isMpd(body)) {
      const manifest = rewriteMpd(body.toString('utf8'), upstream.url || url, referer, session)
      response.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/dash+xml', 'Cache-Control': 'no-store' })
      response.end(manifest)
      return
    }

    const segment = upstream.ok ? stripFakeImage(body) : null
    if (segment) {
      response.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'video/mp2t', 'Content-Length': segment.length })
      response.end(segment)
      return
    }

    const passthrough = copyHeaders(upstream, ['content-type', 'content-range', 'accept-ranges'])
    passthrough['Content-Length'] = body.length
    response.writeHead(upstream.status, passthrough)
    response.end(body)
    return
  }
}

function streamUpstream(response, upstream, controller) {
  response.writeHead(upstream.status, copyHeaders(upstream, ['content-type', 'content-length', 'content-range', 'accept-ranges']))
  if (!upstream.body) {
    response.end()
    return
  }
  Readable.fromWeb(upstream.body).on('error', () => response.destroy()).pipe(response)
  response.on('close', () => controller.abort())
}

/* ---------- Servidor ---------- */

function sendJson(response, status, data) {
  response.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(data))
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value ?? '')
}

function serveStatic(response, pathname) {
  const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
  const file = path.normalize(path.join(ROOT, relative))
  if (!file.startsWith(ROOT) || path.basename(file) === 'server.js') {
    response.writeHead(403).end()
    return
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No encontrado')
      return
    }
    const ext = path.extname(file).toLowerCase()
    const headers = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' }
    if (ext === '.html' || ext === '.js' || ext === '.css') headers['Cache-Control'] = 'no-store'
    response.writeHead(200, headers)
    response.end(data)
  })
}

/* ---------- Paso humano (captcha) ---------- */

function readJson(request, limit = 4096) {
  return new Promise(resolve => {
    let body = ''
    request.on('data', chunk => {
      body += chunk
      if (body.length > limit) request.destroy()
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch {
        resolve(null)
      }
    })
    request.on('error', () => resolve(null))
  })
}

function streamForPlayer(result) {
  return { type: result.type, url: proxiedUrl(result.url, result.referer, result.session), session: result.session ?? null }
}

// Como HumanCheckDialog de Plix: la web muestra el embed (en vivo desde el Chrome oculto), la persona
// resuelve el captcha y pulsa Play, y en cuanto aparece el HLS se entrega al reproductor.
async function handleHuman(request, response, action, searchParams) {
  if (action === 'start') {
    const url = searchParams.get('url')
    if (!isHttpUrl(url)) return sendJson(response, 400, { error: 'URL inválida' })
    const id = hiddenCapture.startHuman(url, { userAgent: USER_AGENT, label: searchParams.get('label') ?? '' })
    if (!id) return sendJson(response, 503, { error: 'Instala Google Chrome o Edge para verificar este servidor.' })
    return sendJson(response, 200, { id })
  }

  const id = searchParams.get('id') ?? ''

  if (action === 'events') {
    const check = hiddenCapture.humanCheck(id)
    if (!check) return sendJson(response, 404, { error: 'La verificación ya terminó.' })
    response.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    const send = (event, data) => response.write(`event: ${event}\ndata: ${data}\n\n`)
    // Si el navegador va atrasado se descartan fotogramas en lugar de acumularlos.
    const onFrame = frame => { if (!response.writableNeedDrain) send('frame', frame) }
    const onReady = result => { send('ready', JSON.stringify(streamForPlayer(result))); response.end() }
    const onFailed = () => { send('failed', '{}'); response.end() }
    if (check.state === 'ready') return onReady(check.result)
    if (check.state === 'failed') return onFailed()
    if (check.frame) send('frame', check.frame)
    check.emitter.on('frame', onFrame)
    check.emitter.once('ready', onReady)
    check.emitter.once('failed', onFailed)
    response.on('close', () => {
      check.emitter.off('frame', onFrame)
      check.emitter.off('ready', onReady)
      check.emitter.off('failed', onFailed)
    })
    return
  }

  if (action === 'input' && request.method === 'POST') {
    const event = await readJson(request)
    await hiddenCapture.humanInput(id, event)
    response.writeHead(204, CORS_HEADERS).end()
    return
  }

  if (action === 'cancel') {
    hiddenCapture.cancelHuman(id)
    response.writeHead(204, CORS_HEADERS).end()
    return
  }

  sendJson(response, 404, { error: 'Acción desconocida' })
}

const server = http.createServer(async (request, response) => {
  const { pathname, searchParams } = new URL(request.url, `http://${request.headers.host}`)

  if (request.method === 'OPTIONS') {
    response.writeHead(204, { ...CORS_HEADERS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }).end()
    return
  }

  try {
    if (pathname === '/api/health') {
      sendJson(response, 200, { ok: true })
      return
    }

    if (pathname === '/api/extract') {
      const url = searchParams.get('url')
      if (!isHttpUrl(url)) return sendJson(response, 400, { error: 'URL inválida' })
      // Si la web cancela (cambio de servidor o salida), se cierra también el navegador oculto.
      const aborted = new AbortController()
      response.on('close', () => { if (!response.writableEnded) aborted.abort() })
      const stream = await resolveEmbed(url, aborted.signal)
      if (aborted.signal.aborted) {
        if (stream?.session) hiddenCapture.release(stream.session)
        return
      }
      if (!stream) return sendJson(response, 404, { error: 'No se encontró un video reproducible en este servidor.' })
      sendJson(response, 200, streamForPlayer(stream))
      return
    }

    if (pathname.startsWith('/api/human/')) {
      await handleHuman(request, response, pathname.slice('/api/human/'.length), searchParams)
      return
    }

    if (pathname === '/api/capture/release') {
      const session = searchParams.get('session')
      if (session) await hiddenCapture.release(session)
      response.writeHead(204, CORS_HEADERS).end()
      return
    }

    if (pathname === '/api/json') {
      const url = searchParams.get('url')
      if (!isHttpUrl(url) || !JSON_PROXY_HOSTS.includes(new URL(url).hostname)) {
        return sendJson(response, 400, { error: 'URL no permitida' })
      }
      const upstream = await fetch(url, {
        headers: upstreamHeaders('', { Accept: 'application/json,*/*' }),
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
      })
      response.writeHead(upstream.status, {
        ...CORS_HEADERS,
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end(await upstream.text())
      return
    }

    if (pathname === '/api/hls') {
      const url = searchParams.get('url')
      if (!isHttpUrl(url)) return sendJson(response, 400, { error: 'URL inválida' })
      await proxyHls(request, response, url, searchParams.get('ref') ?? '', searchParams.get('sid') ?? '')
      return
    }

    serveStatic(response, pathname)
  } catch (error) {
    if (response.headersSent) response.destroy()
    else sendJson(response, 502, { error: error.message || 'Error al cargar el video' })
  }
})

// La app de escritorio (desktop/main.js) importa este archivo y elige el puerto; solo escucha en
// 127.0.0.1 para que el Firewall de Windows no pida permiso.
function start(port = PORT, host) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

const stop = () => new Promise(resolve => server.close(() => resolve()))

module.exports = { start, stop }

if (require.main === module) {
  start(PORT).then(port => {
    console.log(`LZ Play listo en http://localhost:${port}`)
    if (!hiddenCapture.available()) {
      console.log('Captura oculta desactivada: instala las dependencias (npm install) y Google Chrome o Edge.')
    }
  }).catch(error => {
    console.error(error.message)
    process.exit(1)
  })
}
