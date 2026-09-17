// Electron compatibility layer for the standalone PodVet web build.
//
// Handlers/*.js were written for Electron and call require('electron') for a
// small set of APIs (ipcMain.handle, app.getPath, shell, dialog, safeStorage,
// BrowserWindow, Notification). This module is a 100%-pure-Node stand-in for
// that surface: there is NO Electron, no Chromium, no window — just the same
// methods mapped onto the web server's HTTP/SSE plumbing.
//
//   ipcMain.handle(channel, fn)  registers an RPC handler (served at /_rpc/X)
//   BrowserWindow                facade whose webContents.send() fans out via SSE
//   app.getPath / dialog / ...   normalised onto the server's data dir etc.
const path = require('path');
const os = require('os');
const fs = require('fs');

// Where persisted session/config files live (worker dir when on Render).
const WEB_USER_DATA_DIR = path.resolve(
  process.env.WEB_USER_DATA_DIR ||
  process.env.HOME ||
  path.join(os.homedir(), '.podvet'),
);
fs.mkdirSync(WEB_USER_DATA_DIR, { recursive: true });

// RPC registry + SSE fan-out — shared with the web server via the __web export.
const rpcChannels = new Map(); // channel -> handler fn
const sseClients = new Set();  // open EventSource responses

function sseSend(channel, payload) {
  const data = JSON.stringify(payload === undefined ? {} : payload);
  for (const res of sseClients) {
    try { res.write(`event: ${channel}\ndata: ${data}\n\n`); } catch (_) {}
  }
}

let shimDialogFilePath = null;

function createWindowFacade() {
  const wc = {
    send(channel, payload) { sseSend(channel, payload); },
    once() {},
    on() {},
    print(_opts, cb) { if (typeof cb === 'function') cb(true, ''); },
  };
  return {
    webContents: wc,
    loadURL: async () => {},
    loadFile: async () => {},
    close() {},
    hide() {},
    show() {},
    focus() {},
    restore() {},
    isMinimized: () => false,
    on() {},
    once() {},
  };
}

// The `electron` object handlers destructure.
const electron = {
  // The few desktop-only internals the web server needs. Extra properties on
  // the destructured { ipcMain, app, ... } names are harmless to handlers.
  __web: {
    rpcChannels,
    sseClients,
    sseSend,
    setDialogFilePath(p) { shimDialogFilePath = p; },
    getDialogFilePath: () => shimDialogFilePath,
    createWindowFacade,
    userDataDir: WEB_USER_DATA_DIR,
  },
  ipcMain: {
    handle(channel, fn) { rpcChannels.set(channel, fn); },
    on() {},
    once() {},
    removeAllListeners() {},
    removeHandler(channel) { rpcChannels.delete(channel); },
  },
  app: {
    isPackaged: false,
    getPath(name) {
      switch (name) {
        case 'userData': return WEB_USER_DATA_DIR;
        case 'appData': return path.dirname(WEB_USER_DATA_DIR);
        case 'home': return os.homedir();
        case 'temp': return os.tmpdir();
        case 'documents': return path.join(os.homedir(), 'Documents');
        case 'desktop': return path.join(os.homedir(), 'Desktop');
        case 'downloads': return path.join(os.homedir(), 'Downloads');
        default: return WEB_USER_DATA_DIR;
      }
    },
    getVersion: () => '5.0.10-web',
    getAppPath: () => path.resolve(__dirname, '..', '..'),
    on() {},
    once() {},
    whenReady: async () => {},
    quit() {},
  },
  shell: {
    openExternal: async (url) => { if (url && typeof url === 'string' && (url.startsWith('http') || url.startsWith('https'))) sseSend('open-external', { url }); },
    openPath: async () => {},
    showItemInFolder: () => {},
  },
  dialog: {
    async showOpenDialog() {
      // A browser can't ask the OS for a path; the web preload uploads the
      // file first (POST /web-upload) and stores its path here, then whatever
      // handler calls showOpenDialog* receives it as the "picked" file.
      if (shimDialogFilePath) {
        const p = shimDialogFilePath;
        shimDialogFilePath = null;
        return { canceled: false, filePaths: [p] };
      }
      return { canceled: true, filePaths: [] };
    },
    async showSaveDialog(opts) {
      const name = (opts && opts.defaultPath) || 'file';
      return { canceled: false, filePath: path.join(os.tmpdir(), path.basename(name)) };
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => ({ toString: () => Buffer.from(String(s), 'utf8').toString('base64') }),
    decryptString: (b) => Buffer.isBuffer(b) ? b.toString('utf8') : Buffer.from(String(b), 'base64').toString('utf8'),
  },
  Notification: class {
    static isSupported() { return false; }
    on() {}
    show() {}
  },
  BrowserWindow: function BrowserWindowShim() { return createWindowFacade(); },
  // clipboard used by some billing/records copies
  clipboard: {
    writeText: () => {},
    readText: () => '',
  },
  getCurrentWindow: () => createWindowFacade(),
};
electron.BrowserWindow.getAllWindows = () => [createWindowFacade()];
electron.BrowserWindow.fromWebContents = () => createWindowFacade();

module.exports = electron;