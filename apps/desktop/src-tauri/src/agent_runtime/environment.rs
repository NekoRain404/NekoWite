//! The environment one engine is handed: the roots of a profile-isolated launch, and the
//! variables that must not decide anything anyway.
//!
//! Its own module rather than part of [`super::process`] because it is a *record* as much as a
//! function: what is closed here, what is left open on purpose, and how each was measured. The
//! process module keeps the process — spawning, the frame bound, the stderr sample.

use std::path::Path;

/// The environment an engine gets when it must not touch the developer's own profile: `HOME` and
/// the four XDG roots all point into `root`.
///
/// Plan §10.4 forbids exercising the real OpenCode profile, and the engine writes config, state and
/// logs under these roots the moment it starts. Used by the real-engine tests, where there is a
/// real profile to protect.
///
/// # What this closes, and what it does not (measured)
///
/// §8.1 refused to let 「所有全局发现已关闭」 be asserted without evidence, and P0 §4 listed the
/// profile's isolation as unverified. It has been measured against the pinned engine, by planting a
/// decoy provider in every place the engine's discovery looks and reading back what `session/new`
/// advertised — `tests/agent_profile_isolation_test.rs` and
/// `tests/agent_inherited_environment_test.rs` are that measurement, and these entries fail if
/// either half of what follows changes.
///
/// **Closed, and by these roots.** The engine resolves its own home from `$HOME`, so
/// `$HOME/.config/opencode`, `$HOME/.opencode`, `$HOME/.claude` and `$HOME/.agents` are all read
/// from inside `root`; `XDG_CONFIG_HOME` moves the global configuration root with them. The decoys
/// planted at those relative paths are discovered, which is the positive control — the same files
/// at the same paths stop being reachable when `HOME` is left alone. The developer's real profile,
/// real configuration and real compatible-tool directories are therefore not read by an engine
/// launched this way.
///
/// **Closed a second time, because the roots alone did not close it.**
/// `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` is set here for one measured reason: the engine reaches
/// `.claude` and `.agents` by a *second* route that no environment root can move. Alongside reading
/// them under `$HOME`, it walks up from the working directory — to the worktree, and past it where
/// there is none — and reads `skills/**` from every `.claude` and `.agents` it passes. That walk is
/// driven by the path, not by the environment, so a vault anywhere under the user's home directory
/// drags the user's real `~/.claude/skills` into this profile as agent commands: measured, the same
/// launch discovered 9 commands from a working directory inside a checkout and 43 (3 built in, 38
/// the developer's own, in-profile decoys beside them) from one under the home directory, with
/// nothing changed but the path. This is the leak the README of [`super::process`] is about — it is
/// the developer's *own profile* being read, not a project's configuration — which is why the
/// switch is here and not in an adapter. The engine's own documentation names it for exactly this,
/// and `skills.rs` already records it as the one whole-scope switch that exists.
///
/// **Open, and deliberately not closed here.** The same walk also reads a project's `opencode.json`
/// and `.opencode/` directories, and every decoy planted along it is discovered: a vault
/// contributes its providers and its permission rules to this profile.
/// `OPENCODE_DISABLE_PROJECT_CONFIG=1` closes that (measured: an inherited one removes a project's
/// own provider from the model list), and is not set here for §3.4's reason rather than for
/// convenience — which project configuration an engine merges is a fact about that engine, so it
/// belongs in `AgentRegistration::env_extra` and `adapters/opencode.rs`, beside the invocation and
/// the config format. Nothing about the user's own profile is at stake in it, which is what
/// separates it from the switch above.
///
/// **Open, and not closable by any supported variable.** On Linux the engine merges
/// `opencode.json`/`opencode.jsonc` from its managed configuration root, `/etc/opencode`, at global
/// precedence. Nothing turns that off. The engine's one way to move it is
/// `OPENCODE_TEST_MANAGED_CONFIG_DIR`, a hook named for the engine's own test suite, and it is left
/// where the engine put it: the managed root is a *system administrator's* policy surface, this
/// app's own roots say nothing about it, and a fixed `/etc/opencode` here would bake one
/// distribution's answer into a function that knows nothing about profiles. Measured with the
/// decoy `agent_profile_isolation_test.rs` already plants at that root: an inherited value moves
/// the root and the decoy becomes the profile's configuration, which is the honest statement of
/// what is open.
///
/// # The environment this launch is *added to*
///
/// Everything above is about what the launch *sets*. The SDK spawns the engine with
/// `Command::envs` on a `Command` that never calls `env_clear` (`agent-client-protocol` 2.1.0,
/// `acp_agent.rs`'s `spawn_process`), so the engine is handed everything this app was itself
/// started with, and the launch's own entry is what `execve` carries where the two name the same
/// variable. Nothing here could *remove* a variable — the SDK's launch description has no way to
/// say so — but setting one is enough.
///
/// The pinned engine's string table names 82 distinct `OPENCODE_*` strings. Enumerated from the
/// artifact itself (`strings … | grep -oE 'OPENCODE_[A-Z_0-9]+' | sort -u`) and classified by how
/// each one is *read*, not by what its name suggests:
///
/// - **Read as a path, a file, a server or a credential — closed here.** These are the entries
///   below, and every one of them was measured by delivering it as an inherited variable and
///   reading the effect back. Each put something of the developer's own into this profile.
/// - **Read as a switch — left alone.** `OPENCODE_DISABLE_*`, `OPENCODE_ENABLE_*`,
///   `OPENCODE_EXPERIMENTAL*`, `OPENCODE_PURE`, `OPENCODE_LOG_LEVEL`, `OPENCODE_SHOW_TTFD` and
///   their neighbours change what the engine does, and *what they change is this profile's own
///   behaviour*, not whose configuration it reads. Closing a switch is a behaviour change nothing
///   can be measured against: a variable that does nothing is a variable whose closure nothing can
///   distinguish from a change of mind. `OPENCODE_DISABLE_PROJECT_CONFIG` is the one of these with a
///   consequence worth naming: measured, an inherited `1` takes a project's own provider out of the
///   model list, and that merge is the walk-up this app documents to the user and leaves on (§3.4
///   keeps the decision in `adapters/opencode.rs`'s `env_extra`, not here). The bucket also holds
///   the three names whose value is not a switch but an integration's address —
///   `OPENCODE_GIT_BASH_PATH`, `OPENCODE_EDITOR_SSE_PORT` and `OPENCODE_ZED_DB`, read by the
///   Windows-shell lookup and by the editor integrations. They are classified from how the engine
///   reads them rather than measured one by one, and this file says so rather than counting them
///   among the closed ones: measuring the rest of this bucket would be the blind sweep the
///   paragraph above argues against.
/// - **Read, and measured to change nothing here — the one the last commit singled out.**
///   `OPENCODE_PERMISSION` is parsed and merged into the configuration's `permission` member
///   (`Config.loadInstanceState`), so the plumbing exists and it was the first candidate for
///   *loosening this app's own gate*. Measured against the authority that decides that question —
///   the engine's own evaluation, the route its `edit` tool calls before it writes — an inherited
///   `{"edit":"allow","bash":"allow"}` left the effect `ask` with the shipped block in the
///   document, and the object form `{"edit":{"*":"deny"},"bash":{"*":"deny"}}` left it `allow`
///   against a document carrying no `permission` member at all: two shapes, both directions,
///   nothing. It is left alone for the rule above rather than for its name — a variable that
///   changes nothing is a variable whose closure no measurement could tell from a behaviour change.
/// - **Read only on a path this launch never takes.** `OPENCODE_TUI_CONFIG` names a file the TUI
///   reads; measured, a decoy provider written into it is not discovered by an `acp` launch, and no
///   `OPENCODE_*` read by the TUI's own module can be either. It is left alone for the same reason
///   as the switches: there is nothing here for its closure to protect.
/// - **Read only by work this launch does not do — named, not closed.** `OPENCODE_PLUGIN_META_FILE`
///   moves the file the engine records plugin metadata in, which otherwise lives inside the
///   profile's own state root. Measured: an inherited value naming a file in a scratch directory
///   left that file untouched through a whole `acp` launch, because this profile asks for no plugin
///   and the store is only touched when one loads. Closing it would mean spelling the engine's own
///   default from the outside, which is a guess dressed as a measurement — so it is named here
///   instead, and the day this profile loads a plugin the variable becomes a channel again.
/// - **Read as a credential that arrives by itself — one is left open and named.** Every session
///   the engine creates is uploaded to its share service when `OPENCODE_AUTO_SHARE` is set
///   (`SessionShare.create` reads the runtime flag and calls `SessionShare.share`), and that is a
///   consequence for the *user's* notes rather than for the profile's isolation. It is **not**
///   closed here because it could not be measured on this machine: making the engine share needs a
///   reachable share endpoint and an account, and the failure is swallowed (`Effect.ignore`), so a
///   test would report "closed" for a launch that had merely lost its network. Closing it would
///   therefore be the reflex this file exists to avoid; it is named here instead, with the call
///   that reads it, so the next reader can decide with the engine in front of them.
/// - **Not read from the environment at all — nothing to close.** Part of the count above is not
///   variables: `OPENCODE_SKILL_DESCRIPTION` is a substring of `CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION`
///   inside the text of a built-in skill, `OPENCODE__` is part of the `__OPENCODE__` property of a
///   TUI state object, `OPENCODE_PHOTON_WASM_PATH` is only ever the `globalThis.__OPENCODE_PHOTON_WASM_PATH`
///   property, `OPENCODE_GITLAB_AUTH_CLIENT_ID` is an export name, and `OPENCODE_PID` and
///   `OPENCODE_TERMINAL` are only ever *written* — the engine sets them for the processes it
///   spawns. A grep that counts names is a list of candidates, not of channels.
///
/// What follows is the closed set, each entry naming where it was measured.
pub fn isolated_profile_env(root: &Path) -> Vec<(String, String)> {
    let at = |name: &str| {
        (
            name.to_string(),
            root.join(name).to_string_lossy().into_owned(),
        )
    };
    vec![
        at("HOME"),
        at("XDG_CONFIG_HOME"),
        at("XDG_DATA_HOME"),
        at("XDG_CACHE_HOME"),
        // Where the engine's `locks/` directory lands (`<this>/opencode/locks/`). The name
        // promises a lock and the thing is not one, which matters here because this line is
        // what decides where it lands: each entry is a directory holding a `meta.json` (token,
        // pid, hostname) and an empty `heartbeat`, taken with no kernel lock and refused by
        // nobody. Two instances share one profile root, so they share this directory too —
        // measured in `two-instances-shared-state.md` §2, where two and at one point three
        // engines ran on one root with a marker present and a `SIGKILL`ed engine left one
        // behind with its dead pid. The only mutual exclusion between two engines is SQLite's
        // own, inside the database; nothing may be read out of this directory as protection.
        at("XDG_STATE_HOME"),
        // The first entry here that is not a root, and the only one that
        // could not be: see the doc comment. It is what stops the
        // engine's path-driven walk from reaching the user's real `.claude`
        // and `.agents` directories.
        (
            "OPENCODE_DISABLE_EXTERNAL_SKILLS".to_string(),
            "1".to_string(),
        ),
        // **The inherited environment, closed.** Each of these names somewhere
        // the engine would read configuration from, or write to, other than the
        // roots above — and each is read from the environment *in preference*
        // to what a root decides, so a developer who exported one reached this
        // profile through it.
        //
        // They come last, so nothing above can outrank them and
        // `AgentRegistration::env_extra` can still put one back deliberately —
        // `registry.rs` appends that vector after this one for exactly this
        // reason.
        //
        // **`OPENCODE_CONFIG_DIR` is a path here and not `""`, and that is the
        // one value arrived at by breaking something.** `""` closes the
        // inherited directory exactly as well, and it also costs the profile
        // its own permission rules: measured, the engine stops applying the
        // block this app ships in its configuration document, so
        // `agent_permission_grants_live_test`'s
        // `the_engines_own_evaluation_stops_silencing_after_the_revoke` goes
        // from `ask` to `allow` — the app's whole permission gate, off, with
        // the rest of the suite green. The document itself is *not* what is
        // lost: its provider is still discovered with `""` in place, measured
        // the same way every other discovery in this module was. So the effect
        // is on how the engine resolves permissions and the mechanism behind it
        // was not established — said that way because a guess would read as a
        // measurement, which is the failure this whole doc comment exists to
        // avoid.
        //
        // Pointing the variable at the directory the document already lives in
        // closes the inherited value *and* keeps the permission block, because
        // it names the root discovery would have chosen anyway. The path is
        // `profile::ENGINE_CONFIG_DOCUMENT`'s parent, spelled here rather than
        // imported so this module keeps knowing nothing about profiles — the
        // unit test at the foot of this file is what stops the two drifting
        // apart.
        (
            "OPENCODE_CONFIG_DIR".to_string(),
            root.join("XDG_CONFIG_HOME/opencode")
                .to_string_lossy()
                .into_owned(),
        ),
        // A file this host does not designate, and inline content it does not
        // carry: `""` is this engine's spelling for "not set" and `"{}"` is the
        // same statement where the value has to keep being valid JSON. Both
        // measured to close the inherited value without disturbing the
        // document.
        ("OPENCODE_CONFIG".to_string(), String::new()),
        ("OPENCODE_CONFIG_CONTENT".to_string(), "{}".to_string()),
        // The engine's session database. An inherited value put it at the
        // developer's own path, where this profile then read and wrote a
        // database that is not its own.
        ("OPENCODE_DB".to_string(), String::new()),
        // **The rest of the developer's own environment, measured the same way.** Each of the
        // following was delivered as an inherited variable against the pinned 1.18.29 and read
        // back off `session/new`'s model selector — no prompt and no credential, because a
        // provider is *discovered* whether or not its key works. The numbers are the whole model
        // list, so "8 → 24" is the statement that the developer's own account supplied 16 more of
        // it. `tests/agent_inherited_environment_test.rs` is these measurements, in both
        // directions.
        //
        // The credential the engine's own provider reads: an inherited one took the list from 8
        // models to 92, adding a second provider (`opencode-go`) that this profile has no other way
        // to offer. `""` is measured to be the same environment as an unset variable — the model
        // list comes back to 8 and the engine's `opencode` provider reports its own `"public"`
        // placeholder again.
        ("OPENCODE_API_KEY".to_string(), String::new()),
        // The engine's whole auth store, in one variable: `Auth.all` parses it in preference to
        // reading the profile's own file, so an inherited one decides which providers this profile
        // is authenticated to. Measured, one entry for `anthropic` took the list from 8 models to
        // 24, with no key of this app's anywhere in it. `""` is falsy to the same `if`, so the
        // engine falls back to the file it would otherwise have read.
        ("OPENCODE_AUTH_CONTENT".to_string(), String::new()),
        // The one variable that moves the engine's *home*, and therefore the one that reaches past
        // every root above: `Path.home` is `OPENCODE_TEST_HOME ?? os.homedir()`, and the
        // configuration walk reads `<home>/.opencode`. Measured: with the developer's own directory
        // there, a provider from its `.opencode/opencode.json` was in the model list while `HOME`
        // was pinned to this profile. The value here is `HOME`'s own value, so the engine resolves
        // the home it would have resolved anyway.
        (
            "OPENCODE_TEST_HOME".to_string(),
            root.join("HOME").to_string_lossy().into_owned(),
        ),
        // Where the model catalogue comes from. The file wins over the fetch and over the bundled
        // document: measured, an inherited pointer at a one-provider file replaced the whole list
        // with that provider's. The value here is the path the engine would have read anyway —
        // `<cache>/models.json`, which is what `Path.cache` names under `XDG_CACHE_HOME` above — so
        // an absent file falls through to the bundled catalogue exactly as it does with the
        // variable unset.
        (
            "OPENCODE_MODELS_PATH".to_string(),
            root.join("XDG_CACHE_HOME/opencode/models.json")
                .to_string_lossy()
                .into_owned(),
        ),
        // The other half of the same channel: the server the catalogue is *fetched* from.
        // Measured, an inherited URL pointed the engine at a loopback server and the model list
        // became that server's catalogue. `""` is falsy to the defaulting expression, so the engine
        // fetches from its own models.opencode.ai and names its cache file `models.json` again —
        // measured to be the same list as an unset variable.
        ("OPENCODE_MODELS_URL".to_string(), String::new()),
        // The engine's own HTTP surface, which this app reads with `permission_grants`. An
        // inherited password is what that surface answers to, so the app's own read is refused:
        // measured, `permission_grants::list` came back `401 Unauthorized` with an inherited value
        // in place and `Listed { grants: [] }` with `""`. `""` is falsy to the engine's own check,
        // so the surface is unsecured — which is the state this app already runs in, on a loopback
        // address and with no password of its own to offer.
        ("OPENCODE_SERVER_PASSWORD".to_string(), String::new()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The one thing two modules have to agree about.
    ///
    /// `isolated_profile_env` names `OPENCODE_CONFIG_DIR` by spelling the path, because this module
    /// knows nothing about profiles and importing the constant would be the wrong direction. That
    /// leaves one way for the two to drift, and the drift is not cosmetic: point the variable at a
    /// directory the document does not live in and the engine stops applying the permission block
    /// this app ships — the engine goes back to allowing an edit without asking anything. This test
    /// is the agreement, and it is the only place that says the two names are the same directory.
    #[test]
    fn the_configuration_directory_is_the_one_the_document_lives_in() {
        let root = Path::new("/tmp/nwk-profile");
        let configured = isolated_profile_env(root)
            .into_iter()
            .find(|(name, _)| name == "OPENCODE_CONFIG_DIR")
            .expect("an app-managed launch pins the engine's configuration directory")
            .1;
        let document = root.join(crate::agent_runtime::profile::ENGINE_CONFIG_DOCUMENT);
        assert_eq!(
            Path::new(&configured),
            document.parent().expect("the document has a parent"),
            "OPENCODE_CONFIG_DIR must name the directory the profile's configuration document \
             lives in, or the engine reads a different configuration and the permission block \
             this app ships stops being applied"
        );
    }

    /// Every path this launch pins stays inside the profile it was built for.
    ///
    /// The measurements behind these entries are about *where* a variable points the engine, so a
    /// value that pointed somewhere else would be a leak with the same shape as the one it closes.
    /// This is asserted for the values that are paths; the ones that are empty or a switch are the
    /// engine's own spelling of "not set" and are not paths at all.
    #[test]
    fn every_pinned_path_is_inside_the_profile_root() {
        let root = PathBuf::from("/tmp/nwk-profile");
        let environment = isolated_profile_env(&root);
        // The engine's own variables whose value is a path this launch chooses, and the profile
        // member each one is the engine's own default for.
        let expected = [
            ("HOME", "HOME"),
            ("XDG_CONFIG_HOME", "XDG_CONFIG_HOME"),
            ("XDG_DATA_HOME", "XDG_DATA_HOME"),
            ("XDG_CACHE_HOME", "XDG_CACHE_HOME"),
            ("XDG_STATE_HOME", "XDG_STATE_HOME"),
            ("OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME/opencode"),
            ("OPENCODE_TEST_HOME", "HOME"),
            (
                "OPENCODE_MODELS_PATH",
                "XDG_CACHE_HOME/opencode/models.json",
            ),
        ];
        for (name, member) in expected {
            let value = environment
                .iter()
                .find(|(entry, _)| entry == name)
                .unwrap_or_else(|| panic!("{name} is part of this launch: {environment:?}"))
                .1
                .clone();
            assert_eq!(
                Path::new(&value),
                root.join(member),
                "{name} must point inside the profile root, at the member the engine would have \
                 resolved for itself"
            );
        }
    }

    /// No variable is named twice, which is the one way a later entry could silently lose.
    ///
    /// The launch description is collected into a map, so a second entry for one name is not an
    /// error anywhere — it is the last one that wins, and a reader looking at the first would see a
    /// value the engine never carried.
    #[test]
    fn no_variable_is_named_twice() {
        let environment = isolated_profile_env(Path::new("/tmp/nwk-profile"));
        let mut names: Vec<&str> = environment.iter().map(|(name, _)| name.as_str()).collect();
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(
            names.len(),
            count,
            "a name appears twice in the launch environment, and only the last one reaches the \
             engine"
        );
    }
}
