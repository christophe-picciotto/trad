// Logique de la fenetre "main" du POC Trad (moteur API Anthropic).
// Vanilla JS, AUCUN import : utilise window.__TAURI__ (withGlobalTauri actif).
//
// Pont : UI --invoke('translate', {text, targetLang, model, saveHistory})--> commands::translate
//        commands::translate --emit("trad:chunk"|"trad:done"|"trad:error")--> listen ci-dessous
//        commands::translate --emit("trad:history", entree)--> liste de gauche

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $source = document.getElementById('source');
const $target = document.getElementById('target');
const $lang = document.getElementById('lang');
const $model = document.getElementById('model');
const $btn = document.getElementById('translate-btn');
const $copy = document.getElementById('copy-btn');
const $status = document.getElementById('status');

const $settingsBtn = document.getElementById('settings-btn');
const $settingsPanel = document.getElementById('settings-panel');
const $apiKey = document.getElementById('api-key');
const $saveKey = document.getElementById('save-key-btn');
const $clearKey = document.getElementById('clear-key-btn');
const $keyStatus = document.getElementById('key-status');

const $histBtn = document.getElementById('history-btn');
const $histPanel = document.getElementById('history-panel');
const $histList = document.getElementById('history-list');
const $histEmpty = document.getElementById('history-empty');
const $histSearch = document.getElementById('history-search');
const $histClear = document.getElementById('history-clear-btn');
const $histEnabled = document.getElementById('history-enabled');

let hasKey = false;

function setStatus(msg, kind) {
  $status.textContent = msg || '';
  $status.dataset.kind = kind || '';
}
function setBusy(busy) {
  $btn.disabled = busy;
}
function setKeyStatus(msg, ok) {
  $keyStatus.textContent = msg || '';
  $keyStatus.dataset.ok = ok ? '1' : '0';
}

// --- Preferences persistees (modele, langue, affichage + activation historique) ---
const PREFS = 'tradPrefs';
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || '{}');
    if (p.model) $model.value = p.model;
    if (p.lang) $lang.value = p.lang;
    if (p.histEnabled === false) $histEnabled.checked = false;
    if (p.histShown === false) toggleHistoryPanel(false);
  } catch {}
}
function savePrefs() {
  try {
    localStorage.setItem(
      PREFS,
      JSON.stringify({
        model: $model.value,
        lang: $lang.value,
        histEnabled: $histEnabled.checked,
        histShown: !$histPanel.hidden,
      })
    );
  } catch {}
}
$model.addEventListener('change', savePrefs);
$lang.addEventListener('change', savePrefs);
$histEnabled.addEventListener('change', savePrefs);

// --- Etat cle API ---
async function refreshKeyState() {
  try {
    hasKey = await invoke('has_api_key');
  } catch {
    hasKey = false;
  }
  if (hasKey) {
    setKeyStatus('Cle enregistree.', true);
  } else {
    setKeyStatus('Aucune cle enregistree.', false);
    $settingsPanel.hidden = false; // ouvrir d'office si pas de cle
    setStatus('Renseignez votre cle API pour commencer.', 'error');
  }
}

$settingsBtn.addEventListener('click', () => {
  $settingsPanel.hidden = !$settingsPanel.hidden;
  if (!$settingsPanel.hidden) $apiKey.focus();
});

$saveKey.addEventListener('click', async () => {
  const key = ($apiKey.value || '').trim();
  if (!key) {
    setKeyStatus('Saisissez une cle.', false);
    return;
  }
  try {
    await invoke('save_api_key', { key });
    $apiKey.value = '';
    hasKey = true;
    setKeyStatus('Cle enregistree.', true);
    setStatus('', '');
    $settingsPanel.hidden = true;
  } catch (err) {
    setKeyStatus('Echec : ' + (err?.message || err), false);
  }
});

$clearKey.addEventListener('click', async () => {
  try {
    await invoke('clear_api_key');
    hasKey = false;
    setKeyStatus('Cle effacee.', false);
  } catch (err) {
    setKeyStatus('Echec : ' + (err?.message || err), false);
  }
});

