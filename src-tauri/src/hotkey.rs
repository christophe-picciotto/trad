//! Detecteur global du geste "double Ctrl+C" (facon DeepL).
//!
//! `rdev::listen` OBSERVE le clavier sans le consommer : le copier-coller normal
//! reste intact. Au double Ctrl+C rapide, on lit le presse-papier (arboard), on
//! ramene la fenetre au premier plan, et on emet "hotkey:translate" vers l'UI.
//!
//! Tourne dans un thread dedie (jamais l'async runtime). Limite connue (Tauri v2 +
//! rdev dans le meme process) : tant que la fenetre Trad a le focus, le clavier
//! global peut ne pas etre capte ; des qu'on revient dans une autre app, ca reprend.

use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Fenetre de temps entre les deux Ctrl+C pour valider le "double".
const DOUBLE_TAP_MS: u64 = 450;

/// Lance le detecteur clavier global dans un thread dedie.
pub fn start_listener(app: AppHandle) {
    std::thread::spawn(move || {
        let mut ctrl_down = false;
        let mut last_c: Option<Instant> = None;

        let callback = move |event: rdev::Event| {
            use rdev::{EventType, Key};
            match event.event_type {
                EventType::KeyPress(Key::ControlLeft) | EventType::KeyPress(Key::ControlRight) => {
                    ctrl_down = true;
                }
                EventType::KeyRelease(Key::ControlLeft)
                | EventType::KeyRelease(Key::ControlRight) => {
                    ctrl_down = false;
                }
                EventType::KeyPress(Key::KeyC) if ctrl_down => {
                    let now = Instant::now();
                    let is_double = last_c
                        .map(|t| now.duration_since(t) < Duration::from_millis(DOUBLE_TAP_MS))
                        .unwrap_or(false);
                    if is_double {
                        last_c = None;
                        // Travail HORS du callback du hook clavier (ne jamais le bloquer).
                        let app2 = app.clone();
                        std::thread::spawn(move || on_double_ctrl_c(&app2));
                    } else {
                        last_c = Some(now);
                    }
                }
                _ => {}
            }
        };

        if let Err(e) = rdev::listen(callback) {
            eprintln!("[hotkey] echec de l'ecoute clavier : {:?}", e);
        }
    });
}

/// Declenche apres un double Ctrl+C : lit la selection et demande la traduction.
fn on_double_ctrl_c(app: &AppHandle) {
    // Laisser le 2e Ctrl+C deposer la selection dans le presse-papier.
    std::thread::sleep(Duration::from_millis(60));

    let text = match read_clipboard() {
        Some(t) if !t.trim().is_empty() => t,
        _ => return, // rien a traduire
    };

    // Ramener la fenetre au premier plan.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }

    // L'UI (main.js) ecoute "hotkey:translate" -> remplit la source et traduit.
    let _ = app.emit("hotkey:translate", text);
}

/// Lit le texte du presse-papier (best-effort).
fn read_clipboard() -> Option<String> {
    arboard::Clipboard::new().ok()?.get_text().ok()
}
