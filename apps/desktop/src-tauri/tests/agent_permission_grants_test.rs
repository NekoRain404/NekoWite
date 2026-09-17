//! The grants path offline: the port the engine's own HTTP surface is pinned to, and what this
//! host makes of every answer that surface can give.
//!
//! The live measurement — one `Always allow`, revoked, and the engine asking again — is
//! `agent_permission_grants_live_test.rs`. This file is the half that costs nothing and can
//! therefore be exhaustive about the shapes: what the adapter declares, what the launch carries,
//! and how `permission_grants::list` reads a body.
//!
//! **The distinction this file exists to keep.** Three answers mean three different things — the
//! engine holds nothing, this agent cannot be asked, no engine is running — and a client that
//! collapsed any two of them would let a page state consent it never established. Each is pinned
//! here, including the two that must *not* be produced by a failure: a dead port is an error the
//! page reports, never an empty list.
//!
//! The fake server below speaks HTTP/1.1 by hand. That is deliberate: the contract under test is
//! the engine's four fields on the wire and the status that says whether the call happened, and
//! `reqwest` is what this host uses to speak it — so a fixture that used a second HTTP stack would
//! be testing the fixture's framing rather than the client's reading.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;

use nekowite_lib::agent_runtime::adapters;
use nekowite_lib::agent_runtime::live_notes::{
    LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes,
};
use nekowite_lib::agent_runtime::permission_grants::{self, EngineHttp, GrantsReadout, SavedGrant};
use nekowite_lib::agent_runtime::profile::Credentials;
use nekowite_lib::agent_runtime::registry::{
    AgentInstance, AgentRegistration, AgentRegistry, EnvPolicy, InstallSource,
};
use nekowite_lib::agent_runtime::{fs_capability::VaultFiles, EngineLaunch};

// ---------------------------------------------------------------------------
// Scratch
// ---------------------------------------------------------------------------

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-grants-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

struct NoVault;

