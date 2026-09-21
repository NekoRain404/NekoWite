//! The engine's own end: that a dead engine cannot park a call, and the last words a failed start
//! still carries.
//!
//! The distinction this file is built on is `process/engine_exit.rs`'s: a failure may be noticed by
//! the connect or by the handshake, and what it carries is the stderr tail read to the end of the
//! pipe rather than sampled at the moment the transport closed. Each case below pins one of those
//! orderings, because a loaded machine is what produces the other one.
//!
//! `an_engine_that_dies_the_moment_it_starts_still_gets_to_say_why` is the case that used to fail
//! about one run in eight. It is moved here byte-for-byte — name, comments, the fixture command it
//! builds itself, and its timing assertions — and it shares no helper with another domain: it
//! builds its own `EngineLaunch` and reaches only for `EngineConnection`, `INITIALIZE_BOUND` and
//! `failure_message`, so nothing it depends on changed shape in the move.

use std::path::PathBuf;

use nekowite_lib::agent_runtime::{env_pairs, EngineConnection, EngineLaunch, INITIALIZE_BOUND};

use crate::support::{fixture, start, PATIENCE};

#[tokio::test]
async fn a_child_that_dies_mid_request_does_not_park_it_forever() {
    // The fixture exits without answering. rust-sdk #250/#223 report in-flight
    // futures left "parked forever" in this situation, and the Python SDK's
    // #85 measured that pattern turning crashes into infinite hangs — the worse
    // of the two failures, because a hang looks like a slow answer.
    //
    // What is asserted is only that the call ENDS. Which of the two guards ends
    // it — the SDK noticing the closed transport, or our own per-call bound —
    // is printed, because it is what T3 needs to know it is proving.
    let (runtime, _events) = start(&fixture("mid-request-exit", None)).await;
    let started = std::time::Instant::now();

    let outcome = tokio::time::timeout(PATIENCE, runtime.initialize()).await;

    let elapsed = started.elapsed();
    let terminated = outcome.is_ok();
    eprintln!(
        "dead child: terminated={terminated} after {elapsed:?} (SDK close, or our INITIALIZE_BOUND)"
    );
    assert!(
        terminated,
        "a dead engine must not park a request indefinitely: {outcome:?}"
    );
    runtime.shutdown();
}

#[tokio::test]
async fn a_start_that_fails_carries_the_engines_own_last_words() {
    // The commonest way this app fails in front of its owner: the engine will not start — a
    // configuration document it rejects, a credential the provider refuses — and its one line
    // of explanation goes to stderr. The log was already captured, bounded and redacted, and
    // nothing could read it: the engine's own sentence was dropped in the same moment it was
    // produced, and the window showed "the engine connection closed" and no more.
    //
    // The credential is part of the measurement rather than decoration. What a failure sentence
    // may show is the redacted text and never the stream, and an engine echoing back an injected
    // value is exactly how a credential would otherwise reach a person through this path.
    const SECRET: &str = "sk-test-9d41f7c2ab3e";
    let mut launch = fixture("startup-refusal", None);
    launch.env.extend(env_pairs([(
        "NWK_TEST_API_KEY".to_string(),
        SECRET.to_string(),
    )]));

    let error = match EngineConnection::connect(&launch).await {
        // Which of the two this is depends on how fast the fixture's exit is noticed after the
        // handshake goes out, and the two are the same failure to a reader.
        Err(error) => error,
        Ok((connection, _events)) => connection
            .initialize(INITIALIZE_BOUND)
            .await
            .expect_err("this fixture never answers the handshake"),
    };

    let message = error.failure_message();
    assert!(
        message.contains("unknown key \"provider\""),
        "the engine's own sentence is what a start failure is read for: {message}"
    );
    assert!(
        !message.contains(SECRET),
        "and what is shown must be the redacted text, never the stream: {message}"
    );
    assert!(
        message.contains("<redacted>"),
        "with the marker standing where the credential was: {message}"
    );
}

#[tokio::test]
async fn an_engine_that_dies_the_moment_it_starts_still_gets_to_say_why() {
    // The harsher shape of the same failure, and the one the sample could be empty in: this
    // engine waits for nothing. It writes its line and exits at once, so stderr and stdout
    // close together and the failure may be noticed by the connect or by the handshake. Both
    // are covered here because either may be what a reader gets.
    //
    // What the failure carries is the `with_stderr_tail` reading, which waits for the pump to
    // reach the end of the pipe: this process's end of it is closed the moment it exits, so the
    // line it wrote before dying is read rather than raced for. This case first failed on a
    // loaded machine, where the pump task had not been polled when the failure was built; the
    // test below pins that ordering instead of waiting for a busy machine to produce it again.
    let launch = EngineLaunch {
        program: PathBuf::from("/bin/sh"),
        args: vec![
            "-c".to_string(),
            "printf 'Error: no provider is configured\\n' >&2; exit 1".to_string(),
        ],
        env: Vec::new(),
        ca_bundle: None,
    };

    let (error, noticed_by) = match EngineConnection::connect(&launch).await {
        Err(error) => (error, "connect"),
        Ok((connection, _events)) => (
            connection
                .initialize(INITIALIZE_BOUND)
                .await
                .expect_err("a process that has already exited never answers the handshake"),
            "handshake",
        ),
    };
    // Printed rather than merely asserted: which of the two noticed is the fact that says
    // whether this shape reaches the reader through the connection's own failure or through a
    // call's, and both are `Disconnected` arms carrying the same log.
    eprintln!("an engine that exits at once was noticed by the {noticed_by}");

    let message = error.failure_message();
    assert!(
        message.contains("no provider is configured"),
        "the engine's last line must survive an exit that gives nothing a head start: {message}"
    );
}

#[tokio::test]
async fn an_engine_that_speaks_only_after_the_failure_was_noticed_still_gets_to_say_why() {
    // The same failure with the ordering pinned instead of raced: the fixture closes its stdout
    // first — which is all the host ever learns about a dead engine — and writes its explanation
    // on stderr a third of a second later. The failure's sentence is therefore built before the
    // line it has to carry exists, on an idle machine or a loaded one, and the difference between
    // a reader that waits for the engine's end of stderr to close and one that samples its log at
    // the moment it notices is the whole of what this asserts.
    //
    // The credential rides along because this is a sentence a person reads: whichever arm notices
    // the failure, what it shows has been through the redactor.
    const SECRET: &str = "sk-test-9d41f7c2ab3e";
    let mut launch = fixture("late-refusal", None);
    launch.env.extend(env_pairs([(
        "NWK_TEST_API_KEY".to_string(),
        SECRET.to_string(),
    )]));

    let (error, noticed_by) = match EngineConnection::connect(&launch).await {
        Err(error) => (error, "connect"),
        Ok((connection, _events)) => (
            connection
                .initialize(INITIALIZE_BOUND)
                .await
                .expect_err("an engine that closed its stdout never answers the handshake"),
            "handshake",
        ),
    };
    eprintln!("an engine that spoke late was noticed by the {noticed_by}");

    let message = error.failure_message();
    assert!(
        message.contains("no provider is configured"),
        "a line the engine wrote after its transport closed is still its last word: {message}"
    );
    assert!(
        !message.contains(SECRET),
        "and what is shown must be the redacted text, never the stream: {message}"
    );
    assert!(
        message.contains("<redacted>"),
        "with the marker standing where the credential was: {message}"
    );
}