// =========================================================================
//  Historique local
//  Source de verite = le fichier JSON cote Rust (%APPDATA%\app.trad.desktop).
//  `items` n'en est qu'un cache d'affichage, recharge au demarrage.
// =========================================================================
let items = [];
let selectedId = null;

const LANG_BADGE = {
  francais: 'FR', anglais: 'EN', espagnol: 'ES',
  allemand: 'DE', italien: 'IT', portugais: 'PT',
};

/// Minuscules sans accents : "Chatillon" et "Châtillon" doivent matcher.
function fold(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/// Heure seule si c'est aujourd'hui, sinon date courte + heure.
function formatDate(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' + time;
}

/// Construit une entree de la liste.
/// IMPORTANT : tout le texte passe par textContent, JAMAIS innerHTML -- le contenu
/// vient du presse-papier de l'utilisateur et peut contenir du HTML arbitraire.
function renderItem(entry) {
  const li = document.createElement('li');
  li.className = 'history-item';
  li.dataset.id = entry.id;
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  if (entry.id === selectedId) li.setAttribute('aria-current', 'true');

  const meta = document.createElement('div');
  meta.className = 'history-meta';
  const lang = document.createElement('span');
  lang.className = 'history-lang';
  lang.textContent = LANG_BADGE[entry.targetLang] || (entry.targetLang || '').slice(0, 2).toUpperCase();
  const when = document.createElement('span');
  when.textContent = formatDate(entry.ts);
  meta.append(lang, when);

  const src = document.createElement('p');
  src.className = 'history-source';
  src.textContent = entry.source;

  const trad = document.createElement('p');
  trad.className = 'history-translation';
  trad.textContent = entry.translation;

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'history-del';
  del.title = 'Supprimer cette traduction';
  del.setAttribute('aria-label', 'Supprimer cette traduction');
  del.textContent = '×';

  li.append(meta, src, trad, del);
  return li;
}

/// Redessine la liste en appliquant le filtre de recherche.
function renderHistory() {
  const q = fold($histSearch.value.trim());
  const shown = q
    ? items.filter((e) => fold(e.source).includes(q) || fold(e.translation).includes(q))
    : items;

  $histList.replaceChildren(...shown.map(renderItem));

  if (shown.length === 0) {
    $histEmpty.hidden = false;
    $histEmpty.textContent = items.length === 0
      ? 'Aucune traduction enregistree pour l\'instant.'
      : 'Aucun resultat pour cette recherche.';
  } else {
    $histEmpty.hidden = true;
  }
}

async function loadHistory() {
  try {
    items = await invoke('history_list');
  } catch {
    items = [];
  }
  renderHistory();
}

/// Recharge la source ET la traduction d'une entree, sans rappeler l'API.
function restoreEntry(entry) {
  selectedId = entry.id;
  $source.value = entry.source;
  $target.value = entry.translation;
  if ([...$lang.options].some((o) => o.value === entry.targetLang)) $lang.value = entry.targetLang;
  if ([...$model.options].some((o) => o.value === entry.model)) $model.value = entry.model;
  setStatus('Traduction rechargee depuis l\'historique.', 'ok');
  renderHistory();
}

async function deleteEntry(id) {
  try {
    await invoke('history_delete', { id });
    items = items.filter((e) => e.id !== id);
    if (selectedId === id) selectedId = null;
    renderHistory();
  } catch (err) {
    setStatus('Suppression impossible : ' + (err?.message || err), 'error');
  }
}

// Delegation : un seul listener pour toute la liste, meme quand elle est redessinee.
$histList.addEventListener('click', (e) => {
  const li = e.target.closest('.history-item');
  if (!li) return;
  const entry = items.find((x) => x.id === li.dataset.id);
  if (!entry) return;
  if (e.target.closest('.history-del')) {
    deleteEntry(entry.id);
  } else {
    restoreEntry(entry);
  }
});

// Navigation clavier dans la liste.
$histList.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const li = e.target.closest('.history-item');
  if (!li) return;
  e.preventDefault();
  const entry = items.find((x) => x.id === li.dataset.id);
  if (entry) restoreEntry(entry);
});

$histSearch.addEventListener('input', renderHistory);

