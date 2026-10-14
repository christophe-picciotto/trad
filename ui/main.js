// Logique de la fenetre "main" de Trad (moteur API Anthropic).
// Vanilla JS, AUCUN import : utilise window.__TAURI__ (withGlobalTauri actif) et
// window.TRAD_I18N (ui/i18n.js, charge juste avant ce fichier).
//
// Pont : UI --invoke('translate', {text, targetLang, model, saveHistory})--> commands::translate
//        commands::translate --emit("trad:chunk"|"trad:stats"|"trad:done"|"trad:error")--> listen ci-dessous
//        commands::translate --emit("trad:history", entree)--> liste de gauche
//        UI --invoke('set_tray_labels', {open, quit, tooltip})--> menu de l'icone (barre systeme)

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
const $uiLang = document.getElementById('ui-lang');

const $statsMain = document.getElementById('stats-main');

const $histBtn = document.getElementById('history-btn');
const $histPanel = document.getElementById('history-panel');
const $histList = document.getElementById('history-list');
const $histEmpty = document.getElementById('history-empty');
const $histSearch = document.getElementById('history-search');
const $histClear = document.getElementById('history-clear-btn');
const $histEnabled = document.getElementById('history-enabled');
const $histTotal = document.getElementById('history-total');
const $resizer = document.getElementById('history-resizer');

let hasKey = false;

// =========================================================================
//  Langue de l'interface
//  Choix memorise dans les preferences : 'auto' (defaut) = langue de Windows,
//  relue a chaque demarrage, anglais si elle n'est pas traduite.
// =========================================================================
const I18N = window.TRAD_I18N;
/// Langues de l'interface ET langues cibles proposees (memes codes BCP 47).
const LANGUES = Object.keys(I18N);
const LANGUES_RTL = new Set(['ar']);
let uiLang = 'en';

const estLangue = (code) => LANGUES.includes(code);

/// Langue du systeme parmi celles qui sont traduites ; anglais par defaut.
/// WebView2 expose les langues preferees de Windows dans navigator.languages.
function detecterLangue() {
  const demandees = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of demandees) {
    let loc;
    try {
      // maximize() complete la region et l'ecriture : "pt" -> pt-Latn-BR, "zh-TW" -> zh-Hant-TW.
      loc = new Intl.Locale(tag).maximize();
    } catch {
      continue;
    }
    if (loc.language === 'pt') return loc.region === 'BR' ? 'pt-BR' : 'pt-PT';
    if (loc.language === 'zh') {
      if (loc.script === 'Hans') return 'zh-CN';
      continue; // chinois traditionnel : pas traduit, on essaie la langue suivante
    }
    if (estLangue(loc.language)) return loc.language;
  }
  return 'en';
}

/// Texte traduit. Cle absente : repli sur l'anglais, puis sur la cle elle-meme.
/// En arabe (rtl), chaque valeur inseree est ISOLEE (U+2068 ... U+2069) : un message de
/// l'API en anglais ou un montant ne melange pas sa ponctuation avec celle de la phrase.
function t(cle, params) {
  let s = I18N[uiLang]?.[cle] ?? I18N.en[cle] ?? cle;
  if (params) {
    const rtl = LANGUES_RTL.has(uiLang);
    s = s.replace(/\{(\w+)\}/g, (m, k) => {
      if (!(k in params)) return m;
      const v = String(params[k]);
      return rtl ? '\u2068' + v + '\u2069' : v;
    });
  }
  return s;
}

