//! R8 (definitions) — which engine this app may start, and what a registration is allowed to say.
//!
//! §3.4 splits agent handling in two, and this file is the definition half: the bundled default
//! (§3.4.1), the path and argument array a user typed (§3.4.3), the environment policy, and the
//! capability and configuration declarations that belong to the engine's adapter (§3.4.5, §3.4.6).
//! The identity half — two engines running at once and not crossing streams — is
//! `agent_isolation_test.rs`; the split is by behaviour domain, as §9 asks for files over the
//! budget.
//!
//! The engine half is T2's fixture (`tests/fixtures/agent/fake_agent.sh`), unmodified.
//!
//! Module inclusion: `agent_runtime/mod.rs` declares `registry` and `adapters`,
//! and `lib.rs` declares `agent_runtime` — the registration this test used to do
//! by hand with `#[path]`, which is what a test does while the files that
//! register the tree belong to another task. The path is gone; the modules
//! imported below are the library's own.

use nekowite_lib::agent_runtime;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agent_runtime::adapters::{self, Capability, ConfigAuthoring, HostFeature};
use agent_runtime::events::{AgentEventEnvelope, AgentEventKind};
use agent_runtime::fs_capability::VaultFiles;
use agent_runtime::profile::Credentials;
use agent_runtime::registry::{
    redacted_env, AgentInstance, AgentRegistration, AgentRegistry, EnvPolicy, InstallSource,
    ProgramState, RegistryError, UpdatePolicy, DEFAULT_PROFILE,
};
use agent_runtime::secret::Secret;
use agent_runtime::session::AgentRuntimeEvents;

/// Generous enough that a slow machine does not flake, short enough that a hang fails the run
/// rather than the suite's timeout.
const PATIENCE: Duration = Duration::from_secs(10);

/// No test here touches a vault: the fixture sends no `fs/*` request of its own, so reaching this
/// would mean something unexpected was being served rather than a stub to fill in.
struct NoVault;

