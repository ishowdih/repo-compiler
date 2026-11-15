'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id) => `<svg class="ic"><use href="#i-${id}"/></svg>`;

const ACCENTS = [
  ['Yeşil', '#01875f'], ['Mavi', '#1a73e8'], ['Mor', '#7e57c2'], ['Pembe', '#d81b60'],
  ['Turuncu', '#e8710a'], ['Kırmızı', '#d93025'], ['Turkuaz', '#00838f'], ['Gri', '#546e7a'],
];
const STEPS = [
  ['clone', 'İndirme'], ['analyze', 'Analiz'], ['install', 'Kurulum'],
  ['build', 'Derleme'], ['package', 'Paketleme'], ['move', 'Taşıma'],
];
const TYPE_LABELS = { electron: 'Electron', 'web-build': 'Web (npm build)', 'web-static': 'Saf web' };

const state = { settings: null, history: [], busy: false, outDir: '', platform: '', arch: '', version: '', currentStep: null, logCount: 0 };
const logBuffer = [];

let toastTimer;
function toast(msg) {
  const el = $('#snackbar');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3400);
}

function applyState(s) {
  state.settings = s.settings;
  state.history = s.history;
  state.busy = s.busy;
  state.outDir = s.effectiveOutputDir;
  state.platform = s.platform;
  state.arch = s.arch;
  state.version = s.appVersion;
}

function onColor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? '#111111' : '#ffffff';
}

const hueOf = (str) => { let h = 0; for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const fmtDuration = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)} dk ${String(s % 60).padStart(2, '0')} sn`; };
const fmtDate = (t) => new Date(t).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });

async function saveSettings(patch) {
  const res = await window.api.setSettings(patch);
  if (!res.ok) { toast(res.error); return false; }
  applyState(res.state);
  return true;
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const { theme, accent } = state.settings;
  const resolved = theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : theme;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--on-accent', onColor(accent));
  $$('#theme-grid .theme-card').forEach((c) => c.classList.toggle('selected', c.dataset.themeVal === theme));
  $$('#swatches .swatch').forEach((s) => s.classList.toggle('selected', s.dataset.color.toLowerCase() === accent.toLowerCase()));
  $('#accent-custom').value = accent;
  $('#accent-hex').textContent = accent.toUpperCase();
}
darkQuery.addEventListener('change', () => { if (state.settings && state.settings.theme === 'system') applyTheme(); });

document.addEventListener('pointerdown', (e) => {
  const t = e.target.closest('.ripple');
  if (!t || t.disabled) return;
  const rect = t.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2.2;
  const wave = document.createElement('span');
  wave.className = 'ripple-wave';
  wave.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size / 2}px;top:${e.clientY - rect.top - size / 2}px`;
  t.appendChild(wave);
  wave.addEventListener('animationend', () => wave.remove());
});

function showView(name) {
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
}
$$('.nav-item').forEach((n) => n.addEventListener('click', () => showView(n.dataset.view)));

function renderStepper(activeKey, status) {
  const idx = STEPS.findIndex(([k]) => k === activeKey);
  $('#stepper').innerHTML = STEPS.map(([key, label], i) => {
    let cls = '';
    let lead = '<i></i>';
    if (status === 'success' || i < idx) { cls = 'done'; lead = icon('check'); }
    else if (i === idx) {
      if (status === 'failed') { cls = 'failed'; lead = icon('error'); }
      else if (status === 'cancelled') { cls = ''; }
      else cls = 'active';
    }
    return `<span class="step ${cls}">${lead}${label}</span>`;
  }).join('');
}

function setProgress(percent, label) {
  $('#bar-fill').style.width = `${percent}%`;
  $('#job-percent').textContent = `${Math.round(percent)}%`;
  if (label) $('#job-stage').textContent = label;
}

function setJobStatus(status) {
  const job = $('#job');
  job.classList.remove('running', 'failed', 'cancelled');
  if (status === 'running') job.classList.add('running');
  if (status === 'failed') job.classList.add('failed');
  if (status === 'cancelled') job.classList.add('cancelled');
  $('#btn-cancel').hidden = status !== 'running';
  $('#btn-close-job').hidden = status === 'running';
}

function resetJob(name) {
  $('#job').hidden = false;
  $('#job-title').textContent = name;
  $('#terminal').textContent = '';
  state.logCount = 0;
  state.currentStep = 'clone';
  setJobStatus('running');
  renderStepper('clone', 'running');
  setProgress(1, 'Başlatılıyor…');
}

function updateBusyUI() {
  $('#btn-compile').disabled = state.busy;
  $('#repo-url').disabled = state.busy;
  $('#btn-compile span').textContent = state.busy ? 'Derleniyor…' : 'Derle';
  $$('.app-card .btn, .app-card .icon-btn').forEach((b) => { if (b.dataset.act === 'retry') b.disabled = state.busy; });
}