// Formats de nombres, durees et montants : ceux de la langue de l'interface.
let fmtNombre, fmtSecondes, fmtCoutFin, fmtCoutLarge;
function majFormateurs() {
  fmtNombre = new Intl.NumberFormat(uiLang);
  fmtSecondes = new Intl.NumberFormat(uiLang, {
    style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: 1,
  });
  fmtCoutFin = new Intl.NumberFormat(uiLang, {
    style: 'currency', currency: 'USD', maximumSignificantDigits: 2,
  });
  fmtCoutLarge = new Intl.NumberFormat(uiLang, {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

/// Cout en dollars : 2 chiffres significatifs sous 0,10 $ (une traduction Haiku coute
/// ~0,0001 $ : arrondi au centime, tout afficherait 0,00 $), centimes a partir de 0,10 $
/// (0,30 $ et non « 0,3 $ », 1,00 $ et non « 1 $ »). Zero : « 0,00 $ ». Frontiere a
/// 0,0995 et non 0,1 : de 0,0995 a 0,0999, 2 chiffres significatifs arrondissent deja a
/// « 0,1 $ » ; le format centimes y affiche « 0,10 $ ».
/// En arabe (rtl), le montant est isole en gauche-a-droite (U+2066 ... U+2069) : sans ca,
/// l'algorithme bidi affiche « $US » au lieu de « US$ ».
function formatCout(usd) {
  const s = (usd >= 0.0995 || usd === 0 ? fmtCoutLarge : fmtCoutFin).format(usd);
  return LANGUES_RTL.has(uiLang) ? '\u2066' + s.replace(/^\u200f/, '') + '\u2069' : s;
}

/// Nom d'une langue cible dans la langue de l'interface (API Intl : rien a traduire
/// a la main). Repli : son nom dans sa propre langue.
function nomLangue(code, noms) {
  try {
    const nom = noms.of(code === 'zh-CN' ? 'zh-Hans' : code);
    if (nom && nom !== code) return nom.charAt(0).toLocaleUpperCase(uiLang) + nom.slice(1);
  } catch {}
  return I18N[code]?._name || code;
}

/// Liste « Traduire vers » : noms traduits, tries dans l'ordre alphabetique de la
/// langue de l'interface. Le choix en cours est conserve.
function remplirLanguesCibles() {
  const choisie = $lang.value;
  let noms = null;
  try {
    noms = new Intl.DisplayNames([uiLang], { type: 'language', languageDisplay: 'standard' });
  } catch {}
  const options = LANGUES.map((code) => ({ code, nom: noms ? nomLangue(code, noms) : I18N[code]._name }))
    .sort((a, b) => a.nom.localeCompare(b.nom, uiLang));
  $lang.replaceChildren(...options.map(({ code, nom }) => new Option(nom, code)));
  if (choisie) $lang.value = choisie;
}

/// Liste « Langue de l'interface » : Automatique (langue detectee), puis chaque
/// langue ecrite dans sa propre langue, pour qu'on la retrouve meme sans la lire.
function remplirLanguesInterface() {
  const auto = new Option(t('settings.uiLangAuto', { lang: I18N[detecterLangue()]._name }), 'auto');
  const autres = LANGUES.map((code) => {
    const o = new Option(I18N[code]._name, code);
    o.lang = code;
    return o;
  });
  $uiLang.replaceChildren(auto, ...autres);
  $uiLang.value = estLangue(prefs.uiLang) ? prefs.uiLang : 'auto';
}

/// (Re)traduit toute l'interface : au demarrage et a chaque changement de langue.
function appliquerLangue() {
  uiLang = estLangue(prefs.uiLang) ? prefs.uiLang : detecterLangue();
  document.documentElement.lang = uiLang;
  document.documentElement.dir = LANGUES_RTL.has(uiLang) ? 'rtl' : 'ltr';
  majFormateurs();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  }
  remplirLanguesCibles();
  remplirLanguesInterface();
  disarmClear(); // sinon « Confirmer ? » resterait affiche dans l'ancienne langue
  rafraichirStatut();
  rafraichirStatutCle();
  renderHistory();
  renderStats();
  majTray();
}

/// Menu de l'icone de la barre systeme, dans la langue de l'interface.
function majTray() {
  invoke('set_tray_labels', { open: t('tray.open'), quit: t('tray.quit'), tooltip: t('tray.tooltip') })
    .catch(() => {}); // cosmetique : un echec ne doit rien bloquer
}

// --- Statut et etat de la cle ---------------------------------------------
// Gardes sous forme de FONCTIONS de rendu : un changement de langue les reaffiche
// dans la nouvelle langue au lieu de laisser l'ancien texte.
let statut = null;
let statutCle = null;

const msg = (cle, params) => () => t(cle, params);
/// Une erreur connue du Rust ({code}) est deja une phrase complete (« Erreur de l'API : … ») :
/// l'envelopper dans « Erreur : … » doublerait le prefixe. Les chaines brutes (erreurs
/// internes de Tauri) gardent le prefixe.
const msgErreur = (err) => () =>
  err && typeof err === 'object' && typeof err.code === 'string'
    ? texteErreur(err)
    : t('status.error', { detail: texteErreur(err) });

function setStatus(rendu, kind) {
  statut = rendu ? { rendu, kind: kind || '' } : null;
  rafraichirStatut();
}
function rafraichirStatut() {
  $status.textContent = statut ? statut.rendu() : '';
  $status.dataset.kind = statut ? statut.kind : '';
}
function setBusy(busy) {
  $btn.disabled = busy;
}
function setKeyStatus(rendu, ok) {
  statutCle = rendu ? { rendu, ok } : null;
  rafraichirStatutCle();
}
function rafraichirStatutCle() {
  $keyStatus.textContent = statutCle ? statutCle.rendu() : '';
  $keyStatus.dataset.ok = statutCle?.ok ? '1' : '0';
}

/// Message d'une erreur venue du Rust ({code, detail}) dans la langue de l'interface.
function texteErreur(err) {
  if (err && typeof err === 'object' && typeof err.code === 'string') {
    if (err.code === 'refusal') {
      return t('err.refusal', { detail: err.detail || t('err.refusalUnknown') });
    }
    const cle = 'err.' + err.code;
    if (Object.hasOwn(I18N.en, cle)) return t(cle, { detail: err.detail ?? '' });
    return [t('err.unknown'), err.code, err.detail].filter(Boolean).join(' — ');
  }
  if (typeof err === 'string' && err) return err;
  return err?.message || t('err.unknown');
}

// --- Preferences persistees (modele, langues, historique, largeur) ---------
const PREFS = 'tradPrefs';
let prefs = {};

// Valeurs retirees -> leur remplacant. Sans ca, un <select> qui recoit une valeur
// absente se vide, et doTranslate() retomberait en silence sur Opus 4.8.
const MODELES_REMPLACES = { 'claude-haiku-4-5': 'claude-haiku-5-5' };
// Langues cibles d'avant le 14/10/2026 (noms francais) -> codes.
const LANGUES_ANCIENNES = {
  francais: 'fr', anglais: 'en', espagnol: 'es', allemand: 'de', italien: 'it', portugais: 'pt-PT',
};

function lirePrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || '{}');
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}