impl VaultFiles for NoVault {
    fn read(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("this test must not read a vault")
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<Option<String>, String> {
        panic!("this test must not write a vault")
    }
}

fn fixture_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh")
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-registry-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// A registration for the fixture engine written the way §3.4.3 has a user write one: an absolute
/// path to a program, and the arguments as an array.
fn fixture_agent(agent_id: &str, behaviour: &str) -> AgentRegistration {
    AgentRegistration {
        agent_id: agent_id.to_string(),
        display_name: format!("Fake {agent_id}"),
        source: InstallSource::External,
        program: PathBuf::from("/bin/sh"),
        args: vec![
            fixture_script().to_string_lossy().into_owned(),
            behaviour.to_string(),
        ],
        env: EnvPolicy::UserEnvironment,
        env_extra: Vec::new(),
        enabled: true,
        adapter_id: adapters::generic_acp::ADAPTER_ID.to_string(),
        reported_version: None,
    }
}

/// Start one engine, or the refusal that stopped it: the five arguments spelled once.
async fn try_start(
    registry: &AgentRegistry,
    agent_id: &str,
    profile_id: &str,
    vault_id: &str,
    root: &Path,
) -> Result<AgentInstance, RegistryError> {
    registry
        .start(
            agent_id,
            profile_id,
            vault_id,
            root,
            &Credentials::default(),
            Arc::new(NoVault),
        )
        .await
}

/// Start one engine and finish its handshake, so a test can talk to it.
async fn started(
    registry: &AgentRegistry,
    agent_id: &str,
    profile_id: &str,
    vault_id: &str,
    root: &Path,
) -> AgentInstance {
    let instance = try_start(registry, agent_id, profile_id, vault_id, root)
        .await
        .expect("the fixture engine should start");
    instance
        .runtime()
        .initialize()
        .await
        .expect("the fixture engine should initialize");
    instance
}

async fn next_event(events: &mut AgentRuntimeEvents) -> AgentEventEnvelope {
    tokio::time::timeout(PATIENCE, events.next_event())
        .await
        .expect("an event should arrive")
        .expect("the runtime should still be running")
}

/// Reads events until `stop` says so, so a test asserts on a whole run rather than on whichever
/// event arrived first.
async fn events_until(
    events: &mut AgentRuntimeEvents,
    mut stop: impl FnMut(&AgentEventEnvelope) -> bool,
) -> Vec<AgentEventEnvelope> {
    let mut collected = Vec::new();
    loop {
        let event = next_event(events).await;
        let done = stop(&event);
        collected.push(event);
        if done {
            return collected;
        }
    }
}

fn texts(events: &[AgentEventEnvelope]) -> Vec<String> {
    events
        .iter()
        .filter(|event| event.kind == AgentEventKind::TextDelta)
        .filter_map(|event| event.payload.get("text")?.as_str().map(str::to_string))
        .collect()
}

/// The error a call that must be refused produced, or a failure.
fn refused<T>(result: Result<T, RegistryError>) -> RegistryError {
    match result {
        Ok(_) => panic!("expected a refusal, got a running instance"),
        Err(error) => error,
    }
}

/// Opens a session on a started instance and returns the engine's own session id.
async fn open_session(instance: &mut AgentInstance, root: &Path) -> String {
    instance
        .runtime()
        .open_session(root)
        .await
        .expect("session/new")
        .session_id
}

/// Prompts, then reads the run to its end.
async fn run_to_finish(
    instance: &mut AgentInstance,
    session_id: &str,
    prompt: &str,
) -> Vec<AgentEventEnvelope> {
    instance
        .runtime()
        .prompt(session_id, prompt)
        .expect("prompt");
    let events = instance.events_mut().expect("the fixture's reader is still here");
    events_until(events, |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await
}

#[test]
fn the_default_agent_is_the_bundled_opencode() {
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    let registration = registry
        .get(registry.default_agent_id())
        .expect("the default agent is a registration");
    assert_eq!(registry.default_agent_id(), adapters::opencode::AGENT_ID);
    assert_eq!(registration.source, InstallSource::Bundled);
    assert_eq!(registration.display_name, adapters::opencode::DISPLAY_NAME);
    assert_eq!(
        registration.args,
        vec!["acp".to_string()],
        "the ACP invocation is the adapter's to know, not a caller's to pass"
    );
    assert_eq!(registration.adapter_id, adapters::opencode::ADAPTER_ID);
    assert_eq!(registration.env, EnvPolicy::ProfileIsolated);
    assert!(registration.enabled, "a new session starts on it");
    assert_eq!(registry.registrations().count(), 1, "and it is the only one");
    // The sidecar is a build product (T14), so a path with nothing at it is a normal state of a
    // checkout — a state the settings page reports, not a malformed definition.
    assert_eq!(registration.program_state(), ProgramState::Missing);
    assert!(registration.validate().is_ok());
    // The default profile is bound to it, so the first-run flow has one to use. Rebinding the same
    // pair is the idempotent re-submit a settings form makes; another agent's id is not free to take.
    assert!(registry.bind_profile(DEFAULT_PROFILE, "opencode").is_ok());
    assert!(registry
        .bind_profile(DEFAULT_PROFILE, "nobody-registered")
        .is_err());

    // §3.4.1 makes it the fixed answer for a new session, so the default is not a removable or
    // disable-able entry: a new-session menu with nothing to preselect is not a state this app has.
    assert!(matches!(
        registry.remove("opencode"),
        Err(RegistryError::IsDefault { .. })
    ));
    assert!(matches!(
        registry.set_enabled("opencode", false),
        Err(RegistryError::IsDefault { .. })
    ));
}

#[tokio::test]
async fn the_bundled_default_cannot_start_from_a_sidecar_that_was_never_built() {
    let registry = AgentRegistry::with_bundled("/opt/nekowite/opencode-missing");
    let error = refused(
        try_start(
            &registry,
            "opencode",
            DEFAULT_PROFILE,
            "vault-1",
            &temp_dir("missing-sidecar"),
        )
        .await,
    );
    assert!(
        matches!(
            error,
            RegistryError::Program {
                state: ProgramState::Missing,
                ..
            }
        ),
        "{error:?}"
    );
}

#[test]
fn a_program_path_and_its_arguments_are_validated_apart() {
    use std::os::unix::fs::PermissionsExt;
    // The path half: a relative path can never work, because this process's working directory is
    // the app's and not the user's — a bare `opencode` must be refused, not searched for on a PATH
    // this host does not have.
    let mut registration = fixture_agent("fake-a", "good");
    registration.program = PathBuf::from("opencode");
    assert!(matches!(
        registration.validate(),
        Err(RegistryError::Program {
            state: ProgramState::NotAbsolute,
            ..
        })
    ));
    // The two states the filesystem has to supply, on a path that is otherwise well formed.
    let dir = temp_dir("states");
    let a_directory = dir.join("not-a-program");
    fs::create_dir(&a_directory).expect("a directory");
    registration.program = a_directory;
    assert_eq!(registration.program_state(), ProgramState::NotAFile);
    let plain = dir.join("plain");
    fs::write(&plain, "#!/bin/sh\n").expect("a file");
    fs::set_permissions(&plain, fs::Permissions::from_mode(0o644)).expect("no executable bit");
    registration.program = plain;
    assert_eq!(registration.program_state(), ProgramState::NotExecutable);
    // The argument half, on a registration whose path is fine: the error names the argument's
    // position, which is what a form has to point at.
    registration.program = PathBuf::from("/bin/sh");
    registration.args = vec![
        fixture_script().to_string_lossy().into_owned(),
        "a\0b".to_string(),
    ];
    assert!(matches!(
        registration.validate(),
        Err(RegistryError::Argument { index: 1 })
    ));
    // Both wrong at once: the path is reported first, and fixing it reveals the argument rather
    // than hiding it — the two checks stand on separate evidence.
    let mut both = registration.clone();
    both.program = PathBuf::from("relative/opencode");
    assert!(matches!(
        both.validate(),
        Err(RegistryError::Program { .. })
    ));
    both.program = PathBuf::from("/bin/sh");
    assert!(matches!(
        both.validate(),
        Err(RegistryError::Argument { index: 1 })
    ));
    registration.args = vec![fixture_script().to_string_lossy().into_owned()];
    assert!(registration.validate().is_ok(), "wrong in neither way");
}

#[tokio::test]
async fn a_program_path_and_an_argument_containing_spaces_are_launched_whole() {
    // §11.1's 「参数含空格」, in the one form that can fail: a shell — or anything that joined the
    // array into a command line — splits on spaces, and neither the interpreter nor the fixture
    // would be found. Nothing here is a mock; the space is in the paths around T2's fixture.
    use std::os::unix::fs::symlink;
    let spaced = temp_dir("spaces").join("a directory with spaces");
    fs::create_dir_all(&spaced).expect("a directory whose name has spaces");
    // A link rather than a copy: `program_state` follows links, and `execve` refuses a file this
    // process has just created (ETXTBSY) — a property of the test, not of the code under it.
    let shell = spaced.join("sh");
    symlink("/bin/sh", &shell).expect("a link to the shell, under a name with spaces");
    let script = spaced.join("fake agent.sh");
    fs::copy(fixture_script(), &script).expect("a copy of the fixture under a name with spaces");
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    let mut registration = fixture_agent("fake-a", "good");
    registration.program = shell;
    registration.args = vec![script.to_string_lossy().into_owned(), "good".to_string()];
    registry.register(registration).expect("registers");
    registry.bind_profile("prof-a", "fake-a").expect("binds");
    assert_eq!(
        registry.get("fake-a").expect("registered").program_state(),
        ProgramState::Launchable,
        "a path with spaces in it is a path like any other"
    );
    let root = temp_dir("spaces-root");
    let mut instance = started(&registry, "fake-a", "prof-a", "vault-1", &root).await;
    let session = open_session(&mut instance, &root).await;
    let events = run_to_finish(&mut instance, &session, "hello").await;
    assert_eq!(
        texts(&events),
        vec!["first"],
        "the engine answered, so both spaced paths reached execve whole"
    );
}

#[tokio::test]
async fn an_external_program_that_goes_missing_is_reported_and_the_registration_survives() {
    let dir = temp_dir("vanished");
    let shell = dir.join("sh");
    fs::copy("/bin/sh", &shell).expect("a copy of the shell");
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    let mut registration = fixture_agent("fake-a", "good");
    registration.program = shell.clone();
    registry.register(registration).expect("registers");
    registry.bind_profile("prof-a", "fake-a").expect("binds");
    assert_eq!(
        registry.get("fake-a").expect("registered").program_state(),
        ProgramState::Launchable
    );
    fs::remove_file(&shell).expect("the user moves their installation");
    // §3.4.3's diagnostic reports the state, and §3.4.7's removal is a separate, deliberate act:
    // nothing here deletes a definition because a file moved.
    let registration = registry.get("fake-a").expect("still registered");
    assert!(registration.enabled);
    assert_eq!(registration.program_state(), ProgramState::Missing);
    let error = refused(
        try_start(
            &registry,
            "fake-a",
            "prof-a",
            "vault-1",
            &temp_dir("vanished-root"),
        )
        .await,
    );
    assert!(
        matches!(
            error,
            RegistryError::Program {
                state: ProgramState::Missing,
                ..
            }
        ),
        "{error:?}"
    );
}

#[test]
fn capabilities_come_from_the_adapter_and_are_never_borrowed_from_opencode() {
    let bundled = adapters::opencode::bundled_registration("/opt/nekowite/opencode".into());
    let external = fixture_agent("fake-a", "good");
    // §2.2's rule that the fallback must not become "OpenCode supports it": an engine whose adapter
    // has measured nothing advertises nothing, for every feature.
    for feature in HostFeature::ALL {
        assert_eq!(
            external.declared_capability(feature),
            Capability::Unverified,
            "{feature:?} must not be offered for an engine nobody measured"
        );
    }
    for feature in [
        HostFeature::SessionResume,
        HostFeature::SlashCommands,
        HostFeature::ModelSelection,
        HostFeature::ImageAttachments,
        HostFeature::SessionConfigOptions,
    ] {
        assert_eq!(
            bundled.declared_capability(feature),
            Capability::Advertised,
            "{feature:?}"
        );
    }
    assert_eq!(
        bundled.declared_capability(HostFeature::AudioAttachments),
        Capability::NotAdvertised,
        "the measured handshake has no audio capability, and §3.4.6 wants that shown, not assumed"
    );
    // §3.4.5: only a verified adapter has a configuration format to write, and `NativeOnly` carries
    // no name — so nothing can ask for OpenCode's format under another engine's.
    assert_eq!(
        adapters::lookup(adapters::opencode::ADAPTER_ID)
            .expect("opencode")
            .config_authoring(),
        ConfigAuthoring::Verified {
            format: adapters::opencode::CONFIG_FORMAT
        }
    );
    assert_eq!(
        adapters::lookup(adapters::generic_acp::ADAPTER_ID)
            .expect("generic-acp")
            .config_authoring(),
        ConfigAuthoring::NativeOnly
    );
    // The model option id is the engine's to define (§6.3), so only a verified adapter has one.
    assert_eq!(
        bundled.adapter().expect("an adapter").model_option_id(),
        Some(adapters::opencode::MODEL_OPTION_ID)
    );
    assert_eq!(
        external.adapter().expect("an adapter").model_option_id(),
        None,
        "generic_acp refuses to guess what it has not measured"
    );
    // An adapter id nobody answers to is refused at the form, not at launch — and a value asked
    // what it can do answers the state that offers nothing.
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    let mut unknown = fixture_agent("fake-a", "good");
    unknown.adapter_id = "opencode-next".to_string();
    assert!(matches!(
        registry.register(unknown.clone()),
        Err(RegistryError::UnknownAdapter { .. })
    ));
    assert_eq!(
        unknown.declared_capability(HostFeature::SlashCommands),
        Capability::Unverified
    );
}

#[test]
fn a_credential_in_a_registration_is_never_printable() {
    let mut registration = fixture_agent("fake-a", "good");
    registration.env_extra = vec![
        (
            "ANTHROPIC_API_KEY".to_string(),
            "sk-ant-oat01-not-a-real-key".to_string(),
        ),
        (
            "OPENCODE_CONFIG_DIR".to_string(),
            "/home/someone/.config/opencode".to_string(),
        ),
        (
            "anthropic_api_key".to_string(),
            "sk-ant-lowercase-not-a-real-key".to_string(),
        ),
    ];
    let printed = format!("{registration:?}");
    assert!(
        !printed.contains("not-a-real-key"),
        "a credential must not reach a log line: {printed}"
    );
    assert!(printed.contains("<redacted>"));
    assert!(
        printed.contains("/home/someone/.config/opencode"),
        "masking everything would hide the diagnostics this exists to keep"
    );
    assert_eq!(
        redacted_env(&registration.env_extra)[2].1,
        "<redacted>",
        "case is not a promise: a lowercase spelling is the same variable to the kernel"
    );
    // Redaction is about the printed form, not about function: the engine still gets the value,
    // because P0 §3's channel for credentials is the environment.
    let launch = registration.launch(Path::new("/managed"), &Credentials::default());
    assert!(launch
        .env
        .iter()
        .any(|(name, value)| name == "ANTHROPIC_API_KEY"
            && value.expose() == "sk-ant-oat01-not-a-real-key"));
    // And the launch itself is print-safe: T3a found `EngineLaunch` deriving `Debug` over a
    // `Vec<(String, String)>`, which would have put a provider key in whatever log line printed
    // one. The field is made of `Secret`s now, so the derive is safe at the struct that made the
    // mistake reachable rather than only at this registration's own hand-written `Debug`.
    let printed_launch = format!("{launch:?}");
    assert!(
        !printed_launch.contains("not-a-real-key"),
        "a launch must not be printable: {printed_launch}"
    );
    assert!(printed_launch.contains("<redacted>"), "{printed_launch}");
    // A variable that could not reach a process at all is refused rather than passed on.
    registration.env_extra = vec![("A=B".to_string(), "1".to_string())];
    assert!(matches!(
        registration.validate(),
        Err(RegistryError::Environment { .. })
    ));
    registration.env_extra = vec![("EMPTY".to_string(), "with\0nul".to_string())];
    assert!(
        matches!(
            registration.validate(),
            Err(RegistryError::Environment { .. })
        ),
        "`execve` takes NUL-terminated strings, so a value containing one would truncate silently"
    );
}

#[test]
fn where_a_program_came_from_decides_who_may_replace_it_and_what_it_inherits() {
    // §3.4.6 and §2.1: an external installation's version may be reported, never acted on.
    assert_eq!(
        InstallSource::External.update_policy(),
        UpdatePolicy::ReportedOnly
    );
    assert_eq!(
        InstallSource::Bundled.update_policy(),
        UpdatePolicy::HostManaged
    );
    assert_eq!(
        InstallSource::Managed.update_policy(),
        UpdatePolicy::HostManaged
    );
    let mut external = fixture_agent("fake-a", "good");
    external.reported_version = Some("1.18.29".to_string());
    assert_eq!(
        external.source.update_policy(),
        UpdatePolicy::ReportedOnly,
        "a reported version is a fact about the user's install, not a licence to swap it"
    );
    // The environment follows the same split: a managed engine works inside the profile this app
    // owns, an external one keeps the environment it has.
    let root = Path::new("/managed/agent-profiles/default");
    let env = adapters::opencode::bundled_registration("/opt/nekowite/opencode".into())
        .launch(root, &Credentials::default())
        .env;
    assert!(
        env.iter()
            .any(|(name, value)| name == "HOME" && Path::new(value.expose()) == root.join("HOME")),
        "{env:?}"
    );
    assert!(env.iter().any(|(name, _)| name == "XDG_CONFIG_HOME"));
    assert!(
        external
            .launch(root, &Credentials::default())
            .env
            .is_empty(),
        "nothing of ours is injected into an external installation"
    );

    // The third part of a launch is the profile's credentials (§8.1), and they arrive whatever the
    // registration's environment policy is: the policy decides which *roots* the engine reads its
    // configuration from, while a credential is a value the user typed for this profile, and P0 §3
    // makes the environment the channel it travels in. An external registration therefore carries
    // exactly the profile's set — the one this test's `Credentials::default()` above showed empty.
    let credentials = Credentials::new([(
        "ANTHROPIC_API_KEY".to_string(),
        Secret::new("sk-ant-oat01-not-a-real-key"),
    )]);
    let with_credentials = external.launch(root, &credentials).env;
    assert_eq!(with_credentials.len(), 1, "{with_credentials:?}");
    assert_eq!(with_credentials[0].0, "ANTHROPIC_API_KEY");
    assert_eq!(with_credentials[0].1.expose(), "sk-ant-oat01-not-a-real-key");
}