// "Vider" : premier clic = armement, second = execution. Pas de confirm() natif,
// qui bloquerait la WebView (et avec elle le reste de l'app).
let clearArmed = null;
function disarmClear() {
  clearTimeout(clearArmed);
  clearArmed = null;
  $histClear.dataset.confirm = '0';
  $histClear.textContent = 'Vider';
}
$histClear.addEventListener('click', async () => {
  if (!clearArmed) {
    $histClear.dataset.confirm = '1';
    $histClear.textContent = 'Confirmer ?';
    clearArmed = setTimeout(disarmClear, 4000);
    return;
  }
  disarmClear();
  try {
    await invoke('history_clear');
    items = [];
    selectedId = null;
    renderHistory();
    setStatus('Historique efface.', 'ok');
  } catch (err) {
    setStatus('Effacement impossible : ' + (err?.message || err), 'error');
  }
});

function toggleHistoryPanel(show) {
  const visible = show ?? $histPanel.hidden;
  $histPanel.hidden = !visible;
  $histBtn.setAttribute('aria-expanded', String(visible));
}
$histBtn.addEventListener('click', () => {
  toggleHistoryPanel();
  savePrefs();
});

// --- Events moteur (Rust -> ici). payload chunk = traduction complete. ---
listen('trad:chunk', (e) => {
  $target.value = typeof e.payload === 'string' ? e.payload : String(e.payload ?? '');
});
listen('trad:done', () => {
  setBusy(false);
  setStatus('Termine.', 'ok');
});
listen('trad:error', (e) => {
  setBusy(false);
  setStatus('Erreur : ' + (e.payload ?? 'inconnue'), 'error');
});

// Nouvelle entree enregistree cote Rust : on l'insere en tete sans relire le fichier.
// Le backend dedoublonne (meme source + meme langue) -> on fait pareil dans le cache.
listen('trad:history', (e) => {
  const entry = e.payload;
  if (!entry || !entry.id) return;
  items = items.filter(
    (x) => !(x.source === entry.source && x.targetLang === entry.targetLang)
  );
  items.unshift(entry);
  // Meme plafond que MAX_ENTRIES cote Rust, pour ne pas afficher des entrees
  // que le backend vient de faire tomber du fichier.
  if (items.length > 300) items.length = 300;
  selectedId = entry.id;
  renderHistory();
});

// --- Geste global Ctrl+C+C : le backend envoie le texte selectionne ---
listen('hotkey:translate', (e) => {
  const text = typeof e.payload === 'string' ? e.payload : String(e.payload ?? '');
  if (!text.trim()) return;
  $source.value = text;
  if (!hasKey) {
    $settingsPanel.hidden = false;
    setStatus('Renseignez d\'abord votre cle API.', 'error');
    return;
  }
  doTranslate();
});

// --- Action Traduire ---
async function doTranslate() {
  const text = ($source.value || '').trim();
  if (!text) {
    setStatus('Saisissez un texte a traduire.', 'error');
    return;
  }
  if (!hasKey) {
    $settingsPanel.hidden = false;
    $apiKey.focus();
    setStatus('Renseignez d\'abord votre cle API.', 'error');
    return;
  }
  const targetLang = $lang.value || 'francais';
  const model = $model.value || 'claude-opus-4-8';
  $target.value = '';
  selectedId = null;
  setBusy(true);
  setStatus('Traduction en cours...', 'busy');
  try {
    await invoke('translate', { text, targetLang, model, saveHistory: $histEnabled.checked });
    // La suite arrive via les events trad:* .
  } catch (err) {
    setBusy(false);
    setStatus('Erreur : ' + (err?.message || err), 'error');
  }
}

$btn.addEventListener('click', doTranslate);

// Ctrl/Cmd+Entree dans la zone source = traduire.
$source.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    doTranslate();
  }
});

// --- Copier la traduction ---
$copy.addEventListener('click', async () => {
  const t = $target.value || '';
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    setStatus('Traduction copiee.', 'ok');
  } catch {
    $target.removeAttribute('readonly');
    $target.select();
    document.execCommand('copy');
    $target.setAttribute('readonly', '');
    setStatus('Traduction copiee.', 'ok');
  }
});

// --- Init ---
loadPrefs();
refreshKeyState();
loadHistory();
