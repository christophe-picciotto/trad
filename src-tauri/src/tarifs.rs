//! Statistiques et cout d'une traduction, calcules a partir du champ `usage` que
//! l'API Anthropic renvoie avec chaque reponse (exact, aucun appel supplementaire).

use serde::Serialize;
use serde_json::Value;

/// Statistiques d'une requete : envoyees a l'UI (evenement "trad:stats") et gardees
/// dans l'historique avec la traduction.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Modele qui a REELLEMENT servi la requete (champ `model` de la reponse) : le modele
    /// de secours si une traduction refusee a ete refaite (fallbacks).
    pub model: String,
    /// Tokens envoyes : prompt systeme + texte (+ cache eventuel), toutes tentatives.
    pub input_tokens: u64,
    /// Tokens recus : la traduction (+ reflexion eventuelle, facturee comme de la sortie).
    pub output_tokens: u64,
    /// Cout en dollars. `None` si un modele n'a pas de tarif connu ici : mieux vaut
    /// n'afficher aucun cout qu'un cout faux.
    pub cost_usd: Option<f64>,
    /// Duree entre l'envoi de la requete et la reception complete de la reponse.
    pub duration_ms: u64,
}

/// Tarif public d'un modele, en dollars par MILLION de tokens.
struct Tarif {
    entree: f64,
    sortie: f64,
    /// Lecture du cache, en fraction du tarif d'entree (0,05 sur Opus 5.5 et Sonnet 5.5,
    /// 0,1 sur les autres). L'ecriture (cache 5 min) vaut 1,25 x partout.
    lecture_cache: f64,
}

/// Source : platform.claude.com/docs/en/about-claude/pricing, releve du 14/10/2026.
/// Modeles de l'UI (Haiku 5.5, Opus 5.5, Sonnet 5.5), leurs modeles de SECOURS (avec
/// `fallbacks: "default"`, un refus d'Opus 5.5 est refait par Opus 5 ou Opus 4.8, un refus
/// de Sonnet 5.5 par Sonnet 5) et Sonnet 4.6 (ancienne UI). L'ORDRE compte : ce sont des
/// prefixes, "claude-opus-5-5" doit passer avant "claude-opus-5" (idem Sonnet).
/// `prompt` = TOUS les tokens d'entree de la tentative, cache compris : c'est ce total qui
/// fait passer Haiku 5.5 sur sa grille haute au-dela de 100 000.
fn tarif(model: &str, prompt: u64) -> Option<Tarif> {
    let t = |entree, sortie, lecture_cache| Some(Tarif { entree, sortie, lecture_cache });
    if model.starts_with("claude-haiku-5-5") {
        return if prompt > 100_000 { t(0.50, 2.50, 0.1) } else { t(0.10, 0.50, 0.1) };
    }
    if model.starts_with("claude-opus-5-5") {
        return t(4.0, 20.0, 0.05);
    }
    if model.starts_with("claude-sonnet-5-5") {
        return t(2.0, 10.0, 0.05);
    }
    if model.starts_with("claude-opus-5") {
        return t(5.0, 25.0, 0.1);
    }
    if model.starts_with("claude-sonnet-5") {
        return t(2.0, 10.0, 0.1);
    }
    if model.starts_with("claude-opus-4-8") {
        return t(5.0, 25.0, 0.1);
    }
    if model.starts_with("claude-sonnet-4-6") {
        return t(3.0, 15.0, 0.1);
    }
    None
}

/// Compteurs d'une tentative : le bloc `usage`, ou une entree de `usage.iterations`.
struct Jetons {
    entree: u64,
    sortie: u64,
    cache_ecrit: u64,
    cache_lu: u64,
}

fn jetons(usage: &Value) -> Jetons {
    let n = |champ: &str| usage.get(champ).and_then(|v| v.as_u64()).unwrap_or(0);
    Jetons {
        entree: n("input_tokens"),
        sortie: n("output_tokens"),
        cache_ecrit: n("cache_creation_input_tokens"),
        cache_lu: n("cache_read_input_tokens"),
    }
}

fn cout(model: &str, j: &Jetons) -> Option<f64> {
    let prompt = j.entree + j.cache_ecrit + j.cache_lu;
    tarif(model, prompt).map(|t| {
        (j.entree as f64 * t.entree
            + j.cache_ecrit as f64 * t.entree * 1.25
            + j.cache_lu as f64 * t.entree * t.lecture_cache
            + j.sortie as f64 * t.sortie)
            / 1_000_000.0
    })
}

