# Trad

> **🇬🇧** Lightweight desktop translator (Rust + Tauri): select text anywhere, double-tap **Ctrl+C**, and get an instant translation powered by the **Claude API**.
>
> **🇫🇷** Traducteur de bureau léger (Rust + Tauri) : sélectionnez du texte n'importe où, **double Ctrl+C**, et obtenez une traduction instantanée via l'**API Claude**.

**[English](#english) · [Français](#français)**

---

## English

Trad brings DeepL-style **"double Ctrl+C"** translation to your desktop — but powered by the Anthropic **Claude API**, with the model of your choice.

### Features
- ⌨️ **Global double Ctrl+C**: select text in any app, tap Ctrl+C twice, the window pops up with the translation.
- 🧠 **Claude API**, model selectable: Opus 4.8 (quality), Sonnet 4.6 (balanced), Haiku 4.5 (fast & cheap).
- 🌍 Plain text **and JSON** (translates the values, keeps the keys — handy for i18n files).
- 🪶 Tiny native binary (Tauri), lives in the system tray, remembers your model & language.

### Privacy — what the app actually does
Trad uses a few sensitive-looking permissions. Here is exactly what it does — the code is short and auditable:

- **Global keyboard hook** (`src-tauri/src/hotkey.rs`, via `rdev`): it only *observes* keystrokes to detect the double Ctrl+C. It inspects **only the Ctrl and C keys**, **records nothing**, logs nothing, sends nothing — every other key falls into `_ => {}`.
- **Clipboard**: read **only** on the explicit double-Ctrl+C gesture (never in the background). The selected text is sent to the Anthropic API to be translated, so **don't translate data you wouldn't share with a third party** (see Anthropic's privacy policy).
- **API key**: stored in your **OS keychain** (Windows Credential Manager, via the `keyring` crate) — **never** in plain text on disk. You provide **your own** key; none is bundled.
- The app lives in the **system tray** (closing the window hides it; quit via the tray menu). It does **not** add itself to Windows startup — you create the shortcut yourself if you want it.
- ⚠️ A global keyboard hook may trigger a **false positive** on some heuristic antivirus software. The code is fully open for you to read.

### Requirements
- An **Anthropic API key** (from [console.anthropic.com](https://console.anthropic.com)) — billed per token, roughly **0.3¢ per translation** with Haiku.
- Windows (current target); WebView2 (preinstalled on Windows 10/11).

### Build
```bash
npm install
npx tauri build
```
Produces a standalone `.exe` plus MSI/NSIS installers.

> On WSL/drvfs, builds are slow. You can redirect Cargo's build directory out of the synced folder with a **local** (un-committed) `.cargo/config.toml` containing `target-dir = "C:/some-fast-path"`.

### License
MIT — see [LICENSE](LICENSE).

---

## Français

Trad apporte la traduction **« double Ctrl+C »** façon DeepL sur ton bureau — mais propulsée par l'**API Claude** (Anthropic), avec le modèle de ton choix.

### Fonctionnalités
- ⌨️ **Double Ctrl+C global** : sélectionne du texte dans n'importe quelle application, appuie deux fois sur Ctrl+C, la fenêtre surgit avec la traduction.
- 🧠 **API Claude**, modèle au choix : Opus 4.8 (qualité), Sonnet 4.6 (équilibre), Haiku 4.5 (rapide & économique).
- 🌍 Texte brut **et JSON** (traduit les valeurs, conserve les clés — pratique pour les fichiers i18n).
- 🪶 Binaire natif léger (Tauri), résident dans la barre système, mémorise modèle & langue.

### Vie privée — ce que fait réellement l'app
Trad utilise quelques permissions qui peuvent sembler sensibles. Voici exactement ce qu'il fait — le code est court et auditable :

- **Hook clavier global** (`src-tauri/src/hotkey.rs`, via `rdev`) : il *observe* uniquement les frappes pour détecter le double Ctrl+C. Il n'inspecte **que les touches Ctrl et C**, **n'enregistre rien**, ne loggue rien, ne transmet rien — toutes les autres touches tombent dans `_ => {}`.
- **Presse-papier** : lu **uniquement** au geste explicite double Ctrl+C (jamais en arrière-plan). Le texte sélectionné est envoyé à l'API Anthropic pour être traduit, donc **ne traduis pas de données que tu ne partagerais pas avec un tiers** (voir la politique de confidentialité d'Anthropic).
- **Clé API** : stockée dans le **coffre-fort de l'OS** (Gestionnaire d'identifiants Windows, via la crate `keyring`) — **jamais** en clair sur le disque. Tu fournis **ta propre** clé ; aucune n'est embarquée.
- L'app vit dans la **barre système** (fermer la fenêtre la cache ; quitter via le menu du tray). Elle **ne** s'ajoute **pas** au démarrage de Windows — tu crées le raccourci toi-même si tu le souhaites.
- ⚠️ Un hook clavier global peut déclencher un **faux positif** sur certains antivirus heuristiques. Le code est entièrement lisible.

### Pré-requis
- Une **clé API Anthropic** (sur [console.anthropic.com](https://console.anthropic.com)) — facturée au token, environ **0,3 centime par traduction** avec Haiku.
- Windows (cible actuelle) ; WebView2 (préinstallé sur Windows 10/11).

### Compilation
```bash
npm install
npx tauri build
```
Produit un `.exe` autonome ainsi que des installeurs MSI/NSIS.

> Sur WSL/drvfs, les builds sont lents. Tu peux rediriger le dossier de build de Cargo hors du dossier synchronisé via un `.cargo/config.toml` **local** (non versionné) contenant `target-dir = "C:/un-chemin-rapide"`.

### Licence
MIT — voir [LICENSE](LICENSE).
