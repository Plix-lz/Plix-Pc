// Requisitos de Plix en la PC: conexión a internet y un Chrome para la captura oculta del HLS
// (capture.js). Si la PC no tiene Google Chrome, se descarga Chrome for Testing en la carpeta de
// datos de la app; Microsoft Edge queda como último recurso.
const fs = require('node:fs')
const path = require('node:path')
const browsers = require('@puppeteer/browsers')

const SYSTEM_CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
]

const SYSTEM_EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
]

const firstExisting = paths => paths.find(candidate => candidate && fs.existsSync(candidate)) ?? null

const systemChrome = () => firstExisting(SYSTEM_CHROME)
const systemEdge = () => firstExisting(SYSTEM_EDGE)

async function bundledChrome(cacheDir) {
  const installed = await browsers.getInstalledBrowsers({ cacheDir }).catch(() => [])
  const chrome = installed
    .filter(entry => entry.browser === browsers.Browser.CHROME && fs.existsSync(entry.executablePath))
    .sort((a, b) => b.buildId.localeCompare(a.buildId, undefined, { numeric: true }))[0]
  return chrome?.executablePath ?? null
}

async function hasInternet() {
  // Cualquier respuesta HTTP (incluso 401/404) confirma que TMDB es alcanzable.
  for (const url of ['https://api.themoviedb.org/3/configuration', 'https://www.google.com/generate_204']) {
    const ok = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(6000) }).then(() => true).catch(() => false)
    if (ok) return true
  }
  return false
}

async function chromeDownloadInfo() {
  const platform = browsers.detectBrowserPlatform()
  const buildId = await browsers.resolveBuildId(browsers.Browser.CHROME, platform, browsers.ChromeReleaseChannel.STABLE)
  return { platform, buildId }
}

/** Descarga y descomprime Chrome for Testing. onProgress({ phase, received, total }). */
async function installChrome(cacheDir, onProgress) {
  fs.mkdirSync(cacheDir, { recursive: true })
  const { platform, buildId } = await chromeDownloadInfo()
  let extracting = false
  const result = await browsers.install({
    browser: browsers.Browser.CHROME,
    buildId,
    platform,
    cacheDir,
    downloadProgressCallback: (received, total) => {
      onProgress({ phase: 'download', received, total })
      if (!extracting && total && received >= total) {
        extracting = true
        onProgress({ phase: 'extract' })
      }
    }
  })
  return result.executablePath
}

// El primer arranque de un Chrome recién descargado tarda (Windows Defender lo analiza): se hace
// aquí, con margen, para que la primera captura no agote su tiempo.
async function warmUpBrowser(executablePath) {
  const puppeteer = require('puppeteer-core')
  const browser = await puppeteer.launch({ executablePath, headless: true, timeout: 120_000, args: ['--no-first-run'] })
  await browser.close()
}

const browserCacheDir = userData => path.join(userData, 'browser')

module.exports = { systemChrome, systemEdge, bundledChrome, hasInternet, installChrome, warmUpBrowser, browserCacheDir }