/// Ecrit les preferences EN PARTANT des valeurs existantes : une cle qu'on ne connait
/// pas ici n'est jamais perdue.
function savePrefs() {
  prefs = {
    ...prefs,
    model: $model.value,
    lang: $lang.value,
    uiLang: $uiLang.value || 'auto',
    histEnabled: $histEnabled.checked,
    histShown: !$histPanel.hidden,
    histWidth: largeurVoulue,
  };
  try {
    localStorage.setItem(PREFS, JSON.stringify(prefs));
  } catch {}
}

function appliquerPrefs() {
  const model = MODELES_REMPLACES[prefs.model] || prefs.model;
  if ([...$model.options].some((o) => o.value === model)) $model.value = model;
  const cible = LANGUES_ANCIENNES[prefs.lang] || prefs.lang;
  // Premier lancement : on traduit vers la langue de l'interface.
  $lang.value = estLangue(cible) ? cible : uiLang;
  if (prefs.histEnabled === false) $histEnabled.checked = false;
  if (prefs.histShown === false) toggleHistoryPanel(false);
  if (Number.isFinite(prefs.histWidth)) largeurVoulue = prefs.histWidth;
  appliquerLargeur();
}

$model.addEventListener('change', savePrefs);
$lang.addEventListener('change', savePrefs);
$histEnabled.addEventListener('change', savePrefs);
$uiLang.addEventListener('change', () => {
  savePrefs();
  appliquerLangue();
});

