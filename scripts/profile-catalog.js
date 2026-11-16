// Catálogo de iconos y backdrops de perfil de Plix (ProfileAvatar/BackdropCatalogRepository):
// se descubren en el repo Plix-lz/img (ICONOS/{carpeta}/{pack}/{id}.ext y BACKDROPS/...).
const profileCatalog = (() => {
  const TREE_URL = 'https://api.github.com/repos/Plix-lz/img/git/trees/main?recursive=1'
  const RAW_BASE = 'https://raw.githubusercontent.com/Plix-lz/img/main/'
  const CACHE_KEY = 'lzplay:catalogo-perfil-v2'
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000
  const ROOTS = { icon: 'ICONOS', backdrop: 'BACKDROPS' }
  const ROOT_PACK = { icon: '_', backdrop: '-' }
  const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i
  const VIDEO_FILE = /\.(mp4|webm|m4v|mov)$/i
  const DEFAULT_AVATAR = 'https://wallpapers.com/images/hd/netflix-profile-pictures-1000-x-1000-88wkdmjrorckekha.jpg'

  let catalog = readCache()
  let request = null

  function readCache() {
    try {
      const saved = JSON.parse(localStorage.getItem(CACHE_KEY))
      return saved?.icon && saved?.backdrop ? saved : null
    } catch {
      return null
    }
  }

  function encodePath(path) {
    return path.split('/').map(encodeURIComponent).join('/')
  }

  function isVideoExtension(extension) {
    return VIDEO_FILE.test(`.${String(extension ?? '').replace(/^\./, '')}`)
  }

  function isVideoUrl(url) {
    if (!url) return false
    const path = String(url).split(/[?#]/)[0]
    return VIDEO_FILE.test(path)
  }

  function isMediaFile(kind, fileName) {
    return IMAGE_FILE.test(fileName) || (kind === 'backdrop' && VIDEO_FILE.test(fileName))
  }

  function mediaPath(kind, folder, pack, id, extension) {
    const root = ROOTS[kind]
    const file = `${id}.${extension}`
    if (pack === ROOT_PACK[kind]) return `${root}/${folder}/${file}`
    return `${root}/${folder}/${pack}/${file}`
  }

  function parse(tree) {
    const grouped = { icon: new Map(), backdrop: new Map() }
    tree.forEach(node => {
      if (node?.type !== 'blob') return
      const parts = String(node.path ?? '').split('/')
      const kind = Object.keys(ROOTS).find(key => ROOTS[key] === parts[0])
      if (!kind) return

      let folder
      let pack
      let fileName
      if (parts.length === 4) {
        ;[, folder, pack, fileName] = parts
      } else if (parts.length === 3) {
        ;[, folder, fileName] = parts
        pack = ROOT_PACK[kind]
      } else {
        return
      }

      if (!isMediaFile(kind, fileName)) return
      const dot = fileName.lastIndexOf('.')
      const id = dot > 0 ? fileName.slice(0, dot) : fileName
      if (!id) return
      const key = `${folder}\u0000${pack}`
      if (!grouped[kind].has(key)) grouped[kind].set(key, { folder, pack, items: [] })
      grouped[kind].get(key).items.push({
        folder,
        pack,
        id,
        extension: dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '',
        imageUrl: RAW_BASE + encodePath(node.path)
      })
    })

    const sections = map => [...map.values()]
      .sort((a, b) => a.folder.localeCompare(b.folder, undefined, { sensitivity: 'base' }) ||
        a.pack.localeCompare(b.pack, undefined, { sensitivity: 'base' }))
      .map(section => ({
        ...section,
        items: section.items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      }))

    return { icon: sections(grouped.icon), backdrop: sections(grouped.backdrop), fetchedAt: Date.now() }
  }

  async function fetchCatalog() {
    const response = await fetch(TREE_URL, { headers: { Accept: 'application/vnd.github+json' } })
    if (!response.ok) throw new Error(`GitHub respondió ${response.status}`)
    const data = await response.json()
    if (!Array.isArray(data.tree)) throw new Error('Catálogo vacío')
    const next = parse(data.tree)
    catalog = next
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(next))
    } catch {
      // Sin espacio: el catálogo queda solo en memoria.
    }
    return next
  }

  /** Secciones {folder, pack, items} del tipo pedido ('icon' o 'backdrop'). */
  async function load(kind, force = false) {
    const fresh = catalog && Date.now() - catalog.fetchedAt < CACHE_TTL_MS
    if (!force && fresh) return catalog[kind]
    request ??= fetchCatalog().finally(() => { request = null })
    try {
      return (await request)[kind]
    } catch (error) {
      if (catalog?.[kind]?.length) return catalog[kind]
      throw error
    }
  }

  function find(kind, selection) {
    return catalog?.[kind]
      ?.find(section => section.folder === selection.folder && section.pack === selection.pack)
      ?.items.find(item => item.id === selection.id) ?? null
  }

  function imageUrl(kind, selection) {
    if (!selection?.folder || !selection.pack || !selection.id) return kind === 'icon' ? DEFAULT_AVATAR : ''
    const item = find(kind, selection)
    if (item) return item.imageUrl
    const extension = (selection.extension || 'jpg').replace('.', '')
    return RAW_BASE + encodePath(mediaPath(kind, selection.folder, selection.pack, selection.id, extension))
  }

  function sameSelection(a, b) {
    return Boolean(a && b) && a.folder === b.folder && a.pack === b.pack && a.id === b.id
  }

  // Precarga en segundo plano para resolver extensiones sin esperar al selector.
  if (!catalog || Date.now() - catalog.fetchedAt > CACHE_TTL_MS) load('icon').catch(() => {})

  return { load, imageUrl, sameSelection, isVideoUrl, isVideoExtension, DEFAULT_AVATAR }
})()
