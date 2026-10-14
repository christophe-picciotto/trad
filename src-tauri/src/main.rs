// Pas de console Windows en release (fenetre GUI uniquement).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod history;
mod hotkey;
mod tarifs;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

const TRAY_ID: &str = "trad-tray";

fn main() {
    tauri::Builder::default()
        // Instance UNIQUE (doit etre le 1er plugin) : si une 2e instance est lancee
        // (relancer depuis le bureau alors qu'une instance tourne deja, cachee dans le
        // tray), on montre la fenetre existante au lieu d'ouvrir une 2e app -- sinon 2
        // detecteurs Ctrl+C+C feraient surgir 2 fenetres.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        // Commandes exposees a l'UI (fenetre "main").
        .invoke_handler(tauri::generate_handler![
            commands::translate,
            commands::save_api_key,
            commands::has_api_key,
            commands::clear_api_key,
            history::history_list,
            history::history_delete,
            history::history_clear,
            set_tray_labels
        ])
        .setup(|app| {
            // Detecteur global du double Ctrl+C (facon DeepL), thread dedie.
            hotkey::start_listener(app.handle().clone());

            // --- Icone dans la barre systeme : l'app vit en arriere-plan ---
            // Libelles anglais par defaut : l'UI les remplace des son chargement par
            // ceux de la langue de l'interface (commande `set_tray_labels`).
            let open_i = MenuItem::with_id(app, "open", "Open Trad", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &quit_i])?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Trad - press Ctrl+C twice to translate")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // --- Fermer la fenetre = la CACHER (l'app reste active dans le tray) ---
            if let Some(win) = app.get_webview_window("main") {
                let win2 = win.clone();
                win.on_window_event(move |e| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        let _ = win2.hide();
                    }
                });
            }

            // --- Demarrage : cachee si lance avec --hidden (au boot Windows),
            //     visible si lance manuellement (raccourci bureau). ---
            let hidden = std::env::args().any(|a| a == "--hidden");
            if !hidden {
                show_main(app.handle());
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erreur au demarrage de l'application Tauri");
}

/// Traduit le menu et l'infobulle de l'icone de la barre systeme. Appelee par l'UI au
/// chargement et a chaque changement de langue : la langue est choisie et memorisee
/// cote UI, qui fournit les libelles deja traduits. On reconstruit le menu avec les
/// MEMES identifiants ("open", "quit") : le gestionnaire `on_menu_event` reste valable.
#[tauri::command]
fn set_tray_labels(
    app: tauri::AppHandle,
    open: String,
    quit: String,
    tooltip: String,
) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let open_i = MenuItem::with_id(&app, "open", open, true, None::<&str>).map_err(|e| e.to_string())?;
    let quit_i = MenuItem::with_id(&app, "quit", quit, true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&open_i, &quit_i]).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    Ok(())
}

/// Affiche et met au premier plan la fenetre "main".
fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}