// --- Etat cle API ---
async function refreshKeyState() {
  try {
    hasKey = await invoke('has_api_key');
  } catch {
    hasKey = false;
  }
  if (hasKey) {
    setKeyStatus(msg('key.saved'), true);
  } else {
    setKeyStatus(msg('key.none'), false);
    afficherReglages(true); // ouvrir d'office si pas de cle
    setStatus(msg('status.enterKeyToStart'), 'error');
  }
}

/// Ouvre ou ferme le panneau des reglages (et tient a jour aria-expanded du bouton).
function afficherReglages(visible) {
  $settingsPanel.hidden = !visible;
  $settingsBtn.setAttribute('aria-expanded', String(visible));
}

$settingsBtn.addEventListener('click', () => {
  afficherReglages($settingsPanel.hidden);
  if (!$settingsPanel.hidden) $apiKey.focus();
});

$saveKey.addEventListener('click', async () => {
  const key = ($apiKey.value || '').trim();
  if (!key) {
    setKeyStatus(msg('key.enter'), false);
    return;
  }
  try {
    await invoke('save_api_key', { key });
    $apiKey.value = '';
    hasKey = true;
    setKeyStatus(msg('key.saved'), true);
    setStatus(null);
    afficherReglages(false);
    $settingsBtn.focus(); // le focus etait dans le panneau qui vient de se fermer
  } catch (err) {
    setKeyStatus(() => t('key.failed', { detail: texteErreur(err) }), false);
  }
});

$clearKey.addEventListener('click', async () => {
  try {
    await invoke('clear_api_key');
    hasKey = false;
    setKeyStatus(msg('key.removed'), false);
  } catch (err) {
    setKeyStatus(() => t('key.failed', { detail: texteErreur(err) }), false);
  }
});

