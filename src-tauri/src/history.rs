//! Historique local des traductions.
//!
//! Persiste sur le disque, dans le dossier de donnees de l'app :
//! `%APPDATA%\app.trad.desktop\history.json` (survit aux mises a jour de l'exe).
//!
//! Choix du format : un simple tableau JSON, pas de base SQL. `serde_json` est deja
//! une dependance, l'historique est plafonne (MAX_ENTRIES) et reste donc de taille
//! modeste -- une base embarquee n'apporterait rien ici.
//!
//! Ordre : entree la PLUS RECENTE en tete (index 0). L'UI l'affiche telle quelle.

use crate::commands::TradError;
use crate::tarifs::Stats;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Nombre maximum de traductions conservees. Au-dela, les plus anciennes tombent.
const MAX_ENTRIES: usize = 300;

const FILE_NAME: &str = "history.json";

/// Une traduction enregistree.
///
/// `rename_all = "camelCase"` sert AUSSI bien a la lecture/ecriture du fichier
/// qu'au passage vers l'UI : cote JavaScript on lit donc `targetLang`, pas `target_lang`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    /// Horodatage en millisecondes depuis epoch (formate cote UI).
    pub ts: u64,
    pub source: String,
    pub translation: String,
    /// Code de langue BCP 47 ("fr", "pt-BR"...). Les entrees d'avant le 14/10/2026
    /// portaient un nom francais ("anglais") : converti a la lecture, cf `read_all`.
    pub target_lang: String,
    pub model: String,
    // Statistiques de la requete. Absentes des entrees d'avant le 14/10/2026 : elles
    // restent `None` a la lecture et ne sont pas reecrites (`skip_serializing_if`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

/// Anciennes valeurs de `target_lang` (noms francais de l'UI d'avant le 14/10/2026)
/// -> codes de langue. Ce sont les six seules langues que l'ancienne UI proposait.
fn code_langue_ancienne(nom: &str) -> Option<&'static str> {
    match nom {
        "francais" => Some("fr"),
        "anglais" => Some("en"),
        "espagnol" => Some("es"),
        "allemand" => Some("de"),
        "italien" => Some("it"),
        "portugais" => Some("pt-PT"),
        _ => None,
    }
}

/// Serialise tous les acces au fichier : une traduction declenchee au clavier et
/// une suppression declenchee a la souris peuvent arriver en meme temps.
static LOCK: Mutex<()> = Mutex::new(());

/// Discrimine deux entrees creees dans la meme milliseconde.
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Prend le verrou en ignorant l'empoisonnement : si un thread a panique en le
/// tenant, on prefere continuer sur des donnees potentiellement partielles plutot
/// que de rendre l'historique definitivement inutilisable jusqu'au redemarrage.
fn guard() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_id() -> String {
    format!("{}-{}", now_ms(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Chemin du fichier d'historique, en creant le dossier au besoin.
fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    Ok(dir.join(FILE_NAME))
}

/// Lit l'historique. Best-effort : fichier absent, illisible ou corrompu -> liste vide
/// (jamais d'erreur remontee a l'utilisateur pour ca, l'app doit rester utilisable).
///
/// Les anciens noms de langue sont convertis en codes ici, a la source : l'UI, le
/// dedoublonnage et les badges ne voient donc que des codes. Le fichier est reecrit
/// avec les codes a la prochaine ecriture.
fn read_all(app: &AppHandle) -> Vec<Entry> {
    let Ok(path) = history_path(app) else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut entries: Vec<Entry> = serde_json::from_str(&raw).unwrap_or_default();
    for e in &mut entries {
        if let Some(code) = code_langue_ancienne(&e.target_lang) {
            e.target_lang = code.to_string();
        }
    }
    entries
}

/// Ecriture ATOMIQUE : on ecrit un fichier temporaire puis on le renomme par-dessus
/// (sur Windows, `rename` remplace la cible). Une coupure de courant en plein
/// enregistrement laisse donc l'ancien historique intact, jamais un JSON tronque.
///
/// Les erreurs restent techniques et courtes (etape + message du systeme) : l'UI les
/// affiche comme detail apres une phrase traduite dans la langue de l'interface.
fn write_all(app: &AppHandle, entries: &[Entry]) -> Result<(), String> {
    let path = history_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_string(entries).map_err(|e| e.to_string())?;
    fs::write(&tmp, data).map_err(|e| format!("write: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Enregistre une traduction reussie, avec ses statistiques, et renvoie l'entree creee.
///
/// Dedoublonnage : retraduire le meme texte vers la meme langue ne cree pas de
/// doublon, l'ancienne entree est remplacee et remonte en tete (le double Ctrl+C
/// repete sur la meme selection est un geste courant).
///
/// Best-effort : renvoie `None` si l'ecriture echoue, sans jamais faire echouer
/// la traduction elle-meme.
pub fn record(
    app: &AppHandle,
    source: &str,
    translation: &str,
    target_lang: &str,
    model: &str,
    stats: &Stats,
) -> Option<Entry> {
    // `let _guard` et NON `let _` : `let _ = ...` liberrerait le verrou immediatement.
    let _guard = guard();

    let mut entries = read_all(app);
    entries.retain(|e| !(e.source == source && e.target_lang == target_lang));

    let entry = Entry {
        id: new_id(),
        ts: now_ms(),
        source: source.to_string(),
        translation: translation.to_string(),
        target_lang: target_lang.to_string(),
        model: model.to_string(),
        input_tokens: Some(stats.input_tokens),
        output_tokens: Some(stats.output_tokens),
        cost_usd: stats.cost_usd,
        duration_ms: Some(stats.duration_ms),
    };
    entries.insert(0, entry.clone());
    entries.truncate(MAX_ENTRIES);

    write_all(app, &entries).ok()?;
    Some(entry)
}

/// Renvoie tout l'historique, du plus recent au plus ancien.
#[tauri::command]
pub fn history_list(app: AppHandle) -> Vec<Entry> {
    let _guard = guard();
    read_all(&app)
}

/// Supprime une entree par son id.
#[tauri::command]
pub fn history_delete(app: AppHandle, id: String) -> Result<(), TradError> {
    let _guard = guard();
    let mut entries = read_all(&app);
    entries.retain(|e| e.id != id);
    write_all(&app, &entries).map_err(|e| TradError::avec("history", e))
}

/// Vide tout l'historique et supprime le fichier du disque.
#[tauri::command]
pub fn history_clear(app: AppHandle) -> Result<(), TradError> {
    let _guard = guard();
    let path = history_path(&app).map_err(|e| TradError::avec("history", e))?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        // Deja absent = deja vide, ce n'est pas une erreur.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(TradError::avec("history", e)),
    }
}
