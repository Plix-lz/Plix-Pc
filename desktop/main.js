// Plix para PC: abre la web en una ventana de pantalla completa sin barra de direcciones y corre
// server.js dentro de la app. La primera vez revisa los requisitos y, con permiso del usuario,
// descarga lo que falte mostrando el progreso.
const path = require('node:path')
const { app, BrowserWindow, Menu, ipcMain, shell, session } = require('electron')
const { autoUpdater } = require('electron-updater')
const requirements = require('./requirements')

const APP_NAME = 'Plix'
// Puerto fijo: localStorage (Mi lista, historial, progreso) depende del origen http://localhost:PUERTO.
const PREFERRED_PORT = 47821
const PORT_ATTEMPTS = 10
const MIN_SPLASH_MS = 1200
const ICON = path.join(__dirname, '..', 'build', 'icon.png')
// Enlaces que sí se abren en el navegador de la PC; cualquier otra ventana emergente se descarta.
const EXTERNAL_HOSTS = /(^|\.)(themoviedb\.org|github\.com|patrickcaramico\.github\.io|analytics\.google\.com|console\.firebase\.google\.com)$/i

app.setName(APP_NAME)
app.setAppUserModelId('com.lzplay.plix')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const log = (...args) => console.log('[plix]', ...args)

let setupWindow = null
let mainWindow = null
let appOrigin = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = mainWindow ?? setupWindow
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  app.whenReady().then(run)
}

app.on('window-all-closed', () => app.quit())

/* ---------- Pantalla de requisitos ---------- */

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 560,
    height: 440,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    center: true,
    backgroundColor: '#010413',
    title: APP_NAME,
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  setupWindow.once('ready-to-show', () => setupWindow.show())
  setupWindow.on('closed', () => {
    setupWindow = null
    if (!mainWindow) app.quit()
  })
  return setupWindow.loadFile(path.join(__dirname, 'setup.html'))
}

function showState(state) {
  setupWindow?.webContents.send('setup:state', state)
}

function askUser(state) {
  showState(state)
  return new Promise(resolve => ipcMain.once('setup:choice', (_, choice) => resolve(choice)))
}

const megabytes = bytes => `${(bytes / 1024 / 1024).toFixed(0)} MB`

async function ensureInternet() {
  showState({ title: 'Comprobando la conexión…', detail: 'Plix necesita internet para buscar películas y series.', progress: null })
  while (!(await requirements.hasInternet())) {
    const choice = await askUser({
      title: 'Sin conexión a internet',
      detail: 'Conéctate a una red y vuelve a intentarlo. Plix obtiene el catálogo y los videos desde internet.',
      buttons: ['retry', 'quit']
    })
    if (choice === 'quit') return false
    showState({ title: 'Comprobando la conexión…', detail: '', progress: null })
  }
  return true
}

/**
 * Igual que en Android: si en el release de GitHub hay una versión más nueva (latest.yml),
 * la actualización es obligatoria. Devuelve 'continue', 'quit' o 'installing'.
 */
async function ensureUpdated() {
  if (!app.isPackaged) return 'continue'
  showState({ title: 'Buscando actualizaciones…', detail: '', progress: null })
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  let latest
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result?.isUpdateAvailable) return 'continue'
    latest = result.updateInfo.version
  } catch (error) {
    // Sin servidor de actualizaciones disponible, Plix sigue funcionando con la versión instalada.
    console.error('No se pudo comprobar si hay actualizaciones:', error)
    return 'continue'
  }

  let detail = `Plix ${latest} trae mejoras y correcciones. Tu versión: ${app.getVersion()}.`
  for (;;) {
    const choice = await askUser({ title: 'Nueva versión disponible', detail, buttons: ['update', 'quit'] })
    if (choice === 'quit') return 'quit'

    const onProgress = ({ percent, transferred, total }) => showState({
      title: 'Descargando actualización…',
      detail: `${megabytes(transferred)} de ${megabytes(total)}`,
      progress: percent / 100
    })
    try {
      showState({ title: 'Descargando actualización…', detail: 'Preparando la descarga.', progress: 0 })
      autoUpdater.on('download-progress', onProgress)
      await autoUpdater.downloadUpdate()
      showState({ title: 'Instalando actualización…', detail: 'Plix se abrirá de nuevo en unos segundos.', progress: null })
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 800)
      return 'installing'
    } catch (error) {
      console.error('No se pudo descargar la actualización:', error)
      detail = `No se pudo descargar la actualización (${error.message}). Revisa tu conexión y vuelve a intentarlo.`
    } finally {
      autoUpdater.off('download-progress', onProgress)
    }
  }
}

/**
 * Motor de captura: Chrome de la PC, el Chrome for Testing que Plix ya descargó o, con permiso,
 * una descarga nueva. Devuelve la ruta del ejecutable o null si el usuario sale.
 */
