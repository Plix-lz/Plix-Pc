const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('plixSetup', {
  onState: callback => ipcRenderer.on('setup:state', (_, state) => callback(state)),
  choose: choice => ipcRenderer.send('setup:choice', choice),
  version: () => ipcRenderer.invoke('setup:version')
})
