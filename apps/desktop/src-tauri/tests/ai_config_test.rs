//! The credential rule at the heart of `hydrate_stored_key_with`: a masked
//! vault value is never what a request authenticates with.
//!
//! These tests exist because that rule used to be provable by reading alone.
//! The function took a `tauri::AppHandle`, and this crate cannot build one
//! outside a running app, so the one thing deciding which credential leaves the
//! machine had no executable check behind it. Injecting the store is what makes
//! the decision runnable; the store stays injected, and no test here reaches a
//! vault or an `AppHandle`.
//!
//! They are written to fail when the rule is broken, not merely to pass while
//! it holds, so the assertions name the wrong outcome rather than just asking
//! whether anything changed.

use std::cell::{Cell, RefCell};

use nekowite_lib::providers::ai::config::{hydrate_stored_key_with, AIConfig};
use nekowite_lib::providers::ai::request::with_completion_auth;
use nekowite_lib::storage::key_store::AI_KEY_MASKED;

fn config(provider: &str, api_key: Option<&str>) -> AIConfig {
    AIConfig {
        provider: provider.into(),
        model: "gpt-5-mini".into(),
        api_key: api_key.map(str::to_string),
        ..Default::default()
    }
}

/// A key the user has just typed is what this request runs under. The store is
/// not merely second choice, it must not be read at all: reading it can fail (a
/// locked or unreadable vault) and turn a good request into an error, and a
/// stale stored key would otherwise replace the key the user is looking at.
#[test]
fn a_real_key_is_kept_and_the_store_is_never_read() {
    let mut config = config("openai", Some("sk-typed-by-hand"));

    let reads = Cell::new(0);
    let result = hydrate_stored_key_with(&mut config, |_| {
        reads.set(reads.get() + 1);
        Err("the store must not be read when the caller supplied a real key".into())
    });

    assert_eq!(
        reads.get(),
        0,
        "the vault was consulted even though a key was given"
    );
    assert!(
        result.is_ok(),
        "a typed key must not fail because the vault could not be read: {result:?}"
    );
    assert_eq!(config.api_key.as_deref(), Some("sk-typed-by-hand"));
}

/// The masked placeholder says "a key is configured"; the vault holds what that
/// key is. A request carrying the mask has to be given the real one.
#[test]
fn a_masked_key_is_replaced_by_the_stored_one() {
    let mut config = config("openai", Some(AI_KEY_MASKED));

    hydrate_stored_key_with(&mut config, |_| Ok(Some("sk-from-the-vault".into())))
        .expect("the stored key is readable");

    assert_eq!(config.api_key.as_deref(), Some("sk-from-the-vault"));
}

/// The case the rule is really about: the window sent the mask, and there is
/// nothing in the vault to replace it with. Leaving the placeholder behind
/// leaves it in the provider's auth header (`request::with_completion_auth`),
/// so the config must come out with no key at all — not with a different key,
/// and specifically not with `Some(AI_KEY_MASKED)`.
#[test]
fn a_masked_key_with_nothing_stored_leaves_no_key_at_all() {
    let mut config = config("openai", Some(AI_KEY_MASKED));

    hydrate_stored_key_with(&mut config, |_| Ok(None)).expect("an empty vault is not an error");

    assert!(
        config.api_key.is_none(),
        "a masked key with nothing stored left {:?} in the config, and that value is what the \
         request would authenticate with",
        config.api_key
    );
}

/// The placeholder is recognised by what it SAYS, not by one exact spelling.
///
/// The rule used to be `!= AI_KEY_MASKED`, which only matches the literal as
/// this crate writes it: the same placeholder padded, wrapped in newlines, or
/// spaced out read as a real key, the store was never consulted, and the
/// placeholder itself went on the wire as the provider's credential. Whitespace
/// padding is exactly what a normaliser produces, and the mask's own character
/// is not something a provider key is made of — so a value carrying nothing but
/// those characters is the placeholder however it is spelled.
#[test]
fn a_mask_is_recognised_in_every_spelling_not_just_the_literal() {
    for spelling in [
        format!("{AI_KEY_MASKED} "),
        format!("\n{AI_KEY_MASKED}\n"),
        "••".to_string(),
        "• • • • • • • •".to_string(),
    ] {
        let mut config = config("openai", Some(&spelling));

        let reads = Cell::new(0);
        hydrate_stored_key_with(&mut config, |_| {
            reads.set(reads.get() + 1);
            Ok(Some("sk-from-the-vault".into()))
        })
        .expect("the stored key is readable");

        assert_eq!(
            reads.get(),
            1,
            "{spelling:?} was treated as a real key: the vault was never asked for the one it stands for"
        );
        assert_eq!(
            config.api_key.as_deref(),
            Some("sk-from-the-vault"),
            "{spelling:?} did not resolve to the stored key"
        );
    }
}

/// The literal itself must stay covered by the rule above — the mask this
/// crate writes is the case every other spelling is a variation of, and a
/// weakening of the predicate that let the literal through would be invisible
/// anywhere else.
#[test]
fn the_exact_mask_is_still_the_placeholder() {
    let mut config = config("openai", Some(AI_KEY_MASKED));
    hydrate_stored_key_with(&mut config, |_| Ok(Some("sk-from-the-vault".into())))
        .expect("the stored key is readable");
    assert_eq!(config.api_key.as_deref(), Some("sk-from-the-vault"));
}

