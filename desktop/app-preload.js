const { contextBridge, ipcRenderer } = require('electron')

// La web detecta que corre dentro de Plix para PC (p. ej. Esc en el inicio pide salir).
contextBridge.exposeInMainWorld('plixDesktop', {
  quit: () => ipcRenderer.send('app:quit')
})
