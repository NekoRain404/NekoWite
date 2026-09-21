//! The tests of the vocabulary, the mapping and the failure reading, beside the code they cover.
//!
//! Split out with the rest of the module: it was the tail of a file that had passed its line
//! budget, and the fixtures here (P0 §2.4's measured frame) belong to no single one of the four
//! children. `use super::*` is deliberate — these assert against the names the module publishes,
//! which is the surface callers reach, and the private `certificate_failure` it also brings in is
//! the matcher the reworded sentence rests on.

use super::*;

/// P0 §2.4's measured frame, verbatim, as the engine sends it.
fn measured() -> TransportError {
    TransportError::Engine {
        message: "Internal error: unknown certificate verification error".to_string(),
    }
}

/// The half that must not weaken. Recognition is what keeps the condition
/// legible; without it this arrives as an unrecognised internal error, which
/// is exactly what §2.4 measured and rejected.
#[test]
fn the_measured_frame_is_still_classified_and_still_reworded() {
    assert_eq!(
        measured().failure_code(),
        AgentFailureCode::CertificateUntrusted
    );
    let message = measured().failure_message();
    assert!(
        !message.contains("unknown certificate verification error"),
        "the engine's own words must not reach the user: {message}"
    );
    assert!(
        message.contains("certificate"),
        "the condition is still named: {message}"
    );
}

/// The honesty of the sentence, as properties rather than as prose.
///
/// The live run's §5 measured this exact condition arriving from a transient
/// network fault and then succeeding twice with identical inputs, so a
/// message that offers only the CA explanation sends a user to change a
/// configuration that was never wrong. Three claims are required: the
/// failure may be transient (a retry instruction), the CA cause is offered
/// as a likelihood, and `NODE_EXTRA_CA_CERTS` is named so the cause is
/// actionable. Reverting the wording to the confident diagnosis fails on the
/// first, and the ordering assertion keeps a rewrite from burying the retry
/// after the CA advice.
#[test]
fn the_certificate_message_offers_the_retry_before_the_ca_advice() {
    let message = measured().failure_message();
    assert!(
        message.contains("NODE_EXTRA_CA_CERTS"),
        "the variable that addresses a CA problem must be named: {message}"
    );
    assert!(
        message.to_lowercase().contains("transient"),
        "the message must say the failure can arrive from something that is not the \
         certificate at all: {message}"
    );
    // Any of these words is unambiguously a retry instruction, and the wording
    // this replaces contained none of them.
    let retry = ["retry", "try again", "it again"]
        .iter()
        .filter_map(|anchor| message.find(anchor))
        .min()
        .unwrap_or_else(|| {
            panic!("the message must say running the failure again is worth trying: {message}")
        });
    let cause = message
        .find("CA store")
        .unwrap_or_else(|| panic!("the message must still name the cause: {message}"));
    assert!(
        retry < cause,
        "the retry comes first, so a transient failure does not send the reader into \
         their CA configuration: {message}"
    );
}

/// What the matcher fires on, and what it does not — unchanged by the wording
/// work, and pinned because a classification that cannot state its own
/// boundary is the thing §2.4's "opaque error" complaint was about.
///
/// Fires on: a message that contains `certificate` *and* one of the phrasings
/// the TLS libraries use. Does not fire on: an internal error that merely
/// mentions a certificate, a phrasing without a certificate, and the generic
/// `-32603` with neither — those stay `invalid-response`, or reach the user
/// as the engine's own words.
#[test]
fn the_match_covers_the_measured_phrasings_and_nothing_else() {
    for message in [
        "Internal error: unknown certificate verification error",
        "certificate verify failed: unable to get local issuer certificate",
        "certificate verify failed: self-signed certificate in certificate chain",
        "certificate verify failed: self signed certificate",
        "certificate verify failed: certificate has expired",
        "error:0A000086:SSL routines::certificate verify failed, depth lookup: self signed",
    ] {
        assert!(
            certificate_failure(message),
            "a measured certificate phrasing must match: {message}"
        );
    }
    for message in [
        "Internal error",
        "-32603 Internal error: an unexpected failure occurred",
        "certificate request rejected by policy",
        "unable to verify the workspace root",
        "the session has expired",
    ] {
        assert!(
            !certificate_failure(message),
            "this is not a certificate failure and must not be reworded as one: {message}"
        );
    }
}
