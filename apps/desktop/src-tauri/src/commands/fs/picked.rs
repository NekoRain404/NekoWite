//! The images this session's picker has handed back, and the one rule that makes an import
//! legitimate: **`import_attachment` may copy a path the user's own dialog returned, and nothing
//! else.**
//!
//! Finding S4 in `docs/audits/2026-09-21-code-review.md`. `import_attachment` took a `source_path`
//! from the renderer and passed it to the store, whose only filter is the *extension* — so any
//! window that could invoke it could ask for `/home/user/Pictures/anything.png`, have the bytes
//! copied into the vault, and then read them back through `resolve_media_path`'s `asset://` grant.
//! The source path is deliberately outside the vault (the whole point of a picker is that the file
//! lives anywhere), so confining it was never the answer; binding it to the user's own choice is.
//!
//! **A set of paths and not a token in the payload.** The review suggested minting a one-shot token
//! in `pick_image_files` and requiring it in `import_attachment`, "without costing the IPC hop the
//! comment is protecting". This does the same thing with one fewer spelling: the renderer already
//! *receives* the picked paths, so the honest question at import time is "is this one of them?" —
//! and a token beside each path would be a second field saying what the path already said, changed
//! in the Rust command, the TypeScript port, both in-memory gateways and every e2e spec that queues
//! a pick. Nothing in this module is a capability the *frontend* can mint: only the native dialog
//! calls [`PickedImages::mint`].
//!
//! **Why one-shot, and why a bound.** An import is the only use a picked path has, so a grant is
//! spent by it: a second call is a renderer replaying a path it learned earlier, and a user whose
//! import failed has the picker one click away. The bound exists for the same reason in the other
//! direction — a grant is not a permanent capability handed to a page, it is "import this, now" —
//! and it is generous because the gap it covers is a person reading a dialog.
//!
//! **Canonicalisation on both sides.** The dialog's path and the renderer's copy of it can differ
//! by a symlink, a `.` or a `..`, and comparing the strings would either refuse a legitimate import
//! or accept a forged one. Both sides are resolved, and a path that cannot be resolved (the file
//! moved or was deleted between the pick and the import) is refused rather than compared as text.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a picked path stays importable.
pub const PICK_BOUND: Duration = Duration::from_secs(600);

/// The images a native picker has handed back this session.
///
/// `Default` and managed state, like `VaultRegistry`: the app has one of these, `lib.rs` calls
/// `manage` once, and a command reaches it through `tauri::State`.
#[derive(Default)]
pub struct PickedImages {
    picked: Mutex<HashMap<PathBuf, Instant>>,
}

impl PickedImages {
    /// Record the paths the user just chose.
    ///
    /// The caller is the native dialog and nobody else (see the module doc). A path that cannot be
    /// canonicalised is skipped rather than recorded as given: it cannot be imported either, and
    /// recording it would make the refusal at import time look like a granting bug.
    pub fn mint(&self, paths: impl IntoIterator<Item = PathBuf>) {
        let Ok(mut picked) = self.picked.lock() else {
            // A poisoned grant table refuses everything rather than granting anything: the two
            // directions are not symmetric, and this is the one that fails closed.
            return;
        };
        let now = Instant::now();
        picked.retain(|_, minted| now.duration_since(*minted) < PICK_BOUND);
        for path in paths {
            if let Ok(resolved) = path.canonicalize() {
                picked.insert(resolved, now);
            }
        }
    }

    /// Spend the grant for one path, answering whether there was a live one.
    ///
    /// `false` covers all three ways this can be refused — never picked, already imported, or
    /// picked longer ago than [`PICK_BOUND`] — because the caller's answer is one sentence either
    /// way: choose it again. A poisoned lock is also `false`.
    pub fn release(&self, path: &Path) -> bool {
        let Ok(resolved) = path.canonicalize() else {
            return false;
        };
        let Ok(mut picked) = self.picked.lock() else {
            return false;
        };
        let now = Instant::now();
        picked.retain(|_, minted| now.duration_since(*minted) < PICK_BOUND);
        picked.remove(&resolved).is_some()
    }

    /// How many grants are live, for a test that has to see one spent.
    #[cfg(test)]
    pub(crate) fn live(&self) -> usize {
        self.picked.lock().map(|picked| picked.len()).unwrap_or(0)
    }

    /// Record a grant as if it had been minted `age` ago, so the bound is testable without waiting
    /// ten minutes.
    #[cfg(test)]
    pub(crate) fn mint_ago(&self, path: &Path, age: Duration) {
        let Ok(mut picked) = self.picked.lock() else {
            return;
        };
        picked.insert(
            path.canonicalize().expect("the fixture file exists"),
            Instant::now() - age,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A directory of this test's own, and the file inside it. Removed first, so a directory a
    /// killed run left behind cannot make the next one pass.
    fn scratch(label: &str) -> (PathBuf, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("nekowite-picked-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a temporary directory");
        let file = dir.join("cat.png");
        fs::write(&file, b"picked").expect("the fixture file");
        (dir, file)
    }

    #[test]
    fn a_picked_path_may_be_imported_once() {
        let (dir, file) = scratch("once");
        let picked = PickedImages::default();
        picked.mint([file.clone()]);

        assert_eq!(picked.live(), 1);
        assert!(
            picked.release(&file),
            "the path the picker returned is importable"
        );
        assert_eq!(picked.live(), 0, "the grant is spent by the import");
        assert!(
            !picked.release(&file),
            "a second import of the same pick is a replay, not a use"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_path_the_user_did_not_pick_is_refused() {
        let (dir, file) = scratch("unpicked");
        let secret = dir.join("not-picked.png");
        fs::write(&secret, b"never chosen").expect("the fixture file");

        let picked = PickedImages::default();
        picked.mint([file.clone()]);

        assert!(
            !picked.release(&secret),
            "the whole of finding S4 is that this must not be importable"
        );
        // And the picked one is untouched by the attempt.
        assert!(picked.release(&file));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_same_file_by_another_spelling_is_the_same_grant() {
        let (dir, file) = scratch("spelling");
        let picked = PickedImages::default();
        picked.mint([file.clone()]);

        // `dir/../<name>/cat.png`: one file, two spellings, and a string comparison would refuse
        // the second — which is how a legitimate import breaks, so the paths are canonicalised on
        // both sides.
        let round_about = dir
            .join("..")
            .join(dir.file_name().expect("the directory has a name"))
            .join("cat.png");
        assert_ne!(round_about, file, "the two spellings differ as strings");
        assert!(
            picked.release(&round_about),
            "the same file by another spelling is the same grant"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_grant_older_than_the_bound_is_already_spent() {
        let (dir, file) = scratch("stale");
        let picked = PickedImages::default();
        picked.mint_ago(&file, PICK_BOUND + Duration::from_secs(1));

        assert!(
            !picked.release(&file),
            "a grant is \"import this, now\", not a capability a page keeps"
        );
        assert_eq!(
            picked.live(),
            0,
            "the stale entry is dropped rather than left to grow"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_path_that_cannot_be_resolved_is_refused_rather_than_compared_as_text() {
        let (dir, file) = scratch("resolved");
        let picked = PickedImages::default();
        picked.mint([file.clone()]);

        let gone = dir.join("deleted-since-the-pick.png");
        assert!(
            !picked.release(&gone),
            "a path that is not there cannot be imported"
        );
        // The pick itself is still good: one bad call does not spend another path's grant.
        assert!(picked.release(&file));

        fs::remove_dir_all(&dir).unwrap();
    }
}
