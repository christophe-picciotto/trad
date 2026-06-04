// Logique de la fenetre "main" du POC Trad (moteur API Anthropic).
// Vanilla JS, AUCUN import : utilise window.__TAURI__ (withGlobalTauri actif).
//
// Pont : UI --invoke('translate', {text, targetLang, model})--> commands::translate
//        commands::translate --emit("trad:chunk"|"trad:done"|"trad:error")--> listen ci-dessous

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

// --- Preferences persistees (modele + langue) ---
const PREFS = 'tradPrefs';
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || '{}');
    if (p.model) $model.value = p.model;
    if (p.lang) $lang.value = p.lang;
  } catch {}
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS, JSON.stringify({ model: $model.value, lang: $lang.value }));
  } catch {}
}
$model.addEventListener('change', savePrefs);
$lang.addEventListener('change', savePrefs);

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
  setBusy(true);
  setStatus('Traduction en cours...', 'busy');
  try {
    await invoke('translate', { text, targetLang, model });
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