let flushScheduled = false;
function addLog(level, text) {
  logBuffer.push({ level, text });
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    const term = $('#terminal');
    const nearBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 60;
    const frag = document.createDocumentFragment();
    for (const { level: lv, text: tx } of logBuffer.splice(0)) {
      const line = document.createElement('div');
      line.className = `l-${lv}`;
      line.textContent = tx;
      frag.appendChild(line);
      state.logCount++;
    }
    term.appendChild(frag);
    while (state.logCount > 3000) { term.firstChild.remove(); state.logCount--; }
    if (nearBottom) term.scrollTop = term.scrollHeight;
  });
}

async function startCompile() {
  const input = $('#repo-url');
  const url = input.value.trim();
  const errEl = $('#url-error');
  errEl.textContent = '';
  input.closest('.field').classList.remove('invalid');
  if (!url) { errEl.textContent = 'Bir GitHub repo linki yapıştırın.'; input.closest('.field').classList.add('invalid'); input.focus(); return; }

  const res = await window.api.startCompile(url);
  if (!res.ok) { errEl.textContent = res.error; input.closest('.field').classList.add('invalid'); return; }

  state.busy = true;
  const name = url.replace(/\/+$/, '').split('/').slice(3, 5).join('/') || url;
  resetJob(name);
  updateBusyUI();
}

$('#btn-compile').addEventListener('click', startCompile);
$('#repo-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') startCompile(); });
$('#repo-url').addEventListener('input', () => { $('#url-error').textContent = ''; $('#repo-url').closest('.field').classList.remove('invalid'); });
$('#btn-cancel').addEventListener('click', () => { $('#btn-cancel').disabled = true; window.api.cancelCompile(); });
$('#btn-close-job').addEventListener('click', () => { $('#job').hidden = true; });
$('#btn-copylog').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#terminal').innerText); toast('Log panoya kopyalandı.'); }
  catch { toast('Kopyalanamadı.'); }
});

window.api.onLog(({ level, text }) => addLog(level, text));
window.api.onStage(({ key, percent, label }) => {
  state.currentStep = key;
  renderStepper(key, 'running');
  setProgress(percent, label);
});
window.api.onDone(({ status, entry, state: s }) => {
  applyState(s);
  $('#btn-cancel').disabled = false;
  if (status === 'success') {
    renderStepper(state.currentStep, 'success');
    setProgress(100, 'Derleme tamamlandı');
    setJobStatus('success');
    addLog('ok', `✔ Bitti (${fmtDuration(entry.durationMs)})`);
    toast(`${entry.name} derlendi.`);
  } else if (status === 'cancelled') {
    renderStepper(state.currentStep, 'cancelled');
    $('#job-stage').textContent = 'İptal edildi';
    setJobStatus('cancelled');
    addLog('warn', 'Derleme kullanıcı tarafından iptal edildi.');
  } else {
    renderStepper(state.currentStep, 'failed');
    $('#job-stage').textContent = 'Derleme başarısız';
    setJobStatus('failed');
    addLog('err', `✖ ${entry.error}`);
    toast('Derleme başarısız oldu.');
  }
  renderHistory();
  updateBusyUI();
});

function renderHistory() {
  const list = $('#history');
  $('#history-count').textContent = state.history.length ? `${state.history.length} kayıt` : '';
  if (!state.history.length) {
    list.innerHTML = `<div class="empty">${icon('apps')}<strong>Henüz derleme yok</strong>Yukarıya bir GitHub linki yapıştırıp Derle'ye basın.</div>`;
    return;
  }
  list.innerHTML = state.history.map((h, i) => {
    const ok = h.status === 'success';
    const hue = hueOf(h.name);
    const chips = [
      `<span class="chip ${ok ? 'ok' : 'err'}">${ok ? 'Hazır' : 'Başarısız'}</span>`,
      h.type ? `<span class="chip">${esc(TYPE_LABELS[h.type] || h.type)}</span>` : '',
      h.platform && h.platform !== 'host' ? `<span class="chip">${esc(h.platform)}${h.arch && h.arch !== 'host' ? '-' + esc(h.arch) : ''}</span>` : '',
      h.branch ? `<span class="chip warn">${esc(h.branch)}</span>` : '',
    ].join('');
    const info = ok
      ? `${esc(fmtDate(h.date))} · ${esc(fmtDuration(h.durationMs))}<br><span class="path-inline">${esc(h.outputPath)}</span>`
      : esc(fmtDate(h.date));
    return `
      <article class="card app-card" style="--i:${Math.min(i, 12)}" data-id="${esc(h.id)}">
        <div class="app-top">
          <div class="avatar" style="background:linear-gradient(135deg,hsl(${hue} 62% 46%),hsl(${(hue + 40) % 360} 62% 36%))">${esc(h.name.charAt(0))}</div>
          <div class="app-meta">
            <div class="app-name" title="${esc(h.name)}">${esc(h.name)}</div>
            <div class="app-url" title="${esc(h.url)}">${esc(h.url.replace('https://', ''))}</div>
          </div>
        </div>
        <div class="chips">${chips}</div>
        <div class="app-info">${info}</div>
        ${ok ? '' : `<div class="app-error">${esc(h.error)}</div>`}
        <div class="app-actions">
          ${ok && h.exePath ? `<button class="btn filled ripple" data-act="run">${icon('play')}Çalıştır</button>` : ''}
          ${ok ? `<button class="btn tonal ripple" data-act="open">${icon('folder')}Klasör</button>` : `<button class="btn tonal ripple" data-act="retry">${icon('refresh')}Tekrar dene</button>`}
          <span class="spacer"></span>
          <button class="icon-btn danger ripple" data-act="delete" title="Sil">${icon('delete')}</button>
        </div>
      </article>`;
  }).join('');
  updateBusyUI();
}

