// Google Analytics (GA4) a través de Firebase. Los eventos se encolan hasta que cloud.js inicia
// Firebase; si no hay measurementId en CONFIG.FIREBASE no se envía nada.
const analytics = (() => {
  const PLATFORM = 'web_pc'
  const MAX_QUEUE = 50
  let instance = null
  let disabled = !CONFIG.FIREBASE?.measurementId
  let queue = []

  async function init(app) {
    if (disabled || !window.firebase?.analytics) {
      disabled = true
      queue = []
      return
    }
    try {
      if (!(await firebase.analytics.isSupported())) throw new Error('Analytics no es compatible con este navegador.')
      instance = firebase.analytics(app)
      instance.setUserProperties({ platform: PLATFORM })
      queue.forEach(run => run())
    } catch (error) {
      disabled = true
      console.warn('Google Analytics desactivado:', error.message)
    }
    queue = []
  }

  function whenReady(run) {
    if (instance) run()
    else if (!disabled && queue.length < MAX_QUEUE) queue.push(run)
  }

  function log(name, params = {}) {
    whenReady(() => instance.logEvent(name, { platform: PLATFORM, ...params }))
  }

  function setUser(uid) {
    whenReady(() => instance.setUserId(uid || null))
  }

  function item(media, extra = {}) {
    return {
      item_id: `${media.type === 'tv' ? 'tv' : 'movie'}:${media.id}`,
      item_name: media.title ?? '',
      item_category: media.type === 'tv' ? 'Serie' : 'Película',
      item_category2: media.genre ?? '',
      ...extra
    }
  }

  return { init, log, setUser, item }
})()