async function ensureBrowser() {
  showState({ title: 'Comprobando los requisitos…', detail: 'Buscando el motor de reproducción.', progress: null })
  const cacheDir = requirements.browserCacheDir(app.getPath('userData'))
  const found = requirements.systemChrome() ?? (await requirements.bundledChrome(cacheDir))
  if (found) return found

  const edge = requirements.systemEdge()
  let detail = 'Para extraer los videos de los servidores, Plix necesita un motor de Chrome. ' +
    'Se descargará una sola vez (unos 200 MB) en la carpeta de la aplicación, sin cambiar tu navegador.'
  for (;;) {
    const choice = await askUser({
      title: 'Plix necesita descargar requisitos',
      detail,
      buttons: edge ? ['allow', 'edge', 'quit'] : ['allow', 'quit']
    })
    if (choice === 'quit') return null
    if (choice === 'edge') return edge

    try {
      showState({ title: 'Descargando requisitos…', detail: 'Preparando la descarga.', progress: 0 })
      const installed = await requirements.installChrome(cacheDir, ({ phase, received, total }) => {
        if (phase === 'extract') {
          showState({ title: 'Instalando requisitos…', detail: 'Descomprimiendo el motor de reproducción.', progress: null })
        } else if (total) {
          showState({
            title: 'Descargando requisitos…',
            detail: `Motor de reproducción: ${megabytes(received)} de ${megabytes(total)}`,
            progress: received / total
          })
        }
      })
      showState({ title: 'Verificando la instalación…', detail: 'El primer arranque del motor puede tardar unos segundos.', progress: null })
      await requirements.warmUpBrowser(installed)
      return installed
    } catch (error) {
      console.error('No se pudo instalar Chrome:', error)
      detail = `No se pudo completar la descarga (${error.message}). Revisa tu conexión y vuelve a intentarlo.`
    }
  }
}

/* ---------- Servidor local ---------- */

async function startServer(browserPath) {
  // capture.js lee CHROME_PATH al cargarse: debe fijarse antes de importar server.js.
  process.env.CHROME_PATH = browserPath
  const server = require('../server.js')
  for (let port = PREFERRED_PORT; port < PREFERRED_PORT + PORT_ATTEMPTS; port++) {
    try {
      return await server.start(port, '127.0.0.1')
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
    }
  }
  return server.start(0, '127.0.0.1')
}

/* ---------- Ventana principal ---------- */

function isAppUrl(url) {
  try {
    return new URL(url).origin === appOrigin
  } catch {
    return false
  }
}

function openExternalIfAllowed(url) {
  try {
    const { protocol, hostname } = new URL(url)
    if ((protocol === 'https:' || protocol === 'http:') && EXTERNAL_HOSTS.test(hostname)) shell.openExternal(url)
  } catch {}
}

function hardenSession() {
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write', 'media', 'pointerLock'])
  session.defaultSession.setPermissionRequestHandler((_, permission, callback) => callback(allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_, permission) => allowed.has(permission))
}

function createMainWindow(port) {
  appOrigin = `http://localhost:${port}`
  mainWindow = new BrowserWindow({
    show: false,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#0d162e',
    title: APP_NAME,
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'app-preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false
    }
  })

  const contents = mainWindow.webContents
  // El título de la página (Lzplay | …) no reemplaza el nombre de la app en la barra de tareas.
  mainWindow.on('page-title-updated', event => event.preventDefault())

  // Los anuncios de los embeds no pueden abrir ventanas ni sacar a la app de su página.
  contents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (event.isMainFrame && !isAppUrl(url)) event.preventDefault()
  })

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
      event.preventDefault()
    } else if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
      contents.reload()
      event.preventDefault()
    } else if (!app.isPackaged && input.key === 'F12') {
      contents.toggleDevTools()
      event.preventDefault()
    }
  })

  contents.on('render-process-gone', (_, details) => {
    if (details.reason !== 'clean-exit') contents.reload()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  return mainWindow
}

/* ---------- Arranque ---------- */

async function run() {
  Menu.setApplicationMenu(null)
  hardenSession()
  ipcMain.handle('setup:version', () => app.getVersion())
  ipcMain.on('app:quit', event => {
    if (mainWindow && event.sender === mainWindow.webContents) app.quit()
  })

  const shownAt = Date.now()
  await createSetupWindow()
  log('pantalla de requisitos lista')

  try {
    if (!(await ensureInternet())) return app.quit()
    log('internet ok')
    const update = await ensureUpdated()
    if (update === 'quit') return app.quit()
    if (update === 'installing') return
    const browserPath = await ensureBrowser()
    if (!browserPath) return app.quit()
    log('motor de captura:', browserPath)

    showState({ title: 'Iniciando Plix…', detail: 'Preparando el reproductor.', progress: null })
    const port = await startServer(browserPath)
    log('servidor en el puerto', port)
    const window = createMainWindow(port)
    await window.loadURL(`${appOrigin}/`)
    log('ventana principal cargada')

    const wait = MIN_SPLASH_MS - (Date.now() - shownAt)
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    window.show()
    window.focus()
    setupWindow?.destroy()
  } catch (error) {
    console.error(error)
    const choice = await askUser({
      title: 'No se pudo iniciar Plix',
      detail: error.message || 'Error desconocido.',
      buttons: ['retry', 'quit']
    })
    if (choice === 'retry') {
      app.relaunch()
    }
    app.quit()
  }
}
