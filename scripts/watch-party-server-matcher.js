const WatchPartyServerMatcher = (() => {
  const STRENGTH_URL = 100
  const STRENGTH_VIDEO_ID = 90
  const STRENGTH_NAME_LANG = 80
  const STRENGTH_NAME = 70
  const STRENGTH_PROVIDER_LANG = 60
  const STRENGTH_PROVIDER = 45
  const STRENGTH_SOFT = 35

  function normalize(value) {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
  }

  function normalizeUrl(url) {
    if (!url) return ''
    try {
      const uri = new URL(url.trim())
      let path = uri.pathname || ''
      while (path.endsWith('/') && path.length > 1) path = path.slice(0, -1)
      path = path.replace('/embed/', '/v/')
      const host = (uri.hostname || '').toLowerCase().replace(/^www\./, '')
      return `${(uri.protocol || 'https:').replace(/:$/, '')}://${host}${path}`
    } catch {
      return String(url).trim().toLowerCase()
    }
  }

  function videoId(url) {
    if (!url) return ''
    try {
      const path = new URL(url.trim()).pathname || ''
      const parts = path.split('/')
      for (let i = parts.length - 1; i >= 0; i--) {
        let part = parts[i]
        if (!part) continue
        const lower = part.toLowerCase()
        if (['embed', 'v', 'e', 'f', 'd'].includes(lower)) continue
        const dot = part.lastIndexOf('.')
        if (dot > 0 && part.length - dot <= 5) part = part.slice(0, dot)
        if (part.length >= 4) return part.toLowerCase()
      }
    } catch { /* ignore */ }
    return ''
  }

  function coreName(value) {
    let n = normalize(value)
    if (!n) return ''
    n = n
      .replace(/latino|castellano|subtitulado|subtitulos|subtitles|english|ingles|espanol| dual/g, ' ')
      .replace(/[-_]/g, ' ')
    return normalize(n)
  }

  function providerKey(url, name) {
    let fromUrl = ''
    try {
      if (url) fromUrl = normalize(new URL(url).hostname.replace(/^www\./, '').split('.')[0])
    } catch { /* ignore */ }
    const fromName = coreName(name)
    let key = fromUrl || fromName
    if (!key) return ''
    if (/streamwish|swish|^sw$/.test(key)) return 'streamwish'
    if (/vidhide|minochinos|filelions|filemoon/.test(key)) return 'vidhide'
    if (/goodstream|gscdn/.test(key)) return 'goodstream'
    if (/vimeos/.test(key)) return 'vimeos'
    if (/primeload|primecdn/.test(key)) return 'primeload'
    if (/abyss|hydrax/.test(key)) return 'abyss'
    if (/ok\.ru|odnoklassniki|^ok$/.test(key)) return 'okru'
    if (/uqload/.test(key)) return 'uqload'
    if (/voe/.test(key)) return 'voe'
    if (/nupload/.test(key)) return 'nupload'
    return key
  }

  function normalizeLanguage(language, name) {
    const lang = normalize(language)
    if (lang) return lang
    const n = normalize(name)
    if (!n) return ''
    if (n.includes('latino')) return 'latino'
    if (n.includes('castellano')) return 'castellano'
    if (n.includes('subtit')) return 'subtitulado'
    if (/english|ingles/.test(n)) return 'english'
    return ''
  }

  function languageAliases(a, b) {
    const latino = v => /latino|^lat$|espanol latino/.test(v)
    const cast = v => /castellano|espanol|^es$|spain/.test(v)
    const sub = v => /subtit|sub | sub$|^sub$|subs/.test(v)
    const en = v => /english|ingles|^en$|vo /.test(v)
    return (latino(a) && latino(b)) || (cast(a) && cast(b)) || (sub(a) && sub(b)) || (en(a) && en(b))
  }

  function languagesMatch(wantLang, serverLanguage, serverName) {
    if (!wantLang) return true
    const lang = normalizeLanguage(serverLanguage, serverName)
    if (!lang) return normalize(serverName).includes(wantLang)
    return wantLang === lang || wantLang.includes(lang) || lang.includes(wantLang) || languageAliases(wantLang, lang)
  }

  function namesEqual(wantName, serverName) {
    const name = normalize(serverName)
    if (!name) return false
    return wantName === name || coreName(wantName) === coreName(name)
  }

  function providersRelated(a, b) {
    if (!a || !b) return false
    return a === b || a.includes(b) || b.includes(a)
  }

  function match(servers, preferredName, preferredLanguage, preferredUrl) {
    if (!servers?.length) return { index: -1, strength: 0, isStrong: false, isUsable: false }

    const wantUrl = normalizeUrl(preferredUrl)
    const wantId = videoId(preferredUrl)
    const wantProvider = providerKey(preferredUrl, preferredName)
    const wantName = normalize(preferredName)
    const wantLang = normalizeLanguage(preferredLanguage, preferredName)

    const result = (index, strength) => ({
      index,
      strength,
      isStrong: strength >= STRENGTH_VIDEO_ID,
      isUsable: index >= 0 && strength >= STRENGTH_SOFT
    })

    if (wantUrl) {
      for (let i = 0; i < servers.length; i++) {
        if (wantUrl === normalizeUrl(servers[i]?.url)) return result(i, STRENGTH_URL)
      }
    }

    if (wantId) {
      for (let i = 0; i < servers.length; i++) {
        const server = servers[i]
        if (!server || wantId !== videoId(server.url)) continue
        const provider = providerKey(server.url, server.name)
        if (!wantProvider || !provider || wantProvider === provider || providersRelated(wantProvider, provider)) {
          return result(i, STRENGTH_VIDEO_ID)
        }
      }
      for (let i = 0; i < servers.length; i++) {
        if (wantId === videoId(servers[i]?.url)) return result(i, STRENGTH_VIDEO_ID)
      }
    }

    if (wantName && wantLang) {
      for (let i = 0; i < servers.length; i++) {
        const server = servers[i]
        if (server && namesEqual(wantName, server.name) && languagesMatch(wantLang, server.language, server.name)) {
          return result(i, STRENGTH_NAME_LANG)
        }
      }
    }

    if (wantName) {
      for (let i = 0; i < servers.length; i++) {
        if (namesEqual(wantName, servers[i]?.name)) return result(i, STRENGTH_NAME)
      }
      for (let i = 0; i < servers.length; i++) {
        const server = servers[i]
        if (!server?.name) continue
        const name = normalize(server.name)
        if (name.includes(wantName) || wantName.includes(name) || coreName(wantName) === coreName(name)) {
          if (!wantLang || languagesMatch(wantLang, server.language, server.name)) {
            return result(i, STRENGTH_NAME)
          }
        }
      }
    }

    if (wantProvider) {
      let bestLang = -1
      let bestAny = -1
      for (let i = 0; i < servers.length; i++) {
        const server = servers[i]
        if (!server) continue
        const provider = providerKey(server.url, server.name)
        if (!providersRelated(wantProvider, provider)) continue
        if (bestAny < 0) bestAny = i
        if (wantLang && languagesMatch(wantLang, server.language, server.name)) {
          bestLang = i
          break
        }
      }
      if (bestLang >= 0) return result(bestLang, STRENGTH_PROVIDER_LANG)
      if (bestAny >= 0) return result(bestAny, STRENGTH_PROVIDER)
    }

    let bestIndex = -1
    let bestScore = 0
    const wantCore = coreName(wantName)
    for (let i = 0; i < servers.length; i++) {
      const server = servers[i]
      if (!server) continue
      let score = 0
      const provider = providerKey(server.url, server.name)
      const core = coreName(server.name)
      if (wantProvider && providersRelated(wantProvider, provider)) score += 30
      if (wantCore && core) {
        if (wantCore === core) score += 25
        else if (core.includes(wantCore) || wantCore.includes(core)) score += 15
      }
      if (wantLang && languagesMatch(wantLang, server.language, server.name)) score += 20
      if (score > bestScore) {
        bestScore = score
        bestIndex = i
      }
    }
    if (bestIndex >= 0 && bestScore >= STRENGTH_SOFT) return result(bestIndex, STRENGTH_SOFT)
    return result(-1, 0)
  }

  function indexOf(servers, preferredName, preferredLanguage, preferredUrl) {
    const found = match(servers, preferredName, preferredLanguage, preferredUrl)
    return found.isUsable ? found.index : -1
  }

  return { match, indexOf, STRENGTH_SOFT, STRENGTH_VIDEO_ID }
})()