impl VaultFiles for NoVault {
    fn frontend_path(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("this test must not ask a window about a note")
    }
    fn read(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("this test must not read a note")
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<Option<String>, String> {
        panic!("this test must not write a note")
    }
}

struct NoWindow;

impl LiveNoteWindows for NoWindow {
    fn ask(&self, _question: &LiveNoteQuestion) -> usize {
        0
    }
}

// ---------------------------------------------------------------------------
// The adapter's declaration, and what it puts in a launch
// ---------------------------------------------------------------------------

#[test]
fn only_the_engine_whose_routes_were_read_declares_an_http_surface() {
    let opencode = adapters::lookup(adapters::opencode::ADAPTER_ID).expect("the bundled adapter");
    assert_eq!(
        opencode.http_api(),
        Some(adapters::opencode::HTTP_API),
        "the pinned engine's routes are its adapter's to know"
    );
    // The other half matters as much: an engine this build has no verified adapter for must answer
    // `None`, because that is what the grants page draws as "this agent does not report grants"
    // instead of as an empty list.
    let generic = adapters::lookup(adapters::generic_acp::ADAPTER_ID).expect("the generic adapter");
    assert_eq!(generic.http_api(), None);
}

#[test]
fn pinning_a_port_appends_the_engines_own_flag_and_reports_the_port() {
    let mut launch = EngineLaunch {
        program: PathBuf::from("/bin/true"),
        args: vec!["acp".to_string()],
        env: Vec::new(),
        ca_bundle: None,
    };
    let http = permission_grants::pin_http(&mut launch, Some(adapters::opencode::HTTP_API))
        .expect("a port is chosen");
    assert_eq!(
        launch.args,
        vec![
            "acp".to_string(),
            adapters::opencode::HTTP_API.port_flag.to_string(),
            http.port.to_string()
        ],
        "the flag and the port are appended to whatever the registration asked for"
    );
    assert!(http.port > 0, "the kernel never hands out port zero");
    assert_eq!(http.api, adapters::opencode::HTTP_API);
}

#[test]
fn an_engine_with_no_http_surface_gets_no_flag() {
    let mut launch = EngineLaunch {
        program: PathBuf::from("/bin/true"),
        args: vec!["acp".to_string()],
        env: Vec::new(),
        ca_bundle: None,
    };
    assert_eq!(permission_grants::pin_http(&mut launch, None), None);
    assert_eq!(
        launch.args,
        vec!["acp".to_string()],
        "an engine this host may not call leaves the launch exactly as the registration wrote it"
    );
}

// ---------------------------------------------------------------------------
// The launch path itself, through the registry that starts real sessions
// ---------------------------------------------------------------------------

/// A registration that reaches the fixture engine through the *opencode* adapter.
///
/// The adapter id is the whole point: `registry::start` asks the adapter for its HTTP surface, so
/// a fixture registered under the generic adapter would measure the `None` arm and nothing else.
/// The fixture ignores arguments it does not know, so the port flag appended after its own two is
/// carried and not acted on — which is exactly what "the engine was started with a pinned port"
/// means for a process that serves no HTTP.
fn fixture_agent_via_opencode(script: &Path) -> AgentRegistration {
    AgentRegistration {
        agent_id: "pinned".to_string(),
        display_name: "Fixture under the OpenCode adapter".to_string(),
        source: InstallSource::External,
        program: PathBuf::from("/bin/sh"),
        args: vec![
            script.to_string_lossy().into_owned(),
            "good".to_string(),
        ],
        env: EnvPolicy::UserEnvironment,
        env_extra: Vec::new(),
        enabled: true,
        adapter_id: adapters::opencode::ADAPTER_ID.to_string(),
        reported_version: None,
    }
}

async fn start(registry: &AgentRegistry, agent_id: &str, root: &Path) -> AgentInstance {
    registry
        .start(
            agent_id,
            "prof",
            "vault-1",
            root,
            &Credentials::default(),
            Arc::new(NoVault),
            LiveNotes::new(Arc::new(LiveNoteTable::new()), Arc::new(NoWindow)),
        )
        .await
        .expect("the fixture engine should start")
}

#[tokio::test]
async fn a_session_under_the_opencode_adapter_starts_with_a_pinned_port_and_still_handshakes() {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh");
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    registry
        .register(fixture_agent_via_opencode(&script))
        .expect("registers");
    registry.bind_profile("prof", "pinned").expect("binds");
    let root = temp_dir("pinned");

    let instance = start(&registry, "pinned", &root).await;
    // The handshake is the regression this test is really here for: appending a flag to an
    // engine's argv is a change to every launch this app makes, and an engine that refused it
    // would fail here rather than in a user's window.
    instance
        .runtime()
        .initialize()
        .await
        .expect("the engine still initializes with a port pinned");

    let http = instance.http().expect("the adapter declared a surface");
    assert!(http.port > 0);

    // Nothing is listening on that port in this fixture, and the answer to that is an error: the
    // page's unreadable state with a retry. It is emphatically *not* an empty list, which would be
    // this host reporting "you have granted nothing" from a call that never happened.
    match permission_grants::list(Some(http)).await {
        Err(detail) => assert!(
            detail.contains("saved permissions"),
            "the failure names what was being asked for: {detail}"
        ),
        Ok(other) => panic!("a port nothing answers on is not a readout: {other:?}"),
    }
}

#[tokio::test]
async fn an_engine_with_no_declared_surface_is_reported_as_unsupported() {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh");
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    let mut registration = fixture_agent_via_opencode(&script);
    registration.agent_id = "generic".to_string();
    registration.args = vec![script.to_string_lossy().into_owned(), "good".to_string()];
    registration.adapter_id = adapters::generic_acp::ADAPTER_ID.to_string();
    registry.register(registration).expect("registers");
    registry.bind_profile("prof", "generic").expect("binds");
    let root = temp_dir("generic");

    let instance = start(&registry, "generic", &root).await;
    assert_eq!(instance.http(), None);
    assert_eq!(
        permission_grants::list(instance.http()).await.expect("answered"),
        GrantsReadout::Unsupported,
        "the connected agent cannot be asked, which is not the same claim as an empty list"
    );
}

// ---------------------------------------------------------------------------
// The engine's own answers, from a server that speaks them by hand
// ---------------------------------------------------------------------------

/// One request the fake server saw: the method and the path, so a test can assert what was called.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Seen {
    method: String,
    path: String,
}

/// A loopback server that answers each request with the next scripted reply.
///
/// Bounded and finite on purpose: it serves exactly as many requests as it was given replies for,
/// and a test that makes one more call than it scripted fails on the channel rather than hanging.
struct FakeEngine {
    port: u16,
    seen: mpsc::Receiver<Seen>,
}

fn fake_engine(replies: Vec<(u16, String)>) -> FakeEngine {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let port = listener.local_addr().expect("an address").port();
    let (tx, seen) = mpsc::channel();
    thread::spawn(move || {
        for (status, body) in replies {
            let Ok((stream, _)) = listener.accept() else { return };
            let request = read_request(&stream);
            let _ = tx.send(request);
            write_response(stream, status, &body);
        }
    });
    FakeEngine { port, seen }
}

fn read_request(stream: &TcpStream) -> Seen {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let _ = reader.read_line(&mut line);
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    // Drain the headers so the client's write does not block, and so a body (there is none on
    // either route) would not be read as the next request line.
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
            break;
        }
    }
    Seen { method, path }
}

