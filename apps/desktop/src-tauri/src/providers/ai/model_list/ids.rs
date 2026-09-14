//! Reading an answer into model ids: the one pure function that turns a
//! `/models` body into the list the settings page shows.
//!
//! Extracted from [`super`] as one vertical slice, because what a body SAYS and
//! the round trip that fetched it are two concerns: this one is a parse over a
//! string, with no client, no URL and no failure wording, so the shapes it
//! understands are a change here alone and can be pinned without a server.
//!
//! Dependencies: none. The parse is `serde_json` over the bytes it was handed,
//! so this is a leaf of the `model_list` module.

/// Extract stable, sorted model IDs from a provider's `/models` response.
///
/// Robust across providers: OpenAI-compatible and Anthropic place their
/// entries in a `data` array with an `id` field; Gemini uses a `models` array
/// holding a fully-qualified `name` (e.g. `models/gemini-2.5-pro`) that we
/// reduce to its final segment. An empty or unparseable body yields an empty
/// list so the caller can degrade gracefully.
pub fn parse_model_ids(body: &str, _provider: &str) -> Vec<String> {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| v.get("models").and_then(|m| m.as_array()));
    let Some(arr) = arr else {
        return Vec::new();
    };
    let mut ids: Vec<String> = Vec::new();
    for item in arr {
        let id = item
            .get("id")
            .and_then(|x| x.as_str())
            .map(str::to_string)
            .or_else(|| {
                item.get("name")
                    .and_then(|x| x.as_str())
                    .map(|n| n.rsplit('/').next().unwrap_or(n).to_string())
            });
        if let Some(id) = id {
            if !id.trim().is_empty() {
                ids.push(id);
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_array_is_not_silently_empty() {
        // The shape this parser does NOT know. A top-level array is valid JSON
        // and carries models, and before this it produced an empty dropdown with
        // nothing said — the exact symptom reported as "刷新完成，模型列表下拉还是
        // 没有对应的模型". Asserting the ids stay empty documents the parser's
        // limit; asserting the MESSAGE is what proves the limit is reported.
        let ids = parse_model_ids(r#"[{"id": "qwen3.7-max"}]"#, "anthropic");
        assert!(ids.is_empty(), "the parser does not read a bare array");
    }

    #[test]
    fn a_renamed_key_is_not_silently_empty() {
        let ids = parse_model_ids(r#"{"result": [{"id": "qwen3.7-max"}]}"#, "anthropic");
        assert!(ids.is_empty(), "the parser does not read a renamed key");
    }

    #[test]
    fn the_shapes_that_are_known_still_parse() {
        // The other half: the two shapes the parser DOES read must keep working,
        // so the empty-list report above cannot be tightened into a false alarm.
        assert_eq!(
            parse_model_ids(r#"{"data": [{"id": "a"}, {"id": "b"}]}"#, "openai"),
            vec!["a".to_string(), "b".to_string()],
        );
        assert_eq!(
            parse_model_ids(
                r#"{"models": [{"name": "models/gemini-2.5-pro"}]}"#,
                "gemini"
            ),
            vec!["gemini-2.5-pro".to_string()],
        );
    }
}
