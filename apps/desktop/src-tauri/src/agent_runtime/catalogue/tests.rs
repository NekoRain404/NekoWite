//! The catalogue's unit tests: the schema's own example entry, the four standings, the defects a
//! row keeps, and the two lists that must not fall behind another file's (`InstallGate::ALL`, and
//! the id charset [`super::manifest::Entry::registration_id`]'s claim rests on).
//!
//! They are a module of their own because the file they test stood at 1174 lines, over the budget
//! `docs/dev.md:286` puts on a business source file, and because a test changes for its own reason:
//! when the behaviour it pins does — a new standing, a new refusal, a changed list — and not when
//! the code above it is rearranged. `use super::*` is deliberate: these tests read the same surface
//! a caller outside the module does, so a name that stopped being re-exported would fail here
//! rather than pass against a path only the tests know.
use std::collections::BTreeMap;

use super::*;
// `is_registry_id` is a schema pattern rather than a surface: it moved to `refusal.rs` with the
// refusals it decides, and it is named through the path it now lives at instead of being re-exported
// from the module root for a test's sake.
use super::refusal::is_registry_id;

/// An entry shaped exactly like the schema's own example, so the parser is exercised against
/// the document it will actually meet rather than against a convenient one.
fn document(agents: &str) -> String {
    format!(r#"{{"version":"1.0.0","agents":[{agents}]}}"#)
}

fn full_entry() -> &'static str {
    r#"{
            "id": "someagent",
            "name": "SomeAgent",
            "version": "1.0.0",
            "description": "Agent for code editing",
            "repository": "https://github.com/example/someagent",
            "authors": ["Example Team"],
            "license": "MIT",
            "license_url": "https://github.com/example/someagent/blob/main/LICENSE",
            "icon": "icon.svg",
            "distribution": {
              "npx": { "package": "@acme/ai-agent", "args": ["--acp"], "env": {"AGENT_MODE": "production"} },
              "binary": {
                "linux-x86_64": {
                  "archive": "https://example.com/someagent-linux-x64.tar.gz",
                  "cmd": "./someagent",
                  "args": ["acp"],
                  "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
                }
              }
            }
        }"#
}

#[test]
fn the_schema_s_example_entry_parses_field_for_field() {
    let catalogue = parse(document(full_entry()).as_bytes()).expect("the example is valid");
    assert_eq!(catalogue.version, "1.0.0");
    let row = catalogue.row("someagent").expect("the entry is there");
    assert!(row.is_offerable(), "no defects: {:?}", row.defects);
    assert_eq!(row.entry.name, "SomeAgent");
    assert_eq!(row.entry.version, "1.0.0");
    assert_eq!(row.entry.authors, vec!["Example Team".to_string()]);
    assert_eq!(row.entry.license.as_deref(), Some("MIT"));
    assert_eq!(
            row.entry.icon_url().as_deref(),
            Some(
                "https://raw.githubusercontent.com/agentclientprotocol/registry/main/someagent/icon.svg"
            )
        );
    // Both distributions survive parsing. Zed's parser has no `uvx` field at all
    // (`agent_registry_store.rs:658-664`), which is the difference this module keeps.
    assert!(row.entry.distribution.npx.is_some());
    assert_eq!(row.entry.distribution.binary.len(), 1);
}

#[test]
fn a_uvx_entry_is_read_rather_than_dropped() {
    // The kind Zed cannot represent. A `uvx`-only entry is one its builder skips
    // (`agent_registry_store.rs:445-456`), so this is the case that proves the schema is being
    // read rather than a client's subset of it.
    let entry = r#"{
            "id": "pyagent", "name": "PyAgent", "version": "2.0.0", "description": "d",
            "license_url": "https://example.com/l",
            "distribution": { "uvx": { "package": "pyagent", "args": ["serve", "--acp"] } }
        }"#;
    let catalogue = parse(document(entry).as_bytes()).expect("valid");
    let row = catalogue.row("pyagent").expect("kept, not dropped");
    assert_eq!(
        row.standing,
        Standing::ViaPackageManager {
            manager: PackageManager::Uvx,
            package: "pyagent".to_string(),
            args: vec!["serve".to_string(), "--acp".to_string()],
        }
    );
}

