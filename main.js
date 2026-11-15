'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, Notification } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createJob, parseRepoUrl } = require('./compiler');

const DEFAULTS = {
  outputDir: '',
  theme: 'dark',
  accent: '#01875f',
  electronVersion: '33.2.1',
  platform: 'host',
  arch: 'host',
  legacyPeerDeps: true,
  keepTemp: false,
};

const VALIDATORS = {
  outputDir: (v) => typeof v === 'string' && (v === '' || path.isAbsolute(v)),
  theme: (v) => ['light', 'dark', 'system'].includes(v),
  accent: (v) => /^#[0-9a-f]{6}$/i.test(v),
  electronVersion: (v) => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v),
  platform: (v) => ['host', 'win32', 'darwin', 'linux'].includes(v),
  arch: (v) => ['host', 'x64', 'arm64', 'ia32'].includes(v),
  legacyPeerDeps: (v) => typeof v === 'boolean',
  keepTemp: (v) => typeof v === 'boolean',
};

let storePath;
let store = { settings: { ...DEFAULTS }, history: [] };
let win = null;
let job = null;

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    store.settings = { ...DEFAULTS, ...(raw.settings || {}) };
    store.history = Array.isArray(raw.history) ? raw.history : [];
  } catch {}
}

function saveStore() {
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  } catch (e) { console.error('Store yazılamadı:', e); }
}

function baseDir() {
  if (!app.isPackaged) return __dirname;
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
}

function defaultOutputDir() {
  const preferred = path.join(baseDir(), 'Compiled Repos');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    return path.join(app.getPath('documents'), 'Compiled Repos');
  }
}

const wrapperTemplatePath = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'wrapper-main.js')
  : path.join(__dirname, 'wrapper-main.js'));

const outputRoot = () => store.settings.outputDir || defaultOutputDir();

function snapshot() {
  return {
    settings: store.settings,
    effectiveOutputDir: outputRoot(),
    history: store.history,
    busy: !!job,
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
  };
}

function createWindow() {
  const dark = store.settings.theme === 'system' ? nativeTheme.shouldUseDarkColors : store.settings.theme === 'dark';
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    show: false,
    title: 'Repo Compiler',
    backgroundColor: dark ? '#0f1311' : '#f6f8f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  storePath = path.join(app.getPath('userData'), 'store.json');
  loadStore();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('before-quit', () => { if (job) job.cancel(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('state:get', () => snapshot());

ipcMain.handle('settings:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'Geçersiz ayar.' };
  for (const [key, value] of Object.entries(patch)) {
    if (!VALIDATORS[key]) return { ok: false, error: `Bilinmeyen ayar: ${key}` };
    if (!VALIDATORS[key](value)) return { ok: false, error: `"${key}" için geçersiz değer.` };
  }
  Object.assign(store.settings, patch);
  saveStore();
  return { ok: true, state: snapshot() };
});

ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Çıktı klasörünü seçin',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: outputRoot(),
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('compile:start', async (_e, url) => {
  if (job) return { ok: false, error: 'Devam eden bir derleme var.' };
  let repo;
  try { repo = parseRepoUrl(url); } catch (err) { return { ok: false, error: err.message }; }

  const root = outputRoot();
  try { fs.mkdirSync(root, { recursive: true }); fs.accessSync(root, fs.constants.W_OK); }
  catch { return { ok: false, error: `Çıktı klasörüne yazılamıyor: ${root}` }; }

  const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
  const emit = {
    log: (level, text) => send('compile:log', { level, text }),
    stage: (key, percent, label) => send('compile:stage', { key, percent, label }),
  };

  const settings = { ...store.settings };
  const repoUrl = `https://github.com/${repo.owner}/${repo.repo}`;
  job = createJob({ url, settings, outputRoot: root, emit, wrapperTemplate: wrapperTemplatePath() });
  const current = job;

  (async () => {
    const base = {
      id: crypto.randomUUID(),
      name: repo.repo,
      url: repoUrl,
      branch: repo.branch,
      date: Date.now(),
      root,
    };
    let entry = null;
    let cancelled = false;
    try {
      const result = await current.promise;
      entry = { ...base, status: 'success', ...result };
    } catch (err) {
      if (err && err.cancelled) cancelled = true;
      else entry = { ...base, status: 'failed', error: String((err && err.message) || err), platform: settings.platform, arch: settings.arch };
    }
    job = null;
    if (entry) {
      store.history.unshift(entry);
      store.history = store.history.slice(0, 100);
      saveStore();
    }
    send('compile:done', { status: cancelled ? 'cancelled' : entry.status, entry, state: snapshot() });
    if (entry && win && !win.isFocused() && Notification.isSupported()) {
      new Notification({
        title: entry.status === 'success' ? 'Derleme tamamlandı' : 'Derleme başarısız',
        body: entry.status === 'success' ? `${entry.name} hazır.` : entry.error,
      }).show();
    }
  })();

  return { ok: true };
});

ipcMain.handle('compile:cancel', () => { if (job) job.cancel(); return true; });

ipcMain.handle('path:open', async (_e, p) => {
  const allowed = p === outputRoot() || store.history.some((h) => h.outputPath === p);
  if (!allowed || !fs.existsSync(p)) return { ok: false, error: 'Klasör bulunamadı.' };
  const err = await shell.openPath(p);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('app:run', (_e, id) => {
  const entry = store.history.find((h) => h.id === id);
  if (!entry || !entry.exePath || !fs.existsSync(entry.exePath)) {
    return { ok: false, error: 'Çalıştırılabilir dosya bulunamadı.' };
  }
  if (process.platform === 'darwin') { shell.openPath(entry.exePath); return { ok: true }; }
  try {
    const child = spawn(entry.exePath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(entry.exePath) });
    child.on('error', () => {});
    child.unref();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('history:delete', async (_e, id, removeFiles) => {
  const idx = store.history.findIndex((h) => h.id === id);
  if (idx === -1) return { ok: false, error: 'Kayıt bulunamadı.' };
  const entry = store.history[idx];
  if (removeFiles && entry.outputPath && entry.root && entry.outputPath.startsWith(entry.root + path.sep)) {
    try { await fs.promises.rm(entry.outputPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); }
    catch (e) { return { ok: false, error: `Dosyalar silinemedi: ${e.message}` }; }
  }
  store.history.splice(idx, 1);
  saveStore();
  return { ok: true, state: snapshot() };
});

ipcMain.handle('history:clear', () => {
  store.history = [];
  saveStore();
  return { ok: true, state: snapshot() };
});