function confirmDialog({ title, text, withFiles }) {
  return new Promise((resolve) => {
    const dlg = $('#confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-files').checked = false;
    $('#confirm-check-row').hidden = !withFiles;
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve({ ok: dlg.returnValue === 'ok', files: $('#confirm-files').checked }), { once: true });
    dlg.showModal();
  });
}

$('#history').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.app-card').dataset.id;
  const entry = state.history.find((h) => h.id === id);
  if (!entry) return;

  if (btn.dataset.act === 'run') {
    const r = await window.api.runApp(id);
    if (!r.ok) toast(r.error);
  } else if (btn.dataset.act === 'open') {
    const r = await window.api.openPath(entry.outputPath);
    if (!r.ok) toast(r.error);
  } else if (btn.dataset.act === 'retry') {
    $('#repo-url').value = entry.url + (entry.branch ? `/tree/${entry.branch}` : '');
    startCompile();
  } else if (btn.dataset.act === 'delete') {
    const ok = entry.status === 'success';
    const res = await confirmDialog({
      title: `${entry.name} silinsin mi?`,
      text: 'Kayıt geçmişten kaldırılır.',
      withFiles: ok,
    });
    if (!res.ok) return;
    const r = await window.api.deleteEntry(id, res.files);
    if (!r.ok) { toast(r.error); return; }
    applyState(r.state);
    renderHistory();
    toast('Silindi.');
  }
});

function renderSettings() {
  const s = state.settings;
  $('#set-output').textContent = state.outDir;
  $('#hero-out').textContent = state.outDir;
  $('#set-platform').value = s.platform;
  $('#set-arch').value = s.arch;
  $('#set-electron').value = s.electronVersion;
  $('#set-legacy').checked = s.legacyPeerDeps;
  $('#set-keep').checked = s.keepTemp;
  $('#sys-info').innerHTML = `v${esc(state.version)}<br>${esc(state.platform)} · ${esc(state.arch)}`;
}

$('#btn-choose').addEventListener('click', async () => {
  const dir = await window.api.chooseFolder();
  if (dir && (await saveSettings({ outputDir: dir }))) { renderSettings(); toast('Çıktı klasörü güncellendi.'); }
});
$('#btn-reset-out').addEventListener('click', async () => {
  if (await saveSettings({ outputDir: '' })) { renderSettings(); toast('Varsayılan klasöre dönüldü.'); }
});
$('#btn-open-out').addEventListener('click', async () => {
  const r = await window.api.openPath(state.outDir);
  if (!r.ok) toast('Klasör henüz oluşturulmadı.');
});
$('#set-platform').addEventListener('change', (e) => saveSettings({ platform: e.target.value }));
$('#set-arch').addEventListener('change', (e) => saveSettings({ arch: e.target.value }));
$('#set-electron').addEventListener('change', async (e) => {
  if (!(await saveSettings({ electronVersion: e.target.value.trim() }))) renderSettings();
  else toast('Electron sürümü kaydedildi.');
});
$('#set-legacy').addEventListener('change', (e) => saveSettings({ legacyPeerDeps: e.target.checked }));
$('#set-keep').addEventListener('change', (e) => saveSettings({ keepTemp: e.target.checked }));
$('#btn-clear-history').addEventListener('click', async () => {
  const res = await confirmDialog({ title: 'Geçmiş temizlensin mi?', text: 'Tüm kayıtlar listeden kaldırılır. Derlenmiş dosyalar diskte kalır.', withFiles: false });
  if (!res.ok) return;
  const r = await window.api.clearHistory();
  if (r.ok) { applyState(r.state); renderHistory(); toast('Geçmiş temizlendi.'); }
});

$('#swatches').innerHTML = ACCENTS.map(([name, hex]) =>
  `<button class="swatch ripple" title="${name}" data-color="${hex}" style="background:${hex};color:${hex}"><span style="color:${onColor(hex)};display:grid">${icon('check')}</span></button>`
).join('');

$('#theme-grid').addEventListener('click', async (e) => {
  const card = e.target.closest('.theme-card');
  if (card && (await saveSettings({ theme: card.dataset.themeVal }))) applyTheme();
});
$('#swatches').addEventListener('click', async (e) => {
  const sw = e.target.closest('.swatch');
  if (sw && (await saveSettings({ accent: sw.dataset.color }))) applyTheme();
});
$('#accent-custom').addEventListener('input', (e) => {
  state.settings.accent = e.target.value;
  applyTheme();
});
$('#accent-custom').addEventListener('change', (e) => saveSettings({ accent: e.target.value }));

(async function init() {
  applyState(await window.api.getState());
  applyTheme();
  renderSettings();
  renderHistory();
  updateBusyUI();
})();