#[test]
fn a_package_distribution_is_preferred_over_an_archive() {
    // Both kinds published, and the choice is the trust one: the manager owns provenance,
    // an archive would make this app the downloader.
    let catalogue = parse(document(full_entry()).as_bytes()).expect("valid");
    let row = catalogue.row("someagent").expect("present");
    match &row.standing {
        Standing::ViaPackageManager {
            manager, package, ..
        } => {
            assert_eq!(*manager, PackageManager::Npx);
            assert_eq!(package, "@acme/ai-agent");
        }
        other => panic!("expected the package arm, got {other:?}"),
    }
    // And the invocation is an array, never a command line (§3.4.3).
    assert_eq!(
        row.entry.package_invocation(),
        Some((
            PackageManager::Npx,
            vec!["@acme/ai-agent".to_string(), "--acp".to_string()]
        ))
    );
}

#[test]
fn an_archive_only_entry_is_named_as_the_decision_it_is() {
    // No package distribution, so using it would make NekoWite the downloader. The standing
    // says so rather than offering an action.
    let entry = r#"{
            "id": "binaryonly", "name": "BinaryOnly", "version": "1.0.0", "description": "d",
            "license_url": "https://example.com/l",
            "distribution": { "binary": {
                "linux-x86_64": { "archive": "https://example.com/a.tar.gz", "cmd": "./a" }
            } }
        }"#;
    let catalogue = parse(document(entry).as_bytes()).expect("valid");
    let row = catalogue.row("binaryonly").expect("present");
    assert_eq!(
        row.standing,
        Standing::ArchiveOnly {
            platform: Platform::LinuxX86_64,
            cmd: "./a".to_string(),
        }
    );
    assert_eq!(row.entry.package_invocation(), None);
}

#[test]
fn a_row_no_action_could_be_taken_on_is_not_offerable() {
    // The rule 「不能让按钮看起来可用、点击后才发现不支持」, as a property rather than a habit.
    // All four arm shapes, and only the package-manager one is something this host can do
    // today — the other three each need this app to obtain the artifact itself, under a trust
    // chain §3.3 does not let it have.
    let via_manager = Standing::ViaPackageManager {
        manager: PackageManager::Npx,
        package: "p".to_string(),
        args: Vec::new(),
    };
    let archive_only = Standing::ArchiveOnly {
        platform: Platform::LinuxX86_64,
        cmd: "./a".to_string(),
    };
    let unsupported = Standing::Unsupported {
        published: vec![Platform::DarwinAarch64],
    };
    let unrecognised = Standing::Unrecognised {
        kinds: vec!["docker".to_string()],
    };
    assert!(via_manager.is_actionable());
    assert!(!archive_only.is_actionable());
    assert!(!unsupported.is_actionable());
    assert!(!unrecognised.is_actionable());

    // And the same four through a whole document, so the property holds on the path a page
    // actually reads rather than only on values a test built by hand.
    let entries = [
        r#"{"id":"mgr","name":"n","version":"1.0.0","description":"d",
                "license_url":"https://e.com/l","distribution":{"npx":{"package":"p"}}}"#,
        r#"{"id":"arc","name":"n","version":"1.0.0","description":"d",
                "license_url":"https://e.com/l","distribution":{"binary":{
                  "linux-x86_64":{"archive":"https://e.com/a.tar.gz","cmd":"./a"}}}}"#,
        r#"{"id":"mac","name":"n","version":"1.0.0","description":"d",
                "license_url":"https://e.com/l","distribution":{"binary":{
                  "darwin-aarch64":{"archive":"https://e.com/a.zip","cmd":"./a"}}}}"#,
        r#"{"id":"odd","name":"n","version":"1.0.0","description":"d",
                "license_url":"https://e.com/l","distribution":{"docker":{"image":"x"}}}"#,
    ];
    let catalogue = parse(document(&entries.join(",")).as_bytes()).expect("valid");
    assert_eq!(catalogue.rows.len(), 4, "every row is kept, none dropped");
    // None of the four has a defect: each published what the schema asks for. The difference
    // is entirely whether this host can act, which is what being offerable turns on.
    assert!(
        catalogue.rows.iter().all(|row| row.defects.is_empty()),
        "defects are a separate question from actionability"
    );
    assert_eq!(catalogue.offerable(), 1);
    assert!(catalogue.row("mgr").expect("present").is_offerable());
    for id in ["arc", "mac", "odd"] {
        assert!(
            !catalogue.row(id).expect("present").is_offerable(),
            "{id} must not be offered"
        );
    }
}