fn write_response(mut stream: TcpStream, status: u16, body: &str) {
    let reason = if status == 204 { "No Content" } else { "OK" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn http_at(port: u16) -> EngineHttp {
    EngineHttp {
        port,
        api: adapters::opencode::HTTP_API,
    }
}

fn received(engine: &FakeEngine) -> Seen {
    engine
        .seen
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the fake engine saw the call")
}

#[tokio::test]
async fn the_engines_own_four_fields_are_read_verbatim() {
    let engine = fake_engine(vec![(
        200,
        r#"{"data":[{"id":"psv_1","projectID":"global","action":"edit","resource":"*"}]}"#.to_string(),
    )]);
    let readout = permission_grants::list(Some(http_at(engine.port)))
        .await
        .expect("the engine answered");
    assert_eq!(
        readout,
        GrantsReadout::Listed {
            grants: vec![SavedGrant {
                id: "psv_1".to_string(),
                project_id: "global".to_string(),
                action: "edit".to_string(),
                resource: "*".to_string(),
            }]
        }
    );
    assert_eq!(
        received(&engine),
        Seen {
            method: "GET".to_string(),
            path: "/api/permission/saved".to_string()
        }
    );
}

#[tokio::test]
async fn a_removal_goes_to_the_id_path_and_answers_the_list_afterwards() {
    let engine = fake_engine(vec![
        (204, String::new()),
        (
            200,
            r#"{"data":[]}"#.to_string(),
        ),
    ]);
    let readout = permission_grants::remove(Some(http_at(engine.port)), "psv_1")
        .await
        .expect("the engine answered");
    assert_eq!(readout, GrantsReadout::Listed { grants: Vec::new() });
    assert_eq!(
        received(&engine),
        Seen {
            method: "DELETE".to_string(),
            path: "/api/permission/saved/psv_1".to_string()
        }
    );
    // And the list is the engine's own answer afterwards, which is why the fake needed a second
    // scripted reply rather than this host striking the row out of its own copy.
    assert_eq!(
        received(&engine),
        Seen {
            method: "GET".to_string(),
            path: "/api/permission/saved".to_string()
        }
    );
}

#[tokio::test]
async fn an_empty_list_is_the_engines_own_statement_and_not_a_failure() {
    let engine = fake_engine(vec![(200, r#"{"data":[]}"#.to_string())]);
    assert_eq!(
        permission_grants::list(Some(http_at(engine.port)))
            .await
            .expect("an empty list is an answer"),
        GrantsReadout::Listed { grants: Vec::new() }
    );
}

#[tokio::test]
async fn a_body_this_host_cannot_read_is_an_error_rather_than_an_empty_list() {
    // Each of these would otherwise be read as "the engine holds nothing", which is a claim about
    // consent made from a document nobody could parse.
    for body in [
        "{}",
        r#"{"data":{}}"#,
        r#"{"data":[{"id":"psv_1","action":"edit","resource":"*"}]}"#,
        "not json at all",
    ] {
        let engine = fake_engine(vec![(200, body.to_string())]);
        let answer = permission_grants::list(Some(http_at(engine.port))).await;
        assert!(
            answer.is_err(),
            "{body} is not a readout this host may draw: {answer:?}"
        );
    }
}

#[tokio::test]
async fn a_refused_call_is_an_error_and_never_a_removal() {
    let engine = fake_engine(vec![(500, r#"{"message":"no"}"#.to_string())]);
    let answer = permission_grants::remove(Some(http_at(engine.port)), "psv_1").await;
    assert!(
        answer.is_err(),
        "a removal the engine refused must not read as a removal: {answer:?}"
    );
}

#[tokio::test]
async fn an_id_that_is_not_the_engines_own_shape_never_reaches_a_url() {
    // The id is a path segment of the engine's route. A renderer-supplied string that reached it
    // unchecked could address a different route than the one this host means to call, so the
    // refusal is here rather than at the engine's parser.
    for id in ["", "../saved", "psv_1/../../session", "psv 1", "psv#1"] {
        let answer = permission_grants::remove(Some(http_at(1)), id).await;
        assert!(
            answer.is_err(),
            "{id:?} must be refused before any request is made: {answer:?}"
        );
    }
}

#[tokio::test]
async fn no_engine_and_no_surface_are_two_answers_the_client_never_confuses_with_a_list() {
    // `None` from the client means the adapter has no route to call. `NotRunning` belongs to the
    // command layer, which is the only layer that knows whether a session exists — and the two
    // travel as different kinds so the page cannot draw either as "you have granted nothing".
    assert_eq!(
        permission_grants::list(None).await.expect("answered"),
        GrantsReadout::Unsupported
    );
    assert_eq!(
        permission_grants::remove(None, "psv_1").await.expect("answered"),
        GrantsReadout::Unsupported
    );
}