// =========================================================================
//  Statistiques (barre sous la barre d'outils) : la derniere traduction, ou
//  l'entree rechargee depuis l'historique. Le total est en pied d'historique.
// =========================================================================
const NOMS_MODELES = [
  ['claude-opus-4-8', 'Opus 4.8'],
  ['claude-sonnet-4-6', 'Sonnet 4.6'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-haiku-4-5', 'Haiku 4.5'],
];
function nomModele(id) {
  const trouve = NOMS_MODELES.find(([prefixe]) => (id || '').startsWith(prefixe));
  return trouve ? trouve[1] : id || '';
}

/// null = aucune traduction encore ; { enCours: true } = traduction en cours (rien a
/// gauche : le statut a droite dit « Traduction en cours… ») ; { manquantes: true } =
/// ancienne entree sans statistiques ; sinon { origine: 'last' | 'history', model, ... }.
let statsAffichees = null;

function morceau(texte, classe, titre) {
  const span = document.createElement('span');
  span.className = classe ? 'stats-item ' + classe : 'stats-item';
  span.textContent = texte;
  if (titre) span.title = titre;
  return span;
}

function renderStats() {
  const s = statsAffichees;
  if (!s) {
    $statsMain.replaceChildren(morceau(t('stats.none'), 'stats-hint'));
  } else if (s.enCours) {
    $statsMain.replaceChildren();
  } else if (s.manquantes) {
    $statsMain.replaceChildren(
      morceau(t('stats.fromHistory'), 'stats-title'),
      morceau(t('stats.noData'), 'stats-hint')
    );
  } else {
    const parts = [
      morceau(t(s.origine === 'history' ? 'stats.fromHistory' : 'stats.last'), 'stats-title'),
      morceau(nomModele(s.model), 'stats-model'),
    ];
    if (Number.isFinite(s.inputTokens)) {
      parts.push(morceau(t('stats.sent', { n: fmtNombre.format(s.inputTokens) }), '', t('stats.sentTitle')));
    }
    if (Number.isFinite(s.outputTokens)) {
      parts.push(morceau(t('stats.received', { n: fmtNombre.format(s.outputTokens) })));
    }
    if (Number.isFinite(s.durationMs)) {
      parts.push(morceau(t('stats.duration', { t: fmtSecondes.format(s.durationMs / 1000) })));
    }
    if (Number.isFinite(s.costUsd)) {
      // Estimation d'apres la grille de tarifs de tarifs.rs, pas une facture : l'infobulle le dit.
      parts.push(morceau(t('stats.cost', { cost: formatCout(s.costUsd) }), 'stats-cost', t('stats.costTitle')));
    }
    $statsMain.replaceChildren(...parts);
  }
}

// =========================================================================
//  Historique local
//  Source de verite = le fichier JSON cote Rust (%APPDATA%\app.trad.desktop).
//  `items` n'en est qu'un cache d'affichage, recharge au demarrage.
// =========================================================================
let items = [];
let selectedId = null;

/// Badge de langue d'une entree : code court ("EN", "PT-BR").
function badgeLangue(code) {
  const c = LANGUES_ANCIENNES[code] || code || '';
  if (c === 'zh-CN') return 'ZH';
  if (c === 'pt-PT') return 'PT';
  return c.toUpperCase();
}

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
  const time = d.toLocaleTimeString(uiLang, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  return d.toLocaleDateString(uiLang, { day: '2-digit', month: '2-digit' }) + ' ' + time;
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
  lang.textContent = badgeLangue(entry.targetLang);
  const when = document.createElement('span');
  when.textContent = formatDate(entry.ts);
  meta.append(lang, when);
  // Cout de la traduction, aligne en face (les anciennes entrees n'en ont pas).
  if (Number.isFinite(entry.costUsd)) {
    const cout = document.createElement('span');
    cout.className = 'history-cost';
    cout.title = t('history.costTitle');
    cout.textContent = formatCout(entry.costUsd);
    meta.append(cout);
  }

  const src = document.createElement('p');
  src.className = 'history-source';
  src.dir = 'auto';
  src.textContent = entry.source;

  const trad = document.createElement('p');
  trad.className = 'history-translation';
  trad.dir = 'auto';
  trad.textContent = entry.translation;

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'history-del';
  del.title = t('history.delete');
  del.setAttribute('aria-label', t('history.delete'));
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
    $histEmpty.textContent = items.length === 0 ? t('history.empty') : t('history.noResults');
  } else {
    $histEmpty.hidden = true;
  }

  // Pied : cout total de TOUT l'historique (pas seulement des resultats filtres),
  // limite aux entrees qui ont un cout -- les anciennes n'en ont pas.
  const avecCout = items.filter((e) => Number.isFinite(e.costUsd));
  $histTotal.hidden = avecCout.length === 0;
  if (avecCout.length) {
    const total = avecCout.reduce((somme, e) => somme + e.costUsd, 0);
    $histTotal.textContent = t('history.total', { cost: formatCout(total) });
    $histTotal.title = t('history.totalTitle', { n: fmtNombre.format(avecCout.length) });
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

/// Recharge la source, la traduction et ses statistiques, sans rappeler l'API.
function restoreEntry(entry) {
  selectedId = entry.id;
  $source.value = entry.source;
  $target.value = entry.translation;
  const cible = LANGUES_ANCIENNES[entry.targetLang] || entry.targetLang;
  if (estLangue(cible)) $lang.value = cible;
  const model = MODELES_REMPLACES[entry.model] || entry.model;
  if ([...$model.options].some((o) => o.value === model)) $model.value = model;
  statsAffichees = Number.isFinite(entry.inputTokens) || Number.isFinite(entry.costUsd)
    ? {
        origine: 'history',
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        durationMs: entry.durationMs,
        costUsd: entry.costUsd,
      }
    : { manquantes: true };
  // La barre d'etat titre deja « Depuis l'historique » : un message en plus ferait doublon
  // (et passerait la barre sur deux lignes). On efface juste l'ancien (« Termine. »...).
  setStatus(null);
  renderHistory();
  renderStats();
}

/// La barre d'etat montre-t-elle une entree rechargee depuis l'historique ?
const statsDeLHistorique = () =>
  !!statsAffichees && (statsAffichees.origine === 'history' || !!statsAffichees.manquantes);

async function deleteEntry(id) {
  try {
    await invoke('history_delete', { id });
    items = items.filter((e) => e.id !== id);
    if (selectedId === id) {
      selectedId = null;
      // L'entree affichee « depuis l'historique » n'y est plus : la barre ne doit plus le dire.
      if (statsDeLHistorique()) {
        statsAffichees = null;
        renderStats();
      }
    }
    renderHistory();
  } catch (err) {
    setStatus(() => t('history.deleteFailed', { detail: texteErreur(err) }), 'error');
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
  // Sur la croix « × », laisser le bouton faire son clic natif (= supprimer) : sans ce
  // retour, Entree/Espace sur la croix RESTAURAIT l'entree au lieu de la supprimer.
  if (e.target.closest('.history-del')) return;
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
  $histClear.textContent = t('history.clear');
}
$histClear.addEventListener('click', async () => {
  if (!clearArmed) {
    $histClear.dataset.confirm = '1';
    $histClear.textContent = t('history.confirm');
    clearArmed = setTimeout(disarmClear, 4000);
    return;
  }
  disarmClear();
  try {
    await invoke('history_clear');
    items = [];
    selectedId = null;
    if (statsDeLHistorique()) {
      statsAffichees = null;
      renderStats();
    }
    renderHistory();
    setStatus(msg('status.historyCleared'), 'ok');
  } catch (err) {
    setStatus(() => t('history.clearFailed', { detail: texteErreur(err) }), 'error');
  }
});

function toggleHistoryPanel(show) {
  const visible = show ?? $histPanel.hidden;
  $histPanel.hidden = !visible;
  $resizer.hidden = !visible;
  $histBtn.setAttribute('aria-expanded', String(visible));
}
$histBtn.addEventListener('click', () => {
  toggleHistoryPanel();
  savePrefs();
});

// =========================================================================
//  Largeur de l'historique : poignee entre l'historique et les panneaux de texte.
//  Souris : glisser, double-clic = largeur par defaut. Clavier (motif « window
//  splitter ») : fleches (Maj = grands pas), Debut / Fin = minimum / maximum,
//  Entree = largeur par defaut.
// =========================================================================
const HIST_MIN = 180;
const HIST_DEFAUT = 250;
/// Largeur choisie par l'utilisateur (memorisee). L'affichage la borne a la fenetre
/// sans l'ecraser : une fenetre retrecie puis agrandie retrouve la largeur choisie.
let largeurVoulue = HIST_DEFAUT;

function borner(px) {
  const max = Math.max(HIST_MIN, Math.round(window.innerWidth * 0.5));
  return Math.min(Math.max(Math.round(px), HIST_MIN), max);
}
function appliquerLargeur() {
  const largeur = borner(largeurVoulue);
  $histPanel.style.setProperty('--history-width', largeur + 'px');
  $resizer.setAttribute('aria-valuemin', String(HIST_MIN));
  $resizer.setAttribute('aria-valuemax', String(borner(Infinity)));
  $resizer.setAttribute('aria-valuenow', String(largeur));
}
function choisirLargeur(px) {
  largeurVoulue = borner(px);
  appliquerLargeur();
}
const enRtl = () => document.documentElement.dir === 'rtl';

$resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  $resizer.setPointerCapture(e.pointerId);
  $resizer.dataset.dragging = '1';
  document.body.classList.add('resizing');
});
$resizer.addEventListener('pointermove', (e) => {
  if ($resizer.dataset.dragging !== '1') return;
  const r = $histPanel.getBoundingClientRect();
  // En arabe (rtl), l'historique est a droite : sa largeur se mesure depuis son bord droit.
  choisirLargeur(enRtl() ? r.right - e.clientX : e.clientX - r.left);
});
function finGlisser(e) {
  if ($resizer.dataset.dragging !== '1') return;
  delete $resizer.dataset.dragging;
  document.body.classList.remove('resizing');
  if ($resizer.hasPointerCapture(e.pointerId)) $resizer.releasePointerCapture(e.pointerId);
  savePrefs();
}
$resizer.addEventListener('pointerup', finGlisser);
$resizer.addEventListener('pointercancel', finGlisser);
$resizer.addEventListener('lostpointercapture', finGlisser);

$resizer.addEventListener('keydown', (e) => {
  const pas = e.shiftKey ? 50 : 10;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    // La fleche va dans le sens du bord qu'on deplace, quel que soit le sens d'ecriture.
    const versLaDroite = e.key === 'ArrowRight';
    choisirLargeur(borner(largeurVoulue) + (versLaDroite !== enRtl() ? pas : -pas));
  } else if (e.key === 'Home') {
    choisirLargeur(HIST_MIN);
  } else if (e.key === 'End') {
    choisirLargeur(Infinity);
  } else if (e.key === 'Enter') {
    choisirLargeur(HIST_DEFAUT);
  } else {
    return;
  }
  e.preventDefault();
  savePrefs();
});
$resizer.addEventListener('dblclick', () => {
  choisirLargeur(HIST_DEFAUT);
  savePrefs();
});
window.addEventListener('resize', appliquerLargeur);