/// Construit les statistiques a partir de la reponse de l'API.
pub fn depuis_reponse(model_demande: &str, payload: &Value, duration_ms: u64) -> Stats {
    let model = payload
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or(model_demande)
        .to_string();
    // Pas de bloc `usage` = pas de chiffres fiables : aucun cout plutot que 0 $.
    let Some(usage) = payload.get("usage").filter(|u| u.is_object()) else {
        return Stats { model, input_tokens: 0, output_tokens: 0, cost_usd: None, duration_ms };
    };

    // Avec un modele de secours (fallbacks), `usage.iterations` detaille CHAQUE tentative
    // (la tentative refusee, puis celle du modele de secours) et le `usage` de premier niveau
    // ne couvre que la derniere : on additionne les tentatives, chacune au tarif du modele qui
    // l'a executee (`model` de l'entree ; null = le modele demande). Une tentative refusee
    // AVANT toute sortie n'est pas toujours facturee (selon la categorie) : la compter rend
    // l'estimation prudente, par exces et jamais par defaut.
    let tentatives: Vec<(String, Jetons)> =
        match usage.get("iterations").and_then(|i| i.as_array()) {
            Some(liste) if !liste.is_empty() => liste
                .iter()
                .map(|it| {
                    let m = it.get("model").and_then(|m| m.as_str()).unwrap_or(model_demande);
                    (m.to_string(), jetons(it))
                })
                .collect(),
            _ => vec![(model.clone(), jetons(usage))],
        };

    let input_tokens = tentatives
        .iter()
        .map(|(_, j)| j.entree + j.cache_ecrit + j.cache_lu)
        .sum();
    let output_tokens = tentatives.iter().map(|(_, j)| j.sortie).sum();
    // Une seule tentative sans tarif connu suffit a rendre le total faux : aucun cout alors.
    let cost_usd = tentatives.iter().map(|(m, j)| cout(m, j)).sum::<Option<f64>>();

    Stats { model, input_tokens, output_tokens, cost_usd, duration_ms }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn proche(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-12
    }

    #[test]
    fn haiku_55_prompt_court() {
        let p = json!({"model": "claude-haiku-5-5",
                       "usage": {"input_tokens": 509, "output_tokens": 81}});
        let s = depuis_reponse("claude-haiku-5-5", &p, 1394);
        assert!(proche(s.cost_usd.unwrap(), (509.0 * 0.10 + 81.0 * 0.50) / 1e6));
        assert_eq!((s.input_tokens, s.output_tokens, s.duration_ms), (509, 81, 1394));
    }

    #[test]
    fn haiku_55_grille_haute_au_dela_de_100k() {
        let p = json!({"model": "claude-haiku-5-5",
                       "usage": {"input_tokens": 150_000, "output_tokens": 1_000}});
        let s = depuis_reponse("claude-haiku-5-5", &p, 0);
        assert!(proche(s.cost_usd.unwrap(), (150_000.0 * 0.50 + 1_000.0 * 2.50) / 1e6));
    }

    #[test]
    fn haiku_55_seuil_compte_le_cache() {
        // 60 000 + 50 000 en cache = 110 000 > 100 000 : grille haute.
        let p = json!({"model": "claude-haiku-5-5",
                       "usage": {"input_tokens": 60_000, "cache_read_input_tokens": 50_000,
                                 "output_tokens": 0}});
        let s = depuis_reponse("claude-haiku-5-5", &p, 0);
        assert!(proche(s.cost_usd.unwrap(), (60_000.0 * 0.50 + 50_000.0 * 0.05) / 1e6));
        assert_eq!(s.input_tokens, 110_000);
    }

    #[test]
    fn haiku_55_pile_100k_reste_sur_la_grille_basse() {
        let p = json!({"usage": {"input_tokens": 100_000, "output_tokens": 0}});
        let s = depuis_reponse("claude-haiku-5-5", &p, 0);
        assert!(proche(s.cost_usd.unwrap(), 100_000.0 * 0.10 / 1e6));
    }

    #[test]
    fn opus_55_et_sonnet_55() {
        let u = json!({"usage": {"input_tokens": 1_000_000, "output_tokens": 1_000_000}});
        assert!(proche(depuis_reponse("claude-opus-5-5", &u, 0).cost_usd.unwrap(), 24.0));
        assert!(proche(depuis_reponse("claude-sonnet-5-5", &u, 0).cost_usd.unwrap(), 12.0));
    }

    #[test]
    fn lecture_du_cache_a_005_sur_opus_et_sonnet_55() {
        let u = json!({"usage": {"input_tokens": 0, "cache_read_input_tokens": 1_000_000,
                                 "output_tokens": 0}});
        assert!(proche(depuis_reponse("claude-opus-5-5", &u, 0).cost_usd.unwrap(), 0.20));
        assert!(proche(depuis_reponse("claude-sonnet-5-5", &u, 0).cost_usd.unwrap(), 0.10));
        assert!(proche(depuis_reponse("claude-opus-4-8", &u, 0).cost_usd.unwrap(), 0.50));
    }

    #[test]
    fn prefixes_dans_le_bon_ordre() {
        // "claude-opus-5" (Opus 5, 5/25) ne doit pas prendre le tarif d'Opus 5.5 (4/20),
        // ni l'inverse ; idem Sonnet 5 / Sonnet 5.5 (memes tarifs, cache different).
        let u = json!({"usage": {"input_tokens": 1_000_000, "output_tokens": 0}});
        assert!(proche(depuis_reponse("claude-opus-5", &u, 0).cost_usd.unwrap(), 5.0));
        assert!(proche(depuis_reponse("claude-opus-5-5", &u, 0).cost_usd.unwrap(), 4.0));
        let c = json!({"usage": {"input_tokens": 0, "cache_read_input_tokens": 1_000_000,
                                 "output_tokens": 0}});
        assert!(proche(depuis_reponse("claude-sonnet-5", &c, 0).cost_usd.unwrap(), 0.20));
        assert!(proche(depuis_reponse("claude-sonnet-5-5", &c, 0).cost_usd.unwrap(), 0.10));
    }

    #[test]
    fn anciens_modeles_toujours_reconnus() {
        let u = json!({"usage": {"input_tokens": 1_000_000, "output_tokens": 1_000_000}});
        assert!(proche(depuis_reponse("claude-opus-4-8", &u, 0).cost_usd.unwrap(), 30.0));
        assert!(proche(depuis_reponse("claude-sonnet-4-6", &u, 0).cost_usd.unwrap(), 18.0));
    }

    #[test]
    fn modele_servi_prioritaire_sur_le_modele_demande() {
        let p = json!({"model": "claude-opus-4-8",
                       "usage": {"input_tokens": 1_000_000, "output_tokens": 0}});
        let s = depuis_reponse("claude-haiku-5-5", &p, 0);
        assert_eq!(s.model, "claude-opus-4-8");
        assert!(proche(s.cost_usd.unwrap(), 5.0));
    }

    #[test]
    fn modele_de_secours_chaque_tentative_a_son_tarif() {
        // Opus 5.5 refuse (avant toute sortie), Opus 4.8 traduit : le usage de premier
        // niveau ne couvre que la 2e tentative, iterations les detaille toutes les deux.
        let p = json!({"model": "claude-opus-4-8", "usage": {
            "input_tokens": 520, "output_tokens": 90,
            "iterations": [
                {"type": "message", "model": null, "input_tokens": 500, "output_tokens": 0},
                {"type": "fallback_message", "model": "claude-opus-4-8",
                 "input_tokens": 520, "output_tokens": 90}]}});
        let s = depuis_reponse("claude-opus-5-5", &p, 0);
        assert_eq!(s.model, "claude-opus-4-8");
        assert_eq!((s.input_tokens, s.output_tokens), (1_020, 90));
        let attendu = (500.0 * 4.0) / 1e6 + (520.0 * 5.0 + 90.0 * 25.0) / 1e6;
        assert!(proche(s.cost_usd.unwrap(), attendu));
    }

    #[test]
    fn une_seule_tentative_detaillee_comme_sans_secours() {
        // Forme observee le 14/10/2026 avec fallbacks actif et sans refus.
        let p = json!({"model": "claude-sonnet-5-5", "usage": {
            "input_tokens": 509, "output_tokens": 88,
            "iterations": [{"type": "message", "model": null,
                            "input_tokens": 509, "output_tokens": 88}]}});
        let s = depuis_reponse("claude-sonnet-5-5", &p, 0);
        assert_eq!((s.input_tokens, s.output_tokens), (509, 88));
        assert!(proche(s.cost_usd.unwrap(), (509.0 * 2.0 + 88.0 * 10.0) / 1e6));
    }

    #[test]
    fn sans_tarif_ou_sans_usage_pas_de_cout() {
        let p = json!({"usage": {"input_tokens": 10, "output_tokens": 10}});
        assert!(depuis_reponse("claude-inconnu", &p, 0).cost_usd.is_none());
        assert!(depuis_reponse("claude-haiku-5-5", &json!({}), 0).cost_usd.is_none());
        // Une tentative de secours sur un modele inconnu rend tout le total incertain.
        let q = json!({"usage": {"iterations": [
            {"model": null, "input_tokens": 10, "output_tokens": 0},
            {"model": "claude-inconnu", "input_tokens": 10, "output_tokens": 10}]}});
        assert!(depuis_reponse("claude-opus-5-5", &q, 0).cost_usd.is_none());
    }
}
