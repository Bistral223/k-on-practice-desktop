// K-on practice（パソコン用アプリ）
// 左：いつもの K-on practice（https://k-on-practice.web.app を表示）
// 右：Songsterr のパネル（Claude のテスト画面のように右側に埋め込む。仕切りをドラッグして幅を変えられる）
const { app, BaseWindow, WebContentsView, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const APP_URL = process.env.KON_APP_URL || 'https://k-on-practice.web.app/'; // KON_APP_URL は動作確認用
const APP_HOSTS = ['k-on-practice.web.app', 'k-on-practice.firebaseapp.com', new URL(APP_URL).hostname];
const HEAD = 38;  // パネル上の操作バーの高さ
const DIV = 6;    // 仕切り（ドラッグして幅を変える）の幅
const MIN_APP = 640, MIN_PANEL = 360;

// Google のログインが「安全でないブラウザ」と判定されないよう、普通の Chrome と同じ名乗りにする
const IS_MAC = process.platform === 'darwin';
const UA_OS = IS_MAC ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64';
app.userAgentFallback = `Mozilla/5.0 (${UA_OS}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const ICON = path.join(__dirname, IS_MAC ? 'icon.png' : 'icon.ico');

if (process.env.KON_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.KON_DEBUG_PORT);
if (process.env.KON_USER_DATA) app.setPath('userData', process.env.KON_USER_DATA); // 動作確認用
if (!app.requestSingleInstanceLock()) app.quit();

// ---- Google ログイン ----
// Google はアプリの中のブラウザでのログインを許可していないため、ふだんのブラウザで desktop-login.html を開いて
// ログインしてもらい、kon-practice://auth?state=…&id_token=… でトークンを受け取る
const PROTO = 'kon-practice';
if (process.defaultApp) app.setAsDefaultProtocolClient(PROTO, process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient(PROTO);
let loginWait = null; // { state, resolve, timer }
function finishLogin(result) {
  if (!loginWait) return;
  clearTimeout(loginWait.timer);
  const { resolve } = loginWait;
  loginWait = null;
  resolve(result);
}
function handleProtocolUrl(u) {
  let x;
  try { x = new URL(u); } catch { return; }
  if (x.protocol !== PROTO + ':' || x.hostname !== 'auth') return;
  const p = x.searchParams;
  if (!loginWait || p.get('state') !== loginWait.state) return; // このアプリが始めたログインでなければ無視
  finishLogin({ idToken: p.get('id_token') || '', accessToken: p.get('access_token') || '' });
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}
ipcMain.handle('kon:google-login', () => {
  finishLogin(null); // 前のログインが残っていれば取り消す
  const state = crypto.randomBytes(16).toString('hex');
  if (!process.env.KON_NO_BROWSER) shell.openExternal(`${new URL(APP_URL).origin}/desktop-login.html?state=${state}`);
  if (process.env.KON_DEBUG_PORT) console.log('LOGIN_STATE ' + state);
  return new Promise(resolve => {
    loginWait = { state, resolve, timer: setTimeout(() => finishLogin(null), 10 * 60 * 1000) };
  });
});

// ---- ウィンドウの大きさ・パネルの幅を覚えておく ----
const cfgPath = () => path.join(app.getPath('userData'), 'window.json');
let cfg = { bounds: { width: 1500, height: 920 }, panelW: 0, maximized: false };
function loadCfg() { try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) }; } catch {} }
function saveCfg() { try { fs.writeFileSync(cfgPath(), JSON.stringify(cfg)); } catch {} }

let win, appView, panelView, tabView;
let panelOpen = false, dragging = false, focused = true;
let tabState = { url: '', title: '', canBack: false, canFwd: false, loading: false };

function isAppUrl(u) {
  try { const h = new URL(u).hostname; return APP_HOSTS.includes(h); } catch { return false; }
}
function isAuthUrl(u) {
  try {
    const x = new URL(u);
    return APP_HOSTS.includes(x.hostname) && x.pathname.startsWith('/__/auth') || /(^|\.)accounts\.google\.com$/.test(x.hostname) || /(^|\.)google\.com$/.test(x.hostname) && x.pathname.startsWith('/o/oauth2');
  } catch { return false; }
}

function panelWidth(W) {
  const want = cfg.panelW || Math.round(W * 0.5);
  return Math.max(MIN_PANEL, Math.min(want, W - MIN_APP));
}
function layout() {
  if (!win) return;
  const [W, H] = win.getContentSize();
  if (!panelOpen) {
    appView.setBounds({ x: 0, y: 0, width: W, height: H });
    panelView.setVisible(false);
    tabView.setVisible(false);
    return;
  }
  const pw = panelWidth(W), L = W - pw;
  appView.setBounds({ x: 0, y: 0, width: L, height: H });
  panelView.setVisible(true);
  tabView.setVisible(true);
  // ドラッグ中はパネルの画面をウィンドウ全体に広げて、マウスを見失わないようにする（透明）
  panelView.setBounds(dragging ? { x: 0, y: 0, width: W, height: H } : { x: L, y: 0, width: pw, height: H });
  tabView.setBounds({ x: L + DIV, y: HEAD, width: pw - DIV, height: H - HEAD });
}

function sendState() {
  const st = { open: panelOpen, focused, ...tabState };
  appView?.webContents.send('kon:tab-state', st);
  panelView?.webContents.send('kon:tab-state', st);
}
function updateTabState() {
  const wc = tabView.webContents;
  tabState = {
    url: wc.getURL(), title: wc.getTitle(),
    canBack: wc.navigationHistory.canGoBack(), canFwd: wc.navigationHistory.canGoForward(), loading: wc.isLoading(),
  };
  sendState();
}

function openPanel(url) {
  const cur = tabView.webContents.getURL();
  if (url && url !== cur) tabView.webContents.loadURL(url).catch(() => {});
  if (!panelOpen) { panelOpen = true; layout(); }
  sendState();
}
function closePanel() {
  panelOpen = false;
  layout();
  appView.webContents.focus();
  sendState();
}

function createWindow() {
  loadCfg();
  win = new BaseWindow({
    ...cfg.bounds, minWidth: 700, minHeight: 500,
    title: 'K-on practice', icon: ICON, backgroundColor: '#15171c', show: false,
  });
  if (cfg.maximized) win.maximize();

  appView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'app-preload.js'), contextIsolation: true, sandbox: true },
  });
  panelView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'panel-preload.js'), contextIsolation: true, sandbox: true },
  });
  panelView.setBackgroundColor('#00000000');
  tabView = new WebContentsView({
    webPreferences: { partition: 'persist:songsterr', contextIsolation: true, sandbox: true },
  });
  tabView.setBackgroundColor('#ffffff');
  // 重なりの順：アプリ → パネルの枠 → Songsterr（Songsterr を一番上に）
  win.contentView.addChildView(appView);
  win.contentView.addChildView(panelView);
  win.contentView.addChildView(tabView);
  layout();

  appView.webContents.loadURL(APP_URL);
  panelView.webContents.loadFile(path.join(__dirname, 'panel.html'));
  appView.webContents.once('did-finish-load', () => win.show());
  setTimeout(() => win.show(), 4000); // 読み込みが遅いときも出す

  // アプリから開くページ：Google ログインはアプリ内の小さなウィンドウ、それ以外はふだんのブラウザで開く
  appView.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuthUrl(url) || url === 'about:blank') {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, icon: ICON } };
    }
    if (/^https?:\/\/(www\.)?songsterr\.com\//.test(url)) { openPanel(url); return { action: 'deny' }; }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  appView.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url) && !isAuthUrl(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });

  // Songsterr の中から開くページ：ログインなどの小さなウィンドウは許可し、それ以外はパネルの中で開く
  tabView.webContents.setWindowOpenHandler(({ url, features }) => {
    if (features && /width|height|popup/.test(features)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    if (/^https?:/.test(url)) tabView.webContents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) {
    tabView.webContents.on(ev, updateTabState);
  }

  // キー操作：F5 で再読み込み、Ctrl+Shift+I で開発者ツール（アプリ側）
  appView.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5') { appView.webContents.reload(); e.preventDefault(); }
    if (input.control && input.shift && input.key.toLowerCase() === 'i') { appView.webContents.toggleDevTools(); e.preventDefault(); }
  });

  win.on('resize', layout);
  win.on('focus', () => { focused = true; sendState(); });
  win.on('blur', () => { focused = false; sendState(); });
  const remember = () => {
    cfg.maximized = win.isMaximized();
    if (!cfg.maximized && !win.isMinimized()) cfg.bounds = win.getBounds();
    saveCfg();
  };
  win.on('resized', remember);
  win.on('moved', remember);
  win.on('close', remember);
  win.on('closed', () => { win = null; app.quit(); });
}

// ---- アプリ（左）からの依頼 ----
ipcMain.on('kon:open-tab', (_e, url) => {
  if (typeof url === 'string' && /^https:\/\/([a-z0-9-]+\.)*songsterr\.com\//i.test(url)) openPanel(url);
});
ipcMain.on('kon:close-tab', () => closePanel());
ipcMain.on('kon:saved-state', (_e, saved) => panelView?.webContents.send('kon:saved', saved === null ? null : !!saved));
ipcMain.handle('kon:get-state', () => ({ open: panelOpen, focused, ...tabState }));

// ---- パネル（右の操作バー）からの依頼 ----
ipcMain.on('kon:panel', (_e, cmd, arg) => {
  const wc = tabView.webContents;
  if (cmd === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  if (cmd === 'fwd' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  if (cmd === 'reload') wc.reload();
  if (cmd === 'external' && wc.getURL().startsWith('http')) shell.openExternal(wc.getURL());
  if (cmd === 'close') closePanel();
  if (cmd === 'save') appView.webContents.send('kon:save-tab', { url: tabView.webContents.getURL(), title: tabView.webContents.getTitle() });
  if (cmd === 'drag-start') {
    dragging = true;
    win.contentView.addChildView(panelView); // 一番上に
    layout();
    panelView.webContents.send('kon:drag', true);
  }
  if (cmd === 'drag-move' && dragging) {
    const [W] = win.getContentSize();
    cfg.panelW = Math.max(MIN_PANEL, Math.min(W - Math.round(arg), W - MIN_APP));
    layout();
  }
  if (cmd === 'drag-end' && dragging) {
    dragging = false;
    win.contentView.addChildView(tabView); // Songsterr をまた一番上に
    layout();
    panelView.webContents.send('kon:drag', false);
    saveCfg();
  }
});

// マックでは kon-practice:// のリンクは open-url で届く
app.on('open-url', (e, url) => { e.preventDefault(); handleProtocolUrl(url); });
app.on('second-instance', (_e, argv) => {
  const u = argv.find(a => a.startsWith(PROTO + '://'));
  if (u) { handleProtocolUrl(u); return; }
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.whenReady().then(() => {
  // Windows はメニューなし。マックは上のメニューが無いとコピー・貼り付け（⌘C・⌘V）や終了（⌘Q）が効かないので、最低限だけ
  Menu.setApplicationMenu(IS_MAC ? Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' },
    { label: '表示', submenu: [{ label: '再読み込み', accelerator: 'CmdOrCtrl+R', click: () => appView?.webContents.reload() }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]) : null);
  createWindow();
  // 新しい版が GitHub に出ていれば、裏でダウンロードして次に起動したときに更新する
  // （マックの自動更新は Apple の署名が必要なので、今は Windows だけ）
  if (app.isPackaged && !IS_MAC) {
    try { require('electron-updater').autoUpdater.checkForUpdatesAndNotify().catch(() => {}); } catch {}
  }
});
app.on('window-all-closed', () => app.quit());
