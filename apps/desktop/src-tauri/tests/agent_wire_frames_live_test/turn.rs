//! One turn end to end: the folder it runs against, the session it opens, the prompt it sends, and
//! the frames that arrived while it ran.
//!
//! `one_turn` is the only entry the paying cases use. It takes the live-run lock before it touches
//! the engine, plants the folder, starts the engine behind the wrapper, installs the servant, and
//! hands the read frames to the transcript reader. The prompt is an argument rather than a constant
//! because the two paying cases ask for two different ordinary things.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use agent_client_protocol::schema::v1::{ContentBlock, SessionId, SessionUpdate, TextContent};
use nekowite_lib::agent_runtime::{client_capabilities, FsRequest, PermissionRequest};

use crate::frames::collect;
use crate::harness::{
    live_run_inputs, one_turn_at_a_time, scratch, servant, start, unused, Live, CALL_BOUND,
    RUN_PATIENCE, TEST_MODEL,
};
use crate::transcript::report;

/// The turn a session's frames are read from: one prompt, answered.
///
/// The request is sent on a task of its own while this one reads, because the answer arrives as
/// notifications on the same connection and a single task cannot await both — the same split the
/// replay target's collector makes, and the same one `driver::install` makes in the app.
async fn take_one_turn(
    live: &mut Live,
    workspace: &Path,
    prompt: &str,
) -> (Vec<SessionUpdate>, BTreeMap<&'static str, usize>) {
    let opened = live
        .connection
        .new_session(workspace, CALL_BOUND)
        .await
        .expect("session/new against the real engine");
    let session: SessionId = opened.session_id.clone();
    eprintln!("session {session}");

    let options = serde_json::to_value(&opened.config_options).expect("options serialize");
    assert!(
        options
            .as_array()
            .is_some_and(|options| options.iter().any(|option| option["id"] == "model")),
        "the engine returned no `model` option, which every other live target relies on: {options}"
    );
    live.connection
        .set_config_option(
            session.clone(),
            "model".to_string(),
            TEST_MODEL.to_string(),
            CALL_BOUND,
        )
        .await
        .expect("the engine accepts the model this probe is configured for");

    let asking = {
        let connection = Arc::clone(&live.connection);
        let prompt = prompt.to_string();
        tokio::spawn(async move {
            connection
                .prompt(
                    session,
                    vec![ContentBlock::Text(TextContent::new(prompt))],
                    RUN_PATIENCE,
                )
                .await
        })
    };

    let (frames, counts) = collect(&mut live.updates, RUN_PATIENCE).await;
    // The prompt's own answer is the turn's end, and it is read *after* the clock rather than
    // before it: the stream does not close when the turn does, so the ending is the fact that
    // says the turn was over rather than a race with a reader.
    let ending = asking.await.expect("the asking task should not panic");
    eprintln!("--- the turn answered {ending:?}");
    (frames, counts)
}

/// Writes a folder with something in it, so "read this folder" is a real request rather than a
/// trick. `deep` adds nested files, which is what a search prompt needs to be worth searching.
fn workspace(root: &Path, deep: bool) -> PathBuf {
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).expect("workspace");
    let mut files: Vec<(String, String)> = vec![
        (
            "README.md".to_string(),
            "# Sample\n\nA small folder used as a workspace.\n".to_string(),
        ),
        (
            "notes.md".to_string(),
            "# Notes\n\nThe project has three parts.\n".to_string(),
        ),
        (
            "config.json".to_string(),
            "{\n  \"retries\": 3,\n  \"timeout\": 30\n}\n".to_string(),
        ),
        (
            "src/main.rs".to_string(),
            "fn main() {\n    println!(\"retry policy: 3 attempts\");\n}\n".to_string(),
        ),
        (
            "src/lib.rs".to_string(),
            "pub fn retries() -> u32 {\n    3\n}\n".to_string(),
        ),
    ];
    if deep {
        for (index, area) in ["client", "server", "shared", "tools"].iter().enumerate() {
            for module in 0..4 {
                files.push((
                    format!("crates/{area}/src/module{module}.rs"),
                    format!(
                        "//! {area} module {module}.\n\npub const TIMEOUT_MS: u64 = {};\n\n\
                         pub fn describe() -> &'static str {{\n    \"{area} {module}\"\n}}\n",
                        (index + 1) * (module + 1) * 1000
                    ),
                ));
            }
            files.push((
                format!("crates/{area}/tests/basic.rs"),
                format!("#[test]\nfn {area}_answers() {{\n    assert!(true);\n}}\n"),
            ));
        }
    }
    for (name, body) in files {
        let path = workspace.join(&name);
        fs::create_dir_all(path.parent().unwrap()).expect("workspace dirs");
        fs::write(&path, body).expect("workspace file");
    }
    workspace
}

/// What one turn produced, or `None` when the inputs were absent and the test skipped.
pub struct Turn {
    pub tool_frames: Vec<String>,
    pub counts: BTreeMap<&'static str, usize>,
}

/// One whole turn: start the engine, plant the folder, ask, log every frame.
pub async fn one_turn(label: &str, deep: bool, prompt: &str) -> Option<Turn> {
    let _one_at_a_time = one_turn_at_a_time().lock().await;
    // `live_run_inputs` has already printed the SKIP line, so a `None` here is a skipped run and
    // never an assertion about a turn that did not happen.
    let (artifact, key) = live_run_inputs()?;
    let root = scratch(label);
    let workspace = workspace(&root, deep);

    let mut live = start(&artifact, &key, &root).await;
    let _servant = servant(
        std::mem::replace(&mut live.permissions, unused::<PermissionRequest>()),
        std::mem::replace(&mut live.fs, unused::<FsRequest>()),
    );
    live.connection
        .initialize(CALL_BOUND)
        .await
        .expect("the engine initializes");
    eprintln!(
        "the host advertises: {}",
        serde_json::to_value(client_capabilities()).expect("capabilities serialize")
    );

    eprintln!("prompt: {prompt:?}");
    let (frames, counts) = take_one_turn(&mut live, &workspace, prompt).await;
    let tool_frames = report(&live.wire, &frames, &counts);
    live.connection.shutdown();
    Some(Turn {
        tool_frames,
        counts,
    })
}