// --- Events moteur (Rust -> ici). payload chunk = traduction complete. ---
listen('trad:chunk', (e) => {
  $target.value = typeof e.payload === 'string' ? e.payload : String(e.payload ?? '');
});
listen('trad:stats', (e) => {
  statsAffichees = { ...e.payload, origine: 'last' };
  renderStats();
});
listen('trad:done', () => {
  setBusy(false);
  setStatus(msg('status.done'), 'ok');
});
listen('trad:error', (e) => {
  setBusy(false);
  finAttenteStats();
  setStatus(msgErreur(e.payload), 'error');
});

/// Echec d'une traduction : la barre quitte l'etat « en cours » (vide) et retrouve
/// l'invite, masquee tant que l'erreur est affichee (CSS :has) puis visible ensuite.
function finAttenteStats() {
  if (statsAffichees?.enCours) {
    statsAffichees = null;
    renderStats();
  }
}

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
    afficherReglages(true);
    setStatus(msg('status.enterKeyFirst'), 'error');
    return;
  }
  doTranslate();
});

// --- Action Traduire ---
async function doTranslate() {
  const text = ($source.value || '').trim();
  if (!text) {
    setStatus(msg('status.enterText'), 'error');
    return;
  }
  if (!hasKey) {
    afficherReglages(true);
    $apiKey.focus();
    setStatus(msg('status.enterKeyFirst'), 'error');
    return;
  }
  const targetLang = $lang.value || uiLang;
  const model = $model.value || 'claude-opus-4-8';
  $target.value = '';
  selectedId = null;
  // Rien a gauche pendant l'appel : l'invite « prochaine traduction » serait trompeuse,
  // et les chiffres precedents decriraient une traduction qui n'est plus affichee.
  statsAffichees = { enCours: true };
  renderStats();
  setBusy(true);
  setStatus(msg('status.translating'), 'busy');
  try {
    await invoke('translate', { text, targetLang, model, saveHistory: $histEnabled.checked });
    // La suite arrive via les events trad:* .
  } catch (err) {
    setBusy(false);
    finAttenteStats();
    setStatus(msgErreur(err), 'error');
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
  const t0 = $target.value || '';
  if (!t0) return;
  try {
    await navigator.clipboard.writeText(t0);
    setStatus(msg('status.copied'), 'ok');
  } catch {
    $target.removeAttribute('readonly');
    $target.select();
    document.execCommand('copy');
    $target.setAttribute('readonly', '');
    setStatus(msg('status.copied'), 'ok');
  }
});

// --- Init ---
prefs = lirePrefs();
appliquerLangue();
appliquerPrefs();
refreshKeyState();
loadHistory();
