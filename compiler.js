'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

class Cancelled extends Error {
  constructor() { super('İptal edildi'); this.cancelled = true; }
}

const exists = (p) => fsp.access(p).then(() => true, () => false);
const q = (s) => (/[\s&|<>^"]/.test(s) ? `"${s}"` : s);
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';

function parseRepoUrl(input) {
  const s = String(input || '').trim();
  const m = s.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([A-Za-z0-9_./-]+))?\/?$/
  );
  if (!m || /^\.+$/.test(m[2]) || /^\.+$/.test(m[1])) {
    throw new Error('Geçerli bir GitHub linki girin (örn. https://github.com/kullanici/repo).');
  }
  return {
    owner: m[1],
    repo: m[2],
    branch: m[3] || null,
    cloneUrl: `https://github.com/${m[1]}/${m[2]}.git`,
  };
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill(); } catch { }
  }
}

function exec(state, emit, cmd, args, { cwd, env = {}, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    if (state.cancelled) return reject(new Cancelled());
    emit.log('cmd', `$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      cwd,
      shell,
      env: { ...process.env, ...env },
      windowsHide: true,
      detached: !IS_WIN,
    });
    state.child = child;

    const pipe = (stream, level) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split(/\r?\n|\r/);
        buf = lines.pop();
        lines.forEach((l) => { const t = l.replace(ANSI, '').trimEnd(); if (t.trim()) emit.log(level, t); });
      });
      stream.on('end', () => { const t = buf.replace(ANSI, '').trim(); if (t) emit.log(level, t); });
    };
    pipe(child.stdout, 'out');
    pipe(child.stderr, 'err');

    child.on('error', (e) => {
      state.child = null;
      reject(e.code === 'ENOENT' ? new Error(`"${cmd}" bulunamadı. Kurulu ve PATH içinde olduğundan emin olun.`) : e);
    });
    child.on('close', (code) => {
      state.child = null;
      if (state.cancelled) return reject(new Cancelled());
      if (code === 0) resolve();
      else reject(new Error(`"${cmd} ${args[0] || ''}" komutu ${code} koduyla sonlandı.`));
    });
  });
}

async function findWebRoot(dir) {
  if (await exists(path.join(dir, 'index.html'))) return dir;
  for (const sub of ['dist', 'build', 'public', 'src', 'docs', 'www', 'web', 'app', 'site', 'client']) {
    const p = path.join(dir, sub);
    if (await exists(path.join(p, 'index.html'))) return p;
  }
  return null;
}

async function findBuildOutput(dir) {
  let best = null;
  let bestTime = 0;
  for (const sub of ['dist', 'build', 'out', '.output/public', 'docs', 'www']) {
    const html = path.join(dir, sub, 'index.html');
    try {
      const st = await fsp.stat(html);
      if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = path.join(dir, sub); }
    } catch { }
  }
  return best;
}

async function analyze(dir, emit) {
  let pkg = null;
  const pkgPath = path.join(dir, 'package.json');
  if (await exists(pkgPath)) {
    try { pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8')); }
    catch { emit.log('warn', 'package.json okunamadı (geçersiz JSON).'); }
  }
  const deps = { ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) };
  const hasBuild = !!(pkg && pkg.scripts && pkg.scripts.build);

  let type = 'unsupported';
  if (pkg && deps.electron) type = 'electron';
  else if (pkg && hasBuild) type = 'web-build';
  else if (await findWebRoot(dir)) type = 'web-static';
  return { type, pkg, hasBuild };
}

async function run(opts, state) {
  const { url, settings, outputRoot, emit, wrapperTemplate } = opts;
  const t0 = Date.now();
  const repo = parseRepoUrl(url);
  const appName = safeName(repo.repo);
  const platform = settings.platform === 'host' ? process.platform : settings.platform;
  const arch = settings.arch === 'host' ? process.arch : settings.arch;

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'repo-compiler-'));
  const repoDir = path.join(tmp, 'repo');
  const wrapDir = path.join(tmp, 'wrapper');
  const outDir = path.join(tmp, 'out');
  const x = (cmd, args, o) => exec(state, emit, cmd, args, o);

  try {
    emit.stage('clone', 2, 'Gereksinimler denetleniyor');
    await x('git', ['--version']);
    await x('npm', ['--version'], { shell: true });

    emit.stage('clone', 6, 'Repo indiriliyor');
    const cloneArgs = ['clone', '--depth', '1'];
    if (repo.branch) cloneArgs.push(`--branch=${repo.branch}`);
    cloneArgs.push(repo.cloneUrl, repoDir);
    await x('git', cloneArgs, { env: { GIT_TERMINAL_PROMPT: '0' } });

    emit.stage('analyze', 20, 'Proje yapısı inceleniyor');
    const info = await analyze(repoDir, emit);
    const typeLabel = {
      electron: 'Electron projesi',
      'web-build': 'npm ile derlenen web projesi',
      'web-static': 'Saf HTML/CSS/JS projesi',
    }[info.type];
    if (!typeLabel) {
      throw new Error('Desteklenmeyen proje: ne Electron/web build betiği ne de index.html bulundu.');
    }
    emit.log('info', `Tespit edilen tür: ${typeLabel}`);

    if (info.type !== 'web-static') {
      emit.stage('install', 25, 'Bağımlılıklar kuruluyor');
      const args = ['install', '--no-audit', '--no-fund'];
      if (settings.legacyPeerDeps) args.push('--legacy-peer-deps');
      await x('npm', args, { cwd: repoDir, shell: true, env: { NODE_ENV: 'development' } });
    } else {
      emit.stage('install', 40, 'Bağımlılık gerekmiyor');
      emit.log('info', 'Saf web projesi: npm install atlandı.');
    }

    emit.stage('build', 55, 'Proje hazırlanıyor');
    let appDir;

    if (info.type === 'electron') {
      appDir = repoDir;
      const mainRel = info.pkg.main || 'index.js';
      if (!(await exists(path.join(repoDir, mainRel))) && info.hasBuild) {
        emit.log('info', `"${mainRel}" bulunamadı, npm run build çalıştırılıyor.`);
        await x('npm', ['run', 'build'], { cwd: repoDir, shell: true, env: { CI: 'false' } });
      }
      if (!(await exists(path.join(repoDir, mainRel)))) {
        throw new Error(`Electron giriş dosyası bulunamadı: ${mainRel}`);
      }
    } else {
      let webRoot;
      if (info.type === 'web-build') {
        await x('npm', ['run', 'build'], { cwd: repoDir, shell: true, env: { CI: 'false' } });
        webRoot = await findBuildOutput(repoDir);
        if (!webRoot) throw new Error('Derleme çıktısı (dist/build/out içinde index.html) bulunamadı.');
      } else {
        webRoot = await findWebRoot(repoDir);
        if (webRoot !== repoDir) emit.log('warn', `index.html kök dizinde değil, "${path.relative(repoDir, webRoot)}" klasörü kullanılıyor.`);
      }
      emit.log('info', `Web dosyaları: ${path.relative(repoDir, webRoot) || '.'}`);

      await fsp.mkdir(wrapDir, { recursive: true });
      await fsp.cp(webRoot, path.join(wrapDir, 'www'), {
        recursive: true,
        filter: (s) => { const b = path.basename(s); return b !== 'node_modules' && b !== '.git'; },
      });
      const tpl = await fsp.readFile(wrapperTemplate || path.join(__dirname, 'wrapper-main.js'), 'utf8');
      await fsp.writeFile(path.join(wrapDir, 'main.js'), tpl);
      await fsp.writeFile(
        path.join(wrapDir, 'package.json'),
        JSON.stringify({
          name: appName.toLowerCase(),
          productName: appName,
          version: (info.pkg && info.pkg.version) || '1.0.0',
          description: (info.pkg && info.pkg.description) || `${appName} (Repo Compiler ile derlendi)`,
          main: 'main.js',
        }, null, 2)
      );
      appDir = wrapDir;
      emit.log('ok', 'Electron sarmalayıcısı oluşturuldu.');
    }

    emit.stage('package', 70, 'Masaüstü uygulaması paketleniyor');
    const pkgArgs = ['--yes', '@electron/packager@18', '.', appName, `--out=${q(outDir)}`, '--overwrite', `--platform=${platform}`, `--arch=${arch}`];
    if (info.type !== 'electron') pkgArgs.push(`--electron-version=${settings.electronVersion}`);
    await x('npx', pkgArgs, { cwd: appDir, shell: true });

    emit.stage('move', 95, 'Dosyalar taşınıyor');
    const built = (await fsp.readdir(outDir, { withFileTypes: true })).find((d) => d.isDirectory());
    if (!built) throw new Error('Paketleyici çıktı klasörü üretmedi.');

    const finalDir = path.join(outputRoot, appName);
    if (await exists(finalDir)) {
      emit.log('warn', 'Aynı isimli önceki derleme siliniyor.');
      try { await fsp.rm(finalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
      catch (e) { throw new Error(`Eski klasör silinemedi (uygulama açık olabilir): ${e.message}`); }
    }
    await fsp.cp(path.join(outDir, built.name), finalDir, { recursive: true });

    let exePath = null;
    const candidates = platform === 'win32' ? [`${appName}.exe`] : platform === 'darwin' ? [`${appName}.app`] : [appName];
    for (const c of candidates) if (await exists(path.join(finalDir, c))) exePath = path.join(finalDir, c);

    emit.stage('move', 100, 'Tamamlandı');
    emit.log('ok', `Hazır: ${finalDir}`);
    return { outputPath: finalDir, exePath, type: info.type, platform, arch, durationMs: Date.now() - t0 };
  } finally {
    if (settings.keepTemp) emit.log('info', `Geçici klasör korundu: ${tmp}`);
    else await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
  }
}

function createJob(opts) {
  const state = { cancelled: false, child: null };
  const cancel = () => { state.cancelled = true; killTree(state.child); };
  const promise = run(opts, state);
  return { promise, cancel };
}

module.exports = { createJob, parseRepoUrl };