#[test]
fn an_entry_for_other_machines_reports_what_it_publishes() {
    let entry = r#"{
            "id": "maconly", "name": "MacOnly", "version": "1.0.0", "description": "d",
            "license_url": "https://example.com/l",
            "distribution": { "binary": {
                "darwin-aarch64": { "archive": "https://example.com/a.zip", "cmd": "./a" }
            } }
        }"#;
    let catalogue = parse(document(entry).as_bytes()).expect("valid");
    let row = catalogue.row("maconly").expect("present");
    match &row.standing {
        Standing::Unsupported { published } => {
            assert_eq!(published, &vec![Platform::DarwinAarch64]);
        }
        other => panic!("expected the unsupported arm, got {other:?}"),
    }
}

#[test]
fn a_distribution_kind_the_schema_does_not_define_is_reported_not_fatal() {
    // A future distribution kind must make one row say what it could not read, rather than
    // failing the whole catalogue or silently offering a row with no distribution at all.
    let entry = r#"{
            "id": "futuristic", "name": "Future", "version": "1.0.0", "description": "d",
            "license_url": "https://example.com/l",
            "distribution": { "docker": { "image": "example/agent" } }
        }"#;
    let catalogue = parse(document(entry).as_bytes()).expect("one unknown kind is not fatal");
    let row = catalogue.row("futuristic").expect("present");
    assert_eq!(
        row.standing,
        Standing::Unrecognised {
            kinds: vec!["docker".to_string()]
        }
    );
    // And the *other* entries still parsed: the point of not failing the document.
    let both = parse(document(&format!("{entry},{}", full_entry())).as_bytes()).expect("valid");
    assert_eq!(both.rows.len(), 2);
    assert_eq!(both.offerable(), 1);
}

#[test]
fn the_schema_s_required_fields_are_required() {
    // Each defect is found and the row survives with it, which is the shape a page needs:
    // a row that says what is wrong rather than an entry that vanished.
    let cases: [(&str, EntryDefect); 4] = [
        (
            r#"{"id":"Bad_Id","name":"n","version":"1.0.0","description":"d",
                    "license_url":"https://e.com/l","distribution":{"npx":{"package":"p"}}}"#,
            EntryDefect::Id {
                value: "Bad_Id".to_string(),
            },
        ),
        (
            r#"{"id":"ok","name":"n","version":"1.0","description":"d",
                    "license_url":"https://e.com/l","distribution":{"npx":{"package":"p"}}}"#,
            EntryDefect::Version {
                value: "1.0".to_string(),
            },
        ),
        (
            r#"{"id":"ok","name":"n","version":"1.0.0","description":"d",
                    "license_url":"https://e.com/l","distribution":{}}"#,
            EntryDefect::NoDistribution,
        ),
        (
            r#"{"id":"ok","name":"n","version":"1.0.0","description":"d",
                    "distribution":{"npx":{"package":"p"}}}"#,
            EntryDefect::NoLicenseUrl,
        ),
    ];
    for (entry, expected) in cases {
        let catalogue = parse(document(entry).as_bytes()).expect("the document still parses");
        let row = &catalogue.rows[0];
        assert_eq!(row.defects, vec![expected.clone()], "{entry}");
        assert!(!row.is_offerable(), "{entry}");
    }
}

#[test]
fn the_licence_url_carve_out_is_the_schema_s_own() {
    // `agent.schema.json:8-16` exempts exactly one id. Worth its own test: an exemption read
    // as "the field is optional" would be a row that offers an engine with no terms to read.
    let exempt = r#"{"id":"dimcode","name":"n","version":"1.0.0","description":"d",
            "distribution":{"npx":{"package":"p"}}}"#;
    let catalogue = parse(document(exempt).as_bytes()).expect("valid");
    assert!(catalogue.rows[0].is_offerable());
    assert!(catalogue.rows[0].entry.license_url.is_none());
}

