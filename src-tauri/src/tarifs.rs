//! Statistiques et cout d'une traduction, calcules a partir du champ `usage` que
//! l'API Anthropic renvoie avec chaque reponse (exact, aucun appel supplementaire).

use serde::Serialize;
use serde_json::Value;

/// Statistiques d'une requete : envoyees a l'UI (evenement "trad:stats") et gardees
/// dans l'historique avec la traduction.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Modele qui a REELLEMENT servi la requete (champ `model` de la reponse).
    pub model: String,
    /// Tokens envoyes : prompt systeme + texte (+ cache eventuel).
    pub input_tokens: u64,
    /// Tokens recus : la traduction (+ reflexion eventuelle, facturee comme de la sortie).
    pub output_tokens: u64,
    /// Cout en dollars. `None` si le modele n'a pas de tarif connu ici : mieux vaut
    /// n'afficher aucun cout qu'un cout faux.
    pub cost_usd: Option<f64>,
    /// Duree entre l'envoi de la requete et la reception complete de la reponse.
    pub duration_ms: u64,
}

/// Tarifs publics en dollars par MILLION de tokens : (entree, sortie).
/// Source : platform.claude.com/docs/en/about-claude/pricing, releve du 14/10/2026.
/// `prompt` = TOUS les tokens d'entree, cache compris : c'est ce total qui fait
/// passer Haiku 5.5 sur sa grille haute au-dela de 100 000.
fn tarif(model: &str, prompt: u64) -> Option<(f64, f64)> {
    if model.starts_with("claude-haiku-5-5") {
        return Some(if prompt > 100_000 { (0.50, 2.50) } else { (0.10, 0.50) });
    }
    if model.starts_with("claude-sonnet-4-6") {
        return Some((3.0, 15.0));
    }
    if model.starts_with("claude-opus-4-8") {
        return Some((5.0, 25.0));
    }
    None
}

fn compteur(usage: &Value, champ: &str) -> u64 {
    usage.get(champ).and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Construit les statistiques a partir de la reponse de l'API.
///
/// Cache (Trad ne l'active pas : compteurs a 0 en pratique) : ecriture = 1,25 x le
/// tarif d'entree (cache 5 min), lecture = 0,1 x -- multiplicateurs officiels des
/// trois modeles ci-dessus.
pub fn depuis_reponse(model_demande: &str, payload: &Value, duration_ms: u64) -> Stats {
    let model = payload
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or(model_demande)
        .to_string();
    let vide = Value::Null;
    let usage = payload.get("usage").unwrap_or(&vide);
    let entree = compteur(usage, "input_tokens");
    let sortie = compteur(usage, "output_tokens");
    let cache_ecrit = compteur(usage, "cache_creation_input_tokens");
    let cache_lu = compteur(usage, "cache_read_input_tokens");
    let prompt = entree + cache_ecrit + cache_lu;

    // Pas de bloc `usage` = pas de chiffres fiables : aucun cout plutot que 0 $.
    let cost_usd = if usage.is_object() {
        tarif(&model, prompt).map(|(e, s)| {
            (entree as f64 * e
                + cache_ecrit as f64 * e * 1.25
                + cache_lu as f64 * e * 0.1
                + sortie as f64 * s)
                / 1_000_000.0
        })
    } else {
        None
    };

    Stats {
        model,
        input_tokens: prompt,
        output_tokens: sortie,
        cost_usd,
        duration_ms,
    }
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
    fn opus_et_sonnet() {
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
    fn sans_tarif_ou_sans_usage_pas_de_cout() {
        let p = json!({"usage": {"input_tokens": 10, "output_tokens": 10}});
        assert!(depuis_reponse("claude-inconnu", &p, 0).cost_usd.is_none());
        assert!(depuis_reponse("claude-haiku-5-5", &json!({}), 0).cost_usd.is_none());
    }
}
