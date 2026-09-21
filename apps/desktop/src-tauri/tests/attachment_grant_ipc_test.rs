//! The image import's grant, at the IPC boundary.
//!
//! Finding S4 in `docs/audits/2026-09-21-code-review.md`: `import_attachment` took a `source_path`
//! from the renderer and copied it into the vault, filtering only on the *extension* — so any window
//! that could invoke it could name a file of its own choosing, have the bytes copied in, and read
//! them back through `resolve_media_path`'s asset grant. The source path is legitimately outside the
//! vault (a picker exists so a file can come from anywhere), so the fix is not confinement but
//! authorisation: only a path the user's own image dialog returned may be imported, and once.
//!
//! **What is driven and what is not.** The command is invoked over real IPC — Tauri's own argument
//! parser and its state lookup — so what these cases assert is the rule the boundary enforces. The
//! dialog itself cannot be driven (a native picker needs a display and a user), so the grant is
//! minted through the same managed state the dialog mints into; `PickedImages::mint` is the one call
//! these cases do not share with production, and `picked.rs`'s own unit tests cover it.
//!
//! The scratch lives under `target/`, so a killed run leaves nothing outside the tree.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

// The crate roots the included command module reaches for: `commands/fs/media.rs` and `watch.rs`
// spell their helpers as `crate::domain::…`, so this target has to re-export the same three roots
// `save_precondition_ipc_test.rs` does — the path-included tree is compiled into *this* crate.
pub use nekowite_lib::{domain, state, storage};
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::Manager;

// Compile the real command module so the generated IPC argument parser and the `tauri::State`
// lookups are the ones under test rather than a shim around them.
#[allow(dead_code)]
#[path = "../src/commands/fs.rs"]
mod fs_commands;

// The included copy's own type: `tauri::State` is looked up by `TypeId`, so the instance managed
// below has to be the one the compiled-in command asks for.
use fs_commands::PickedImages;

/// A vault, one image the user will "pick", and one they never see.
struct Scratch {
    root: PathBuf,
    vault: PathBuf,
    chosen: PathBuf,
    never_chosen: PathBuf,
}

impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!(
                "attachment-grant-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        let vault = root.join("vault");
        std::fs::create_dir_all(vault.join("notes")).unwrap();
        let chosen = root.join("chosen.png");
        std::fs::write(&chosen, b"the file the user picked").unwrap();
        let never_chosen = root.join("never-chosen.png");
        std::fs::write(&never_chosen, b"a file the user never saw").unwrap();
        Self {
            root,
            vault,
            chosen,
            never_chosen,
        }
    }

    /// Where the import would land, so a refusal can be checked for having copied nothing.
    fn destination(&self, name: &str) -> PathBuf {
        self.vault.join("notes/a_assets").join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn app(scratch: &Scratch) -> tauri::App<MockRuntime> {
    let registry = state::VaultRegistry::default();
    registry
        .register(scratch.vault.to_str().unwrap(), Some(&scratch.vault))
        .unwrap();
    mock_builder()
        .manage(registry)
        .manage(PickedImages::default())
        .invoke_handler(tauri::generate_handler![fs_commands::import_attachment])
        .build(tauri::generate_context!())
        .unwrap()
}

fn call(
    window: &tauri::WebviewWindow<MockRuntime>,
    cmd: &str,
    body: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize().unwrap())
}

/// One `import_attachment` invoke, as the frontend sends it.
fn import(
    window: &tauri::WebviewWindow<MockRuntime>,
    scratch: &Scratch,
    source: &Path,
) -> Result<Value, Value> {
    call(
        window,
        "import_attachment",
        json!({
            "vault": scratch.vault.to_str().unwrap(),
            "source_path": source.to_str().unwrap(),
            "dir": "notes/a_assets",
        }),
    )
}

fn window(app: &tauri::App<MockRuntime>) -> tauri::WebviewWindow<MockRuntime> {
    tauri::WebviewWindowBuilder::new(app, "main", Default::default())
        .build()
        .unwrap()
}

#[test]
fn an_image_the_user_did_not_pick_is_refused_and_copies_nothing() {
    let scratch = Scratch::new();
    let app = app(&scratch);
    let window = window(&app);

    let refused = import(&window, &scratch, &scratch.never_chosen)
        .expect_err("a path the dialog never returned must not be importable");
    let sentence = refused.as_str().unwrap_or_default();
    assert!(
        sentence.contains("did not pick"),
        "the refusal has to say what is wrong, not only that something is: {sentence}"
    );
    assert!(
        !scratch.destination("never-chosen.png").exists(),
        "the refusal must happen before the copy, not after it"
    );
    assert!(
        !scratch.vault.join("notes/a_assets").exists(),
        "nothing may be created for a refused import"
    );
}

#[test]
fn an_image_the_user_picked_is_imported_once() {
    let scratch = Scratch::new();
    let app = app(&scratch);
    let window = window(&app);
    app.state::<PickedImages>().mint([scratch.chosen.clone()]);

    let imported = import(&window, &scratch, &scratch.chosen).expect("a picked image imports");
    assert_eq!(imported.as_str(), Some("notes/a_assets/chosen.png"));
    assert_eq!(
        std::fs::read(scratch.destination("chosen.png")).unwrap(),
        b"the file the user picked"
    );
    // The original stays where the user had it.
    assert_eq!(
        std::fs::read(&scratch.chosen).unwrap(),
        b"the file the user picked"
    );

    // A second call is a replay of a path the renderer learned, not a use of a pick.
    let replayed = import(&window, &scratch, &scratch.chosen)
        .expect_err("the grant is spent by the import it authorised");
    assert!(
        replayed
            .as_str()
            .unwrap_or_default()
            .contains("did not pick"),
        "{replayed}"
    );
    assert!(
        !scratch.destination("chosen-1.png").exists(),
        "the replay must not have produced a second copy"
    );
}

#[test]
fn the_same_file_by_another_spelling_is_the_same_grant() {
    let scratch = Scratch::new();
    let app = app(&scratch);
    let window = window(&app);
    app.state::<PickedImages>().mint([scratch.chosen.clone()]);

    // `root/../<name>/chosen.png` — one file, two spellings. A string comparison would refuse the
    // second, which is how a legitimate import breaks; both sides are canonicalised instead.
    let round_about = scratch
        .root
        .join("..")
        .join(scratch.root.file_name().unwrap())
        .join("chosen.png");
    assert_ne!(round_about, scratch.chosen, "the spellings have to differ");
    let imported = import(&window, &scratch, &round_about).expect("the same file imports once");
    assert_eq!(imported.as_str(), Some("notes/a_assets/chosen.png"));
}

#[test]
fn a_refusal_does_not_spend_another_paths_grant() {
    let scratch = Scratch::new();
    let app = app(&scratch);
    let window = window(&app);
    app.state::<PickedImages>().mint([scratch.chosen.clone()]);

    assert!(import(&window, &scratch, &scratch.never_chosen).is_err());
    let imported = import(&window, &scratch, &scratch.chosen)
        .expect("the picked path is still importable after a refused one");
    assert_eq!(imported.as_str(), Some("notes/a_assets/chosen.png"));
}
