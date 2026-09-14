//! The property the audit found correct and unguarded: a save never truncates
//! the note it is replacing.
//!
//! A save is a `create_new` on a temp sibling, `sync_all`, `rename` and a
//! directory fsync, so a process death in the middle of one leaves the previous
//! version intact rather than an empty file. That is better than most
//! applications do, and NOTHING pinned it: `atomic_write_test.rs` pins the mode
//! carry-over and the read-only refusal, `fs_test.rs` pins temp-file cleanup,
//! and a refactor to `fs::write` would pass both suites while turning every
//! interrupted save into a truncated note.
//!
//! Two guards, because they fail differently and each answers the other's
//! weakness:
//!
//! * [`a_kill_mid_save_leaves_the_previous_version`] PRODUCES the interruption —
//!   a real `SIGKILL` of a real save, with a deliberately non-atomic control
//!   running beside it so the test proves on every run that it can see the
//!   damage it is looking for. It is the stronger guard and the slower one.
//! * [`no_note_path_module_writes_in_place`] reads the source and refuses the
//!   exact regression the audit named. It is cheap, it names the file and line
//!   when it fails, and it is text, so a `fs::write` smuggled in behind a
//!   helper the behavioural test cannot reach still fails here.
//!
//! Everything below runs under `/tmp`, on scratch vaults of its own.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The previous version, which no interrupted save may damage.
const OLD: &str = "the version that was already on disk\n";

/// The child's payload. Big enough that the write is still in flight when the
/// parent's kill arrives: the parent polls the directory every few microseconds
/// and the child is writing tens of megabytes, so the kill lands inside the
/// write by three orders of magnitude. A payload this size costs the child
/// ~64 MB of memory and nothing else.
const PAYLOAD: usize = 64 * 1024 * 1024;

/// How many times to re-run an attempt whose kill arrived too late to prove
/// anything. Each attempt is a fresh child and a fresh fixture.
const ATTEMPTS: usize = 5;

/// Set in the child's environment: which writer to run, and where. The child is
/// this same test binary, re-run with `--exact`.
const CHILD_MODE: &str = "NKW_ATOMICITY_CHILD";
const CHILD_DIR: &str = "NKW_ATOMICITY_DIR";

/// The test the child re-runs.
const TEST_NAME: &str = "a_kill_mid_save_leaves_the_previous_version";

fn temp_dir(label: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("nekowite-atomicity-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The child's half. It runs the save that the parent is about to interrupt;
/// which save depends on the mode, and the difference between the two modes is
/// the whole test.
fn child_body(mode: &str, dir: &Path) {
    let root = dir.to_str().unwrap().to_string();
    match mode {
        "atomic" => {
            // The real path, exactly as the app runs it.
            let result = nekowite_lib::storage::file_store::write_file(
                &root,
                "note.md",
                &"x".repeat(PAYLOAD),
                Some(10),
            );
            // Only reached if the kill arrived late; either way the parent
            // reads the disk, not this.
            std::process::exit(if result.is_ok() { 0 } else { 1 });
        }
        "inplace" => {
            // The regression, reproduced: one truncating write in place. This
            // is the `fs::write` the audit warned a refactor could reach for.
            let _ = std::fs::write(dir.join("note.md"), "x".repeat(PAYLOAD));
            std::process::exit(0);
        }
        other => panic!("unknown child mode {other}"),
    }
}

/// What the parent waits for before killing: the moment the child is provably
/// inside its write.
///
/// Both signals are watched in BOTH modes, and that is not belt-and-braces.
/// The staged sibling is what the atomic path shows; the note changing size is
/// what a non-atomic one shows. A parent that waited only for the staged
/// sibling would spend its timeout on a regression and fail with "the child
/// never started writing" — true, and useless — instead of with "the version
/// that was already on disk is gone", which is the sentence the test exists to
/// produce.
fn write_is_in_flight(dir: &Path) -> bool {
    // The staged sibling exists, so the child has opened it and has not yet
    // renamed it over the note.
    let staged_sibling = std::fs::read_dir(dir).unwrap().flatten().any(|e| {
        let name = e.file_name().to_string_lossy().to_string();
        name.starts_with(".nekowite-") && name.ends_with(".tmp")
    });
    // Or the note is no longer its old size: a truncating write has begun.
    let note_changed = std::fs::metadata(dir.join("note.md"))
        .map(|m| m.len() != OLD.len() as u64)
        .unwrap_or(false);
    staged_sibling || note_changed
}

/// One interrupted attempt: what the note holds afterwards, and how many bytes
/// of the write were staged and not yet published when the child died.
struct Interrupted {
    content: String,
    staged_bytes: Option<u64>,
}

/// Run one child to the point where its write is in flight, kill it there, and
/// report what the note holds afterwards. `None` means the kill arrived after
/// the child had finished — the attempt proved nothing and is not counted.
fn interrupt(mode: &str, dir: &Path) -> Option<Interrupted> {
    // The fixture is rebuilt from nothing, not just overwritten. A staged
    // sibling left behind by a killed attempt is exactly the signal the next
    // attempt waits for, so a leftover would kill the next child before it had
    // written a byte and hand back a pass it did not earn.
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("note.md"), OLD).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST_NAME, "--nocapture", "--test-threads=1"])
        .env(CHILD_MODE, mode)
        .env(CHILD_DIR, dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(30);
    while !write_is_in_flight(dir) {
        assert!(
            Instant::now() < deadline,
            "the child never started writing: mode {mode}"
        );
    }
    // `SIGKILL`, and the child is never given the chance to clean up — which is
    // the point: this is the death the property is about.
    let _ = child.kill();
    let _ = child.wait();

    let content = std::fs::read_to_string(dir.join("note.md")).unwrap();
    if content.len() == PAYLOAD {
        // The child finished before the signal landed. Nothing was interrupted.
        return None;
    }
    // What the kill left mid-flight. For the atomic path this is the staged
    // sibling and the bytes already in it — the evidence that the child died
    // holding a half-written file that was NOT the note. A non-atomic writer
    // has nothing here, because its half-written file IS the note.
    let staged_bytes = std::fs::read_dir(dir).unwrap().flatten().find_map(|e| {
        let name = e.file_name().to_string_lossy().to_string();
        (name.starts_with(".nekowite-") && name.ends_with(".tmp"))
            .then(|| e.metadata().map(|m| m.len()).unwrap_or(0))
    });
    Some(Interrupted {
        content,
        staged_bytes,
    })
}

