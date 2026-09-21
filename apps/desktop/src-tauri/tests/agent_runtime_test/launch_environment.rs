//! The launch environment (P0 §2.4): the CA bundle the engine is started with, and the certificate
//! failure that variable exists to prevent.
//!
//! The two are one subject — TLS trust on the engine's side of the wire — and P0 §2.4 measured them
//! together: a child is given `NODE_EXTRA_CA_CERTS` so a chain its own store lacks still verifies,
//! and when it nevertheless reports an untrusted certificate the host classifies and rewords it
//! rather than letting the engine's own sentence reach a person.

use std::fs;
use std::path::Path;

use nekowite_lib::agent_runtime::AgentFailureCode;

use crate::support::{fixture, start, temp_dir};

// ---------------------------------------------------------------------------
// The launch environment (P0 §2.4)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_engine_is_started_with_the_ca_bundle() {
    // A child cannot be asked what it was spawned with, so the fixture reports
    // its own environment. Without this variable every prompt against a host
    // whose chain is missing from the engine's store fails as an opaque TLS
    // error, which P0 §2.4 measured and §2.4 requires the runtime to prevent.
    let capture = temp_dir("ca").join("capture");
    let (runtime, _events) = start(&fixture("good", Some(&capture))).await;
    runtime.initialize().await.expect("initialize");

    let recorded = fs::read_to_string(&capture).expect("the fixture should have reported its env");
    let ca = recorded
        .lines()
        .find_map(|line| line.strip_prefix("ca="))
        .expect("the fixture records the variable");
    assert_ne!(
        ca, "<unset>",
        "NODE_EXTRA_CA_CERTS must be set for the engine"
    );
    assert!(
        Path::new(ca).is_file(),
        "and it must name a bundle that exists, not just any string: {ca}"
    );
    runtime.shutdown();
}

#[tokio::test]
async fn a_certificate_failure_is_classified_and_reworded() {
    // The measured shape (P0 §2.4): the engine reports an untrusted certificate
    // as a generic -32603 whose message is the only evidence of the real
    // condition, and §2.4 forbids showing that message to a user.
    let (runtime, _events) = start(&fixture("cert-fail", None)).await;

    let error = runtime.initialize().await.expect_err("this fixture fails");

    assert_eq!(error.failure_code(), AgentFailureCode::CertificateUntrusted);
    let message = error.failure_message();
    assert!(
        !message.contains("unknown certificate verification error"),
        "the engine's own words must not reach the user: {message}"
    );
    assert!(message.to_lowercase().contains("certificate"));
    runtime.shutdown();
}
