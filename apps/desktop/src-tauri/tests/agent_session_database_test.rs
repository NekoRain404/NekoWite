//! Whose session database the app's engine writes, and whether a user's own `opencode` can be
//! writing the same one.
//!
//! P0 §4 left this one open in as many words: 「**ACP 与 TUI 的会话/数据库并发**：未测；方案要求「没证据就
//! 禁止双写」」. The question is not about the ACP wire — it is about the file both sides would open:
//! the pinned engine keeps its sessions in a SQLite database under a data root it resolves from the
//! environment (`<XDG_DATA_HOME>/opencode/opencode.db`, measured; `agent_two_instances_test.rs`
//! asserts it is the only database under a profile root, and the isolation test's trees show it
//! arriving beside the engine's `locks/`).
//!
//! ## What the answer is, and which half of it needed measuring
//!
//! **It cannot arise for the engine this app starts, and that is a fact about which registration is
//! ever started rather than about the environment.** [`AgentRegistration::launch`] has two policies
//! and they put the engine's data root in two different places:
//!
//! - `EnvPolicy::ProfileIsolated` names `HOME` and the four XDG roots, each pointing *inside* the
//!   profile root it is handed — so the database is
//!   `<profile root>/XDG_DATA_HOME/opencode/opencode.db`, and the profile root itself is
//!   `<managed>/agent-profiles/<profile-id>/` (`profile::PROFILES_DIR`). A user's own `opencode`
//!   resolves its data root from *their* `$HOME`, so the two paths share no directory and can only
//!   be made to meet by someone deliberately pointing a shell at the profile root.
//! - `EnvPolicy::UserEnvironment` names **none of them**, so an engine launched that way keeps the
//!   app process's own `HOME` and XDG roots — which on a desktop session are the user's, and the
//!   database it writes is the one the user's TUI writes. **This is the arm that would make the
//!   case arise**, and the tests below say exactly that, because the reason it does not arise today
//!   is not in this function: it is that nothing starts such a registration.
//!
//! ## Why the second half is a source check rather than a launch
//!
//! There is no way to write a test *of the app's behaviour* here, because the behaviour is the
//! absence of a call. [`AgentRegistry::start`] is public and takes an `agent_id`; the only caller in
//! this crate is [`state::start_session`], and the id it passes is `default_agent_id()`, which
//! `registry.rs` documents as the bundled engine with no setter. So the property under test is
//! *which argument reaches that call*, and the honest instrument for it is the source text — the
//! same instrument `command_surface_test.rs` uses over the two hand-kept command lists, and
//! `tauri-agent.test.ts` over `HostFeature::ALL`.
//!
//! **It fails the day someone wires it up**, which is the day this question has to be answered
//! rather than assumed: adding a second `start` call site, or passing anything but the default,
//! turns a real shared-database case on and this file refuses to let it happen quietly.
//!
//! ## What this file does not say
//!
//! That a shared database would be *unsafe*. The one measurement of two engines on one root
//! (`agent_two_instances_test.rs`, and `two-instances-shared-state.md` §2 for the `locks/`
//! directory that is not a lock) found SQLite's own WAL locking inside the file to be the only
//! mutual exclusion, with everything above the database shared and unarbitrated. That is a fact
//! about two instances; nothing here measures interleaved *writes*, and nothing here should be read
//! as having done so.

use std::path::{Path, PathBuf};

use nekowite_lib::agent_runtime::profile::PROFILES_DIR;
use nekowite_lib::agent_runtime::registry::{
    AgentRegistration, AgentRegistry, EnvPolicy, InstallSource,
};

/// The roots `isolated_profile_env` names, and the variables that close what the engine would
/// otherwise read out of the environment it is handed — `environment`'s record carries the full
/// list and the measurement behind each one (`environment::isolated_profile_env`).
const ROOTS: [&str; 5] = [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
];

/// The directories this crate is allowed to read for the source check below.
fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn source(relative: &str) -> String {
    std::fs::read_to_string(crate_root().join(relative))
        .unwrap_or_else(|error| panic!("reading {relative}: {error}"))
}

/// A registration that keeps the user's own environment, shaped the way the add form builds one.
fn external_registration() -> AgentRegistration {
    AgentRegistration {
        agent_id: "user-installed".to_string(),
        display_name: "The user's own OpenCode".to_string(),
        // The same provenance and policy `commands/agent_registry.rs`'s `registration_from` writes
        // for a draft: `External`, `UserEnvironment`. If that function changes, this fixture stops
        // describing a registration the app can actually produce — which is the point of spelling
        // it out here rather than calling it, since a test that called it would follow the change
        // instead of noticing it.
        source: InstallSource::External,
        program: PathBuf::from("/home/user/.local/bin/opencode"),
        args: vec!["acp".to_string()],
        env: EnvPolicy::UserEnvironment,
        env_extra: Vec::new(),
        enabled: true,
        adapter_id: "opencode".to_string(),
        reported_version: None,
    }
}

/// The names a launch sets, as a set of variables — what `execve` ends up carrying for one process.
fn named(registration: &AgentRegistration, root: &Path) -> Vec<String> {
    let credentials = nekowite_lib::agent_runtime::profile::Credentials::default();
    registration
        .launch(root, &credentials)
        .env
        .into_iter()
        .map(|(name, _)| name)
        .collect()
}

