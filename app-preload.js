// アプリ（左側の K-on practice）に、Songsterr のパネルを操作する機能だけを渡す
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('konDesktop', {
  version: 1,
  openTab: url => ipcRenderer.send('kon:open-tab', String(url)),
  closeTab: () => ipcRenderer.send('kon:close-tab'),
  getState: () => ipcRenderer.invoke('kon:get-state'),
  // Google ログイン（ふだんのブラウザでログインして、結果を受け取る）。{ idToken, accessToken } か null
  googleLogin: () => ipcRenderer.invoke('kon:google-login'),
  onState: cb => ipcRenderer.on('kon:tab-state', (_e, st) => cb(st)),
  // パネルの「＋ 保存」：保存してほしいと頼まれたとき／保存済みかどうかをパネルに伝える（null なら曲のページではない）
  onSaveRequest: cb => ipcRenderer.on('kon:save-tab', (_e, st) => cb(st)),
  reportSaved: saved => ipcRenderer.send('kon:saved-state', saved),
});