/// A blank key is not a credential either, and it must not short-circuit the
/// backfill: `Some("")` returned early without ever asking the store, so the
/// request went out with an empty credential in the provider's auth header
/// while the vault held the key the user had saved for that provider.
#[test]
fn a_blank_key_is_backfilled_from_the_vault_like_an_absent_one() {
    for blank in ["", "   ", "\n"] {
        let mut config = config("openai", Some(blank));

        hydrate_stored_key_with(&mut config, |_| Ok(Some("sk-from-the-vault".into())))
            .expect("the stored key is readable");

        assert_eq!(
            config.api_key.as_deref(),
            Some("sk-from-the-vault"),
            "{blank:?} did not fall back to the stored key"
        );
    }
}

/// A config with no key is the same situation as one holding the mask, so it has
/// to come out the same way: filled from the vault when the vault has something,
/// and empty when it has nothing. Any divergence between the two is a bug in one
/// of the branches.
#[test]
fn no_key_at_all_behaves_like_the_masked_case() {
    let mut filled = config("openai", None);
    hydrate_stored_key_with(&mut filled, |_| Ok(Some("sk-from-the-vault".into()))).unwrap();
    assert_eq!(filled.api_key.as_deref(), Some("sk-from-the-vault"));

    let mut empty = config("openai", None);
    hydrate_stored_key_with(&mut empty, |_| Ok(None)).unwrap();
    assert!(
        empty.api_key.is_none(),
        "an absent key came back as {:?}",
        empty.api_key
    );
}

/// A store that fails must not be swallowed. Swallowing it would leave the
/// request to run on whatever the config happened to hold — the masked
/// placeholder, in the case this rule is about. Propagating is the fail-closed
/// behaviour and the right one: both call sites (`ai_complete` and
/// `ai_list_models`) turn the error into a user-facing message and abort, so
/// nothing is sent rather than something wrong. The placeholder is dropped
/// before the read as well, so even a caller that ignored this error could not
/// put it on the wire.
#[test]
fn a_failing_store_propagates_and_leaves_no_placeholder() {
    let mut config = config("openai", Some(AI_KEY_MASKED));

    let err = hydrate_stored_key_with(&mut config, |_| Err("vault is locked".into()))
        .expect_err("a failed read must be reported, not silently treated as an empty vault");

    assert_eq!(err, "vault is locked");
    assert!(
        config.api_key.is_none(),
        "the masked placeholder outlived the failed read: {:?}",
        config.api_key
    );
}

/// The consequence, one step downstream: whatever hydration leaves in
/// `api_key` is what [`with_completion_auth`] puts in the provider's auth
/// header, so a mask left in the config is not a harmless leftover — it is the
/// credential the request presents. The request here is built, never sent; only
/// its headers are read.
#[test]
fn the_placeholder_never_becomes_the_requests_credential() {
    let mut config = config("openai", Some(AI_KEY_MASKED));
    hydrate_stored_key_with(&mut config, |_| Ok(None)).expect("an empty vault is not an error");

    let request = with_completion_auth(
        reqwest::Client::builder()
            .build()
            .expect("a client is constructible")
            .post("https://api.openai.com/v1/chat/completions"),
        &config,
    )
    .build()
    .expect("a request is constructible");

    let sent = request.headers().get("authorization");
    assert!(
        sent.is_none(),
        "a request with no key carried {:?} as its credential",
        // Lossy on purpose: `HeaderValue::to_str` refuses the mask's bullet
        // characters, and this is the message that has to show them.
        sent.map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
    );
}

/// The consequence, for the spellings the rule used to miss: a padded or
/// spaced mask left in the config is the credential the request presents, so it
/// must be gone by the time the header is built.
#[test]
fn a_padded_placeholder_never_becomes_the_requests_credential() {
    for spelling in ["•••••••• ", "\n••••••••", "• • • •"] {
        let mut config = config("openai", Some(spelling));
        hydrate_stored_key_with(&mut config, |_| Ok(None)).expect("an empty vault is not an error");

        let request = with_completion_auth(
            reqwest::Client::builder()
                .build()
                .expect("a client is constructible")
                .post("https://api.openai.com/v1/chat/completions"),
            &config,
        )
        .build()
        .expect("a request is constructible");

        let sent = request.headers().get("authorization");
        assert!(
            sent.is_none(),
            "{spelling:?} reached the provider as {:?}",
            sent.map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        );
    }
}

/// The store is asked for the provider this config names — not for a default,
/// not for the provider of the last request. The vault is keyed per provider, so
/// a lookup under the wrong name would hand this request another provider's
/// credential.
#[test]
fn the_store_is_asked_for_this_configs_provider() {
    let mut config = config("anthropic", None);

    let asked: RefCell<Vec<String>> = RefCell::new(Vec::new());
    hydrate_stored_key_with(&mut config, |provider| {
        asked.borrow_mut().push(provider.to_string());
        Ok(Some("sk-ant".into()))
    })
    .unwrap();

    assert_eq!(asked.into_inner(), vec!["anthropic".to_string()]);
    assert_eq!(config.api_key.as_deref(), Some("sk-ant"));
}