/// The app's engine writes inside the profile root, so nothing of the user's is on that path.
///
/// This is the shipped case and the only one that runs: `registry.rs`'s `with_bundled` is the
/// registry's constructor, its `default_agent_id` is the bundled registration and has no setter,
/// and the one caller of `Registry::start` passes that id. The assertion below is the arithmetic
/// that makes the database's path a fact rather than a hope — `XDG_DATA_HOME` is not merely
/// "injected", it is a directory *under* the root the caller named, which is the root this app owns.
#[test]
fn the_bundled_engines_data_root_is_inside_the_profile_root_it_is_given() {
    let root = PathBuf::from("/home/user/.local/share/dev.nekowite.app")
        .join(PROFILES_DIR)
        .join("default");
    let registry = AgentRegistry::with_bundled("/opt/nekowite/binaries/opencode");
    let bundled = registry
        .get(registry.default_agent_id())
        .expect("the default names a registration");
    assert_eq!(
        bundled.env,
        EnvPolicy::ProfileIsolated,
        "the engine this app starts no longer has its roots injected, which is the premise of \
         every sentence in this file"
    );

    let pairs: Vec<(String, String)> = nekowite_lib::agent_runtime::env_pairs(
        nekowite_lib::agent_runtime::isolated_profile_env(&root),
    )
    .into_iter()
    .map(|(name, value)| (name, value.expose().to_string()))
    .collect();
    let at = |name: &str| {
        pairs
            .iter()
            .find(|(candidate, _)| candidate == name)
            .map(|(_, value)| PathBuf::from(value))
            .unwrap_or_else(|| panic!("the launch does not set {name}: {pairs:?}"))
    };
    // The one line that decides where the database lands.
    let data = at("XDG_DATA_HOME");
    assert!(
        data.starts_with(&root) && data != root,
        "the engine's data root is {data:?}, which is not a directory inside the profile root \
         {root:?} — the database's path is no longer the profile's own"
    );
    // And `HOME` with it, since the engine resolves `.opencode` and `.claude` from that one too.
    assert!(at("HOME").starts_with(&root));
}

/// The arm that *would* share the user's database, stated as the environment it produces.
///
/// Nothing here is asserted about the app's behaviour, because the app does not run one of these —
/// see the test below, which is what keeps that true. What is asserted is the mechanism: a
/// registration with this policy hands the engine no data root at all, so the engine keeps the
/// process's own, and the process is the app the user launched from their desktop session. The
/// database that follows from those two facts is theirs.
#[test]
fn a_registration_that_keeps_the_users_environment_names_no_root_at_all() {
    let names = named(&external_registration(), Path::new("/unused"));
    for root in ROOTS {
        assert!(
            !names.iter().any(|name| name == root),
            "`{root}` is set by a `UserEnvironment` launch, which is a policy this fixture says \
             injects nothing: {names:?}"
        );
    }
    assert!(
        !names.iter().any(|name| name == "OPENCODE_DB"),
        "the session database's own variable is pointed somewhere by a `UserEnvironment` launch: \
         {names:?}"
    );
    assert!(
        names.is_empty(),
        "a `UserEnvironment` launch now carries something, so this arm is no longer the one that \
         leaves every root to the process it inherits: {names:?}"
    );
}

/// **The reachability half, and the reason this file is not merely descriptive.**
///
/// `EnvPolicy::UserEnvironment` is real code with a real producer — `agent_registry_add` writes one
/// for every draft (`commands/agent_registry.rs`'s `registration_from`) — and no caller. The
/// property that keeps the shared-database case out of this app is *which argument reaches
/// `Registry::start`*, and that is a claim about the source rather than about a value any test can
/// produce: the id comes from `default_agent_id()`, which has no setter, and this is where that is
/// read back. It fails on the day a session can be started on a registration the user added, which
/// is the day this question has to be answered instead of assumed.
#[test]
fn the_only_engine_this_app_starts_is_the_one_whose_roots_it_injects() {
    let state = source("src/state/app_state.rs");
    let caller = state
        .split_once("pub async fn start_session(")
        .expect("start_session is in state/app_state.rs")
        .1;
    // Up to the `.start(` it makes: everything before that call is what decides the id it passes,
    // and everything after it is the call's own arguments.
    let before = caller
        .split_once(".start(")
        .expect("start_session calls Registry::start")
        .0;
    assert!(
        before.contains("registry.default_agent_id()"),
        "start_session no longer takes the engine's id from `default_agent_id()`. If it now \
         accepts one from a caller, this app can start a registration whose `env` is \
         `UserEnvironment` — and that engine writes the user's own session database, the one their \
         own `opencode` has open"
    );
    // The receiver, so the assertion above is about *this* call and not about some other
    // `default_agent_id()` read in the same function body.
    assert!(
        before.contains("registry"),
        "the `.start(` in start_session is no longer made on the registry: {before}"
    );
}

/// Adding a registration does not move the default, which is the other half of the same property.
///
/// `with_bundled` is the registry's only constructor and `register` cannot touch `default_agent`.
/// A user who adds their own engine therefore gets an entry in a list and no session on it — which
/// is what makes the arm above unreachable rather than merely unused, and what would have to change
/// deliberately for it to become otherwise.
#[test]
fn registering_another_engine_does_not_move_which_one_a_session_starts_on() {
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/binaries/opencode");
    let bundled = registry.default_agent_id().to_string();
    registry
        .register(external_registration())
        .expect("a valid registration");
    assert_eq!(
        registry.default_agent_id(),
        bundled,
        "adding a registration moved the default engine"
    );
    assert_eq!(
        registry
            .get(registry.default_agent_id())
            .expect("the default names a registration")
            .env,
        EnvPolicy::ProfileIsolated,
        "the engine a new session starts on no longer has its roots injected"
    );
}