/// A save killed mid-write leaves the previous version, and never an empty
/// file. The control in the same test is what makes the claim checkable: the
/// non-atomic writer IS damaged by the same kill, on the same machine, in the
/// same run — so a green result here cannot be the kill arriving too late.
#[test]
fn a_kill_mid_save_leaves_the_previous_version() {
    if let Some(mode) = std::env::var_os(CHILD_MODE) {
        let dir = std::env::var_os(CHILD_DIR).expect("the child needs a directory");
        child_body(&mode.to_string_lossy(), Path::new(&dir));
        return;
    }

    let dir = temp_dir("kill");

    // 1. The control: an in-place write, interrupted the same way. It proves
    //    the interruption is produced rather than described.
    let damaged = (0..ATTEMPTS)
        .find_map(|_| interrupt("inplace", &dir))
        .expect(
            "the non-atomic control was never caught mid-write, so this run cannot show \
             what an interrupted save costs and its result would mean nothing",
        );
    assert!(
        damaged.content.len() < PAYLOAD,
        "the control completed after all: the kill is landing too late to interrupt anything"
    );
    assert!(
        damaged.staged_bytes.is_none(),
        "an in-place write has nothing staged: its half-written file is the note"
    );

    // 2. The real path. Any attempt where the kill landed inside the write is a
    //    result; the child finishing first is not.
    let survived = (0..ATTEMPTS)
        .find_map(|_| interrupt("atomic", &dir))
        .expect("the atomic save finished before every kill landed");

    // Reported by shape, not by value: the whole point of the failure is that
    // the file is tens of megabytes of something, and a panic message that
    // dumps it helps nobody read the sentence above it.
    assert!(
        survived.content == OLD,
        "a save killed mid-write did not leave the version that was already on disk: \
         the note now holds {} bytes and starts {:?}",
        survived.content.len(),
        survived.content.chars().take(40).collect::<String>()
    );
    // The kill landed inside the write, and this is how the run knows: the
    // bytes the child was in the middle of are still in the staged sibling, and
    // none of them are in the note. A kill that arrived before the write would
    // leave this empty, and the assertion above would then have been satisfied
    // by a child that had not started yet.
    let staged = survived
        .staged_bytes
        .expect("an interrupted atomic save must leave its staged sibling behind");
    assert!(
        staged > 0,
        "the staged sibling is empty: the kill landed before the write rather than inside it"
    );
    if std::env::var_os("NKW_ATOMICITY_REPORT").is_some() {
        eprintln!(
            "killed with {staged} of {PAYLOAD} bytes staged, note intact at {} bytes",
            OLD.len()
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}

/// The regression the audit named, refused at the source.
///
/// The behavioural test above can only see a write it can run: a `fs::write`
/// reached through a path it does not exercise would pass it. This one is text,
/// so it sees every module in the vault write surface, and it fails with a file
/// and a line rather than with a torn file in someone's vault.
///
/// The rule it enforces is the shape of the write path, not a style: a note
/// path is replaced by staging a sibling and renaming it, or it is created with
/// `create_new` and linked. It is never opened for truncation, and never
/// `fs::write` — the two ways an interruption stops leaving the previous
/// version behind.
#[test]
fn no_note_path_module_writes_in_place() {
    // A file opened here may be truncated, because it is a staged sibling and
    // the note only ever appears under its own name through a rename.
    const STAGING_IS_ALLOWED_HERE: &[&str] = &[
        "storage/atomic_write.rs",
        // The master key file is not a note. It has its own store with its own
        // staging — `.<name>.tmp` beside the key and a rename, or `master.key.new`
        // for the two-phase swap — and the truncating writer is only ever aimed
        // at one of those staging paths, never at the live `master.key`. Named
        // here rather than filtered silently, so that "this file may truncate"
        // is a statement someone had to make on purpose.
        "storage/key_file_store.rs",
    ];
    // Truncating a byte is a truncating write however it is spelled.
    const BANNED: &[&str] = &["fs::write(", "File::create(", ".truncate(true)"];

    let mut scanned = 0usize;
    let mut save_definition: Option<(String, String)> = None;
    let mut errors = Vec::new();
    for file in vault_write_surface() {
        let relative = relative_to_manifest(&file);
        let source = std::fs::read_to_string(&file).unwrap();
        // Where `write_file` is DEFINED, found rather than hard-coded: a guard
        // naming a path is a guard that a split breaks, and the tempting
        // response to a guard that fails for a refactor is to delete it. The
        // property is about the function, wherever it lives.
        if source.contains("pub fn write_file(") {
            save_definition = Some((relative.clone(), production_source(&source).to_string()));
        }
        if STAGING_IS_ALLOWED_HERE.contains(&relative.as_str()) {
            continue;
        }
        let line_of = |offset: usize| source[..offset].lines().count();
        for (offset, line) in line_offsets(&production_source(&source)) {
            for banned in BANNED {
                if line.contains(banned) {
                    errors.push(format!(
                        "{relative}:{} uses `{banned}`, which replaces a file in place: {}",
                        line_of(offset) + 1,
                        line.trim()
                    ));
                }
            }
        }
        scanned += 1;
    }

    assert!(
        scanned >= 5,
        "the guard scanned {scanned} files: it is no longer looking at the write surface"
    );
    assert!(errors.is_empty(), "{}", errors.join("\n"));

    // The other half, or the guard passes by everyone having stopped writing:
    // the function that saves a note still publishes through the atomic helper.
    let (file, save_source) = save_definition.expect(
        "no module in the write surface defines `write_file`: this guard is not \
         looking at the save any more",
    );
    assert!(
        save_source.contains("atomic_write("),
        "{file} defines the save without routing it through the atomic helper"
    );
}

/// `(offset, line)` for every line of the PRODUCTION part of a source file.
///
/// The test modules inside these files write fixtures with `fs::write` on
/// purpose, and a guard that could not tell them apart would have to be
/// weakened until it caught nothing. Each one is the last item in its file, and
/// the shape is asserted rather than assumed: a `#[cfg(test)]` seen anywhere
/// else would silently stop the scan at that point.
fn production_source(source: &str) -> &str {
    let Some(at) = source.find("#[cfg(test)]") else {
        return source;
    };
    let rest = &source[at..];
    assert!(
        rest.lines()
            .take(4)
            .any(|l| l.trim_start().starts_with("mod ")),
        "a `#[cfg(test)]` that is not a trailing test module: the scan would stop early"
    );
    &source[..at]
}

fn line_offsets(source: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut offset = 0usize;
    for line in source.lines() {
        out.push((offset, line));
        offset += line.len() + 1;
    }
    out
}

fn manifest_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn relative_to_manifest(file: &Path) -> String {
    file.strip_prefix(manifest_path())
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches("src/")
        .to_string()
}

/// Every Rust file of the vault write surface: the whole storage layer, and the
/// command that fronts it.
///
/// Deliberately not all of `src/`. The property this guards is about the files
/// the user's WRITING lives in, and widening the scan past that would produce
/// findings that are true and irrelevant until someone stops reading them:
/// `state.rs` writes the remembered-vault file in the config directory (one
/// line, tolerated on read), and the AI provider layer owns its own files.
fn vault_write_surface() -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_rust(&manifest_path().join("src/storage"), &mut out);
    out.push(manifest_path().join("src/commands/fs.rs"));
    assert!(
        out.iter().all(|p| p.exists()),
        "the write surface moved: {out:?}"
    );
    out
}

fn collect_rust(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rust(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    out.sort();
}
