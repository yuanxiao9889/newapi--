const { contextBridge, ipcRenderer } = require('electron')
const api = {}
for (const action of [
  'state',
  'exportConfig',
  'importConfig',
  'openSite',
  'probe',
  'saveSite',
  'updateSite',
  'setAutoUsd',
  'refresh',
  'preferences',
  'saveMail',
  'testMail',
  'retry',
]) {
  api[action] = async (payload) => {
    const reply = await ipcRenderer.invoke('desk:' + action, payload)
    if (!reply.ok) throw Error(reply.error)
    return reply.value
  }
}
api.onChange = (callback) => {
  const listener = (_event, state) => callback(state)
  ipcRenderer.on('desk:changed', listener)
  return () => ipcRenderer.removeListener('desk:changed', listener)
}
contextBridge.exposeInMainWorld('quotaDesk', api)