#[test]
fn an_installer_format_is_not_an_archive() {
    // The schema names the archive formats and refuses installer formats, so a `.deb` is a
    // document this build does not act on rather than a file it would try to extract.
    let entry = r#"{
            "id": "debs", "name": "Debs", "version": "1.0.0", "description": "d",
            "license_url": "https://example.com/l",
            "distribution": { "binary": {
                "linux-x86_64": { "archive": "https://example.com/a.deb", "cmd": "./a" }
            } }
        }"#;
    let catalogue = parse(document(entry).as_bytes()).expect("valid");
    let row = catalogue.row("debs").expect("present");
    assert_eq!(row.defects.len(), 1);
    assert!(matches!(row.defects[0], EntryDefect::Archive { .. }));
}

#[test]
fn a_newer_schema_major_is_refused_rather_than_parsed() {
    // The one thing a catalogue must not do: read a shape it has not read before and present
    // the result as though the fields meant what this build thinks they mean.
    let error = parse(br#"{"version":"2.0.0","agents":[]}"#).expect_err("refused");
    assert_eq!(
        error,
        DocumentError::UnsupportedVersion {
            value: "2.0.0".to_string(),
            supported: SUPPORTED_REGISTRY_MAJOR,
        }
    );
    assert!(parse(br#"{"agents":[]}"#).is_err(), "no version at all");
    assert!(parse(b"not json").is_err());
}

#[test]
fn a_package_that_pins_no_version_says_so() {
    // The schema permits an unpinned package, so a row cannot state a version the artifact
    // has not promised. `@scope/name` and `@scope/name@latest` both pin nothing, and the
    // scope's own `@` is not a separator.
    let unpinned = Package {
        package: "@acme/ai-agent".to_string(),
        args: Vec::new(),
        env: BTreeMap::new(),
    };
    assert_eq!(unpinned.pinned_version(), None);
    let latest = Package {
        package: "@acme/ai-agent@latest".to_string(),
        args: Vec::new(),
        env: BTreeMap::new(),
    };
    assert_eq!(latest.pinned_version(), None);
    let pinned = Package {
        package: "@acme/ai-agent@1.2.3".to_string(),
        args: Vec::new(),
        env: BTreeMap::new(),
    };
    assert_eq!(pinned.pinned_version(), Some("1.2.3"));
    let bare = Package {
        package: "uvx-agent@0.8.65".to_string(),
        args: Vec::new(),
        env: BTreeMap::new(),
    };
    assert_eq!(bare.pinned_version(), Some("0.8.65"));
}

#[test]
fn the_install_gate_names_what_does_not_transfer() {
    // The module's answer to "why is there no Install button", as a value. `Digest` is the
    // arm that decides it: §3.3 forbids a response supplying both halves of its own proof, and
    // a registry entry's `sha256` arrives in the same document as its `archive` URL
    // (`update.rs:6-9`, `:160-170`).
    assert!(!InstallGate::Digest.transfers());
    assert!(!InstallGate::Version.transfers());
    assert!(!InstallGate::ContractTests.transfers());
    assert!(InstallGate::Architecture.transfers());
    assert!(InstallGate::ExecuteBit.transfers());
    assert!(InstallGate::AcpInitialization.transfers());
    // Every check `update.rs`'s gate runs has a counterpart here, so this list cannot fall
    // behind that one without failing to exist.
    let named: Vec<&str> = InstallGate::ALL
        .into_iter()
        .map(InstallGate::as_str)
        .collect();
    assert_eq!(
        named,
        vec![
            "digest",
            "architecture",
            "execute-permission",
            "version",
            "acp-initialization",
            "contract-tests"
        ]
    );
    // And the arms named the way `update.rs` names its own (`Check::as_str`), so a reader can
    // hold the two lists against each other.
    assert_eq!(InstallGate::ExecuteBit.as_str(), "execute-permission");
}

#[test]
fn the_registry_id_charset_is_narrower_than_this_app_s() {
    // The claim `Entry::registration_id` rests on: every id the schema allows is one this
    // app's `validate_id` accepts, so mapping one to a registration needs no translation.
    for id in ["opencode", "claude-acp", "qwen-code", "a", "a1-b2"] {
        assert!(is_registry_id(id), "{id} should be a registry id");
    }
    for id in ["Opencode", "1agent", "-agent", "agent_1", "agent.x", ""] {
        assert!(!is_registry_id(id), "{id} should not be a registry id");
    }
}
