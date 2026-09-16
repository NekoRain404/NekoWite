//! §4.3's native PTY: the entry that hands the user the engine's own commands.
//!
//! This is the third of §4's three entries and the one that starts a program with the user's own
//! rights, so three decisions live here rather than in the IPC layer above — each is a decision
//! about what may be started, or what the child is told:
//!
//! - **Which commands may be started** ([`TerminalLaunch::review`]). §4.3 forbids an arbitrary
//!   `shell -c` IPC, §3.3 forbids `sudo` and forbids running a system-level `opencode upgrade`
//!   on the user's behalf, and a managed installation's `upgrade`/`uninstall` belong to the
//!   packaging lifecycle. A refusal is a value the frontend renders as a sentence, never a
//!   silent no-op.
//! - **What the child sees** ([`terminal_env`]). A pty is an encoding path, not a locale nicety:
//!   a child inheriting `LC_ALL=C` writes mojibake for Chinese, and one inheriting
//!   `COLUMNS`/`LINES` has a second opinion about a size §4.3 requires to be single-valued.
//! - **What the host keeps** ([`OutputDecoder`]). A pty has no framing: a read can end in the
//!   middle of a Chinese character, and a program can print a line with no newline in sight.
//!   Text is decoded incrementally and lines are bounded in *columns* — not bytes, which would
//!   cut a character in half, and not `char`s, which would call 中 one column when a terminal
//!   draws it as two.
//!
//! What is deliberately absent: this module cannot reach a session. §4.3 keeps terminal output
//! out of the conversation record, and the only way out is [`NativeTerminal::take_events`], a
//! terminal-shaped stream the IPC layer forwards to the terminal view and nowhere else. It is
//! also not a sandbox: the TUI runs the engine with the user's rights (§4.3), so the app's
//! per-action permissions do not constrain what the user types here — `AgentNativeTerminal.vue`
//! says so on screen rather than implying otherwise.
//!
//! This is a session of its own, too. §4.3 forbids sharing a live session between the ACP
//! connection and a terminal until P0 has measured whether the two can share one, so nothing
//! here is joined to a conversation: a second program, on a second pty, under whatever profile
//! the caller hands it.
//!
//! The pty is allocated with `libc` rather than a PTY crate. The syscall surface is
//! `posix_openpt`/`grantpt`/`unlockpt`/`ptsname_r`, one `TIOCSWINSZ`, one `setsid` +
//! `TIOCSCTTY` in the child, and `kill(-pgid)` — what a PTY crate calls too. §4.3 asks for a
//! mature PTY library and `portable-pty` is still an unapproved dependency; this is the
//! substitutable half. Signalling follows `process.rs`'s rule: a negative pid, never a name, so
//! the user's own `opencode` is never a candidate.

use std::ffi::CStr;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// The widest line the host forwards, in terminal columns.
///
/// The same kind of bound as `process.rs`'s frame limit, for the same reason: a read is bounded
/// by its buffer, but *the thing being accumulated* is not, and one enormous line is the
/// terminal's version of an endless frame. What is dropped is reported
/// (`elided_columns`) rather than swallowed, as §6.2 requires of every bound in this runtime.
pub const MAX_LINE_COLUMNS: usize = 8192;

/// What one read may take from the pty; the pty's own buffer is smaller, so this is the size of
/// the array this module is willing to hold rather than a policy.
const READ_CHUNK: usize = 64 * 1024;

/// How long the reader blocks between checks of whether the child is gone.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// How long the child gets at each step of the shutdown ladder (§6.2 「先正常取消/退出再限时终止」):
/// `SIGHUP`, then `SIGTERM`, then `SIGKILL`.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);

/// How long a write waits for a terminal that is not reading. A tty's input queue is kilobytes,
/// so this is reached only once the child has stopped reading altogether — at which point
/// reporting beats blocking a command handler forever.
const INPUT_WAIT: Duration = Duration::from_millis(500);

/// The locale a child gets when it would otherwise have none that can encode Chinese.
const DEFAULT_LOCALE: &str = "C.UTF-8";

/// The terminal description a child gets when the app was started without one — a packaged
/// application has no terminal to inherit it from.
const DEFAULT_TERM: &str = "xterm-256color";

/// Programs that exist to run a string as a command: with a command flag, the arbitrary
/// `shell -c` IPC §4.3 refuses to provide.
const SHELLS: [&str; 9] = ["sh", "bash", "zsh", "dash", "ash", "ksh", "fish", "csh", "tcsh"];

/// Programs whose whole purpose is to become a more privileged one. §3.3 forbids `sudo`, and
/// the rule is about the act, so the family is refused together.
const ESCALATORS: [&str; 4] = ["sudo", "doas", "pkexec", "su"];

/// A managed installation's lifecycle, which §4.3 gives to the host, not to this entry.
const MANAGED_VERBS: [&str; 2] = ["upgrade", "uninstall"];

/// The variables that decide whether text encodes as UTF-8.
const LOCALE_VARS: [&str; 3] = ["LANG", "LC_ALL", "LC_CTYPE"];

/// Where an engine came from (§3.4): the same binary started by the same entry means different
/// things depending on whether NekoWite packaged it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    /// Shipped inside the application bundle.
    Bundled,
    /// Installed under the app's own data directory and updated by the host.
    Managed,
    /// The user's own installation, which the host never replaces or upgrades.
    External,
}

/// The window size, in character cells — the unit `TIOCSWINSZ` uses, and the unit a Chinese
/// character costs two of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl TerminalSize {
    /// What a child gets before anything has been measured.
    pub const DEFAULT: TerminalSize = TerminalSize { cols: 80, rows: 24 };

    /// A size a tty can actually have. Zero columns is not "empty", it is a terminal that makes
    /// some programs divide by zero, so one is the floor.
    pub fn new(cols: u16, rows: u16) -> Self {
        TerminalSize {
            cols: cols.max(1),
            rows: rows.max(1),
        }
    }

    /// The largest whole number of cells that fits a box, given one cell's size in pixels.
    ///
    /// The cell size is the view's measurement of its own font, which is why it arrives as a
    /// number rather than a guess here. An axis that cannot be measured — zero, or a `NaN` from
    /// dividing by a hidden element — falls back to that axis's default rather than to a size
    /// the tty would have to be told to ignore.
    pub fn from_pixels(width: f64, height: f64, cell_width: f64, cell_height: f64) -> Self {
        let cells = |extent: f64, cell: f64| -> u16 {
            let count = extent / cell;
            if cell <= 0.0 || !count.is_finite() || count < 1.0 {
                return 0;
            }
            count.floor().min(u16::MAX as f64) as u16
        };
        let axis = |count: u16, default: u16| if count == 0 { default } else { count };
        TerminalSize::new(
            axis(cells(width, cell_width), TerminalSize::DEFAULT.cols),
            axis(cells(height, cell_height), TerminalSize::DEFAULT.rows),
        )
    }
}

/// Everything a native terminal is started from. The program is an executable and the arguments
/// are an array (§3.4): there is no string for a shell to parse anywhere in this type.
#[derive(Debug, Clone)]
pub struct TerminalLaunch {
    /// Absolute. Resolving a bare name through `PATH` belongs to the registry that validated the
    /// program, not to the layer that spawns it.
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Extra environment. Credentials belong here and never in `args` (P0 §3).
    pub env: Vec<(String, String)>,
    pub size: TerminalSize,
    pub install: InstallKind,
}

/// Why a command may not be started. The code is what the frontend turns into a sentence; the
/// detail names the exact word refused, so a diagnosis need not guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalKind {
    NotAbsolute,
    NotExecutable,
    ShellCommand,
    PrivilegeEscalation,
    ManagedLifecycle,
}

impl RefusalKind {
    pub fn code(self) -> &'static str {
        match self {
            RefusalKind::NotAbsolute => "program-not-absolute",
            RefusalKind::NotExecutable => "program-not-executable",
            RefusalKind::ShellCommand => "shell-command",
            RefusalKind::PrivilegeEscalation => "privilege-escalation",
            RefusalKind::ManagedLifecycle => "managed-lifecycle",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRefusal {
    pub kind: RefusalKind,
    pub detail: String,
}

impl CommandRefusal {
    fn new(kind: RefusalKind, detail: impl Into<String>) -> Self {
        CommandRefusal {
            kind,
            detail: detail.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.kind.code()
    }
}

impl TerminalLaunch {
    /// Whether this command may be started at all, and if not, why.
    ///
    /// The rules are about the *program*, not about what a TUI may later do with its own
    /// arguments: this decides which commands NekoWite offers an entry for, and §4.3 is explicit
    /// that a native TUI's own tool execution is not constrained by the app's buttons.
    pub fn review(&self) -> Result<(), CommandRefusal> {
        let shown = self.program.to_string_lossy().into_owned();
        if !self.program.is_absolute() {
            return Err(CommandRefusal::new(RefusalKind::NotAbsolute, shown));
        }
        let base = basename(&self.program);
        if ESCALATORS.contains(&base.as_str()) {
            return Err(CommandRefusal::new(RefusalKind::PrivilegeEscalation, base));
        }
        // The first word is where a wrapper names the program it runs, which is the mistake this
        // catches. The rest of the list is deliberately not searched for escalators: `run "sudo
        // make install"` is a prompt, and refusing a prompt would be refusing the user's words.
        if let Some(first) = self.args.first() {
            let word = basename(Path::new(first));
            if ESCALATORS.contains(&word.as_str()) {
                return Err(CommandRefusal::new(RefusalKind::PrivilegeEscalation, word));
            }
        }
        // Only the host's own installation is protected here. An external engine is the user's
        // and §3.3 leaves its `upgrade` to them: this entry may run it because they typed it,
        // while the app still never runs it for them.
        //
        // Every word argument is searched, not just the first: a global flag with a value can
        // precede the subcommand (`opencode --log-level DEBUG upgrade`) and this policy has no
        // parser for an engine's global flags. The cost is a prompt that is exactly the word
        // `upgrade` being refused; that is visible and can be rephrased, where an upgrade of the
        // installation the app shipped is neither.
        if self.install != InstallKind::External {
            let verb = self.args.iter().find(|arg| {
                !arg.starts_with('-') && MANAGED_VERBS.contains(&basename(Path::new(arg)).as_str())
            });
            if let Some(verb) = verb {
                return Err(CommandRefusal::new(
                    RefusalKind::ManagedLifecycle,
                    basename(Path::new(verb)),
                ));
            }
        }
        if SHELLS.contains(&base.as_str()) {
            if let Some(flag) = self.args.iter().find(|arg| is_command_flag(arg)) {
                return Err(CommandRefusal::new(
                    RefusalKind::ShellCommand,
                    format!("{base} {flag}"),
                ));
            }
        }
        match std::fs::metadata(&self.program) {
            Ok(meta) if meta.is_file() && meta.permissions().mode() & 0o111 != 0 => Ok(()),
            _ => Err(CommandRefusal::new(RefusalKind::NotExecutable, shown)),
        }
    }
}

/// The name a program is known by: `sudo`, not `/usr/bin/sudo`.
fn basename(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// `-c`, `-ic`, `-lc`, `--command`: a shell being told to parse a string. A flag that merely
/// contains a `c` (`--color`) is not one, so a short flag's body must be letters ending in `c`,
/// and the one long spelling whose whole word means this is named.
fn is_command_flag(arg: &str) -> bool {
    if arg == "--command" {
        return true;
    }
    let body = match arg.strip_prefix("--").or_else(|| arg.strip_prefix('-')) {
        Some(body) => body,
        None => return false,
    };
    !body.is_empty()
        && body.ends_with(['c', 'C'])
        && body[..body.len() - 1].chars().all(|c| c.is_ascii_alphabetic())
}

/// The environment a terminal child is given, derived from the app's own.
///
/// Three deliberate differences from inheriting it whole:
///
/// - **A locale that can encode Chinese.** `LC_ALL=C` overrides every other locale variable, and
///   an engine under it writes mojibake for anything outside ASCII — so a non-UTF-8 value of any
///   of the three is dropped and `LANG` is set when nothing UTF-8 is left. A UTF-8 value the
///   user already has is theirs and is kept.
/// - **No `COLUMNS`/`LINES`.** A program that reads them believes them over the tty, which is
///   exactly the disagreement §4.3's resize requirement is about. They go, so the tty is the
///   only answer.
/// - **A terminal description.** `TERM` is inherited when there is one; a packaged app has none,
///   and a TUI without it will not start.
pub fn terminal_env(inherited: &[(String, String)]) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::with_capacity(inherited.len() + 2);
    for (name, value) in inherited {
        let drop = match name.as_str() {
            "COLUMNS" | "LINES" => true,
            _ => LOCALE_VARS.contains(&name.as_str()) && !is_utf8_locale(value),
        };
        if !drop {
            env.push((name.clone(), value.clone()));
        }
    }
    if !env
        .iter()
        .any(|(name, _)| LOCALE_VARS.contains(&name.as_str()))
    {
        env.push(("LANG".to_string(), DEFAULT_LOCALE.to_string()));
    }
    if !env.iter().any(|(name, _)| name == "TERM") {
        env.push(("TERM".to_string(), DEFAULT_TERM.to_string()));
    }
    env
}

fn is_utf8_locale(value: &str) -> bool {
    let value = value.to_ascii_uppercase();
    value.contains("UTF-8") || value.contains("UTF8")
}

/// How a terminal ended. `code: None, signal: None` is a terminal that ended without a status
/// the host could obtain — a state kept apart from "exit 0".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

impl TerminalExit {
    pub const UNKNOWN: TerminalExit = TerminalExit {
        code: None,
        signal: None,
    };

    fn of(status: ExitStatus) -> Self {
        TerminalExit {
            code: status.code(),
            signal: status.signal(),
        }
    }
}

/// One piece of what the terminal produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalEvent {
    /// Text the child wrote. `elided_columns` is how much of the current line the column bound
    /// dropped, so a view can say the line is incomplete instead of drawing a short line as if
    /// it were the whole one.
    Output { text: String, elided_columns: u32 },
    /// The single ending of this terminal, sent exactly once by whichever of the reader, a
    /// close, or a poll noticed first (the rule `runs.rs` applies to a run).
    Exited(TerminalExit),
}

/// What went wrong around a terminal. `code` is the stable half the frontend renders.
#[derive(Debug)]
pub enum TerminalError {
    Refused(CommandRefusal),
    /// The pty itself could not be allocated.
    // The two payloads below are the underlying reason, kept so a diagnosis names the errno
    // instead of restating the variant. Nothing in this crate reads them yet: the layer that
    // turns this into the IPC error belongs to the wiring that is not this file's.
    #[allow(dead_code)]
    Pty(String),
    Spawn(io::Error),
    #[allow(dead_code)]
    Input(io::Error),
    /// The child is gone; writing to it would be a silent drop, so it is refused instead.
    Ended,
    /// The child is not reading, reported rather than swallowed and bounded in time.
    InputBlocked,
}

impl TerminalError {
    pub fn code(&self) -> &'static str {
        match self {
            TerminalError::Refused(refusal) => refusal.code(),
            TerminalError::Pty(_) => "pty-unavailable",
            TerminalError::Spawn(_) => "spawn-failed",
            TerminalError::Input(_) => "input-failed",
            TerminalError::Ended => "terminal-ended",
            TerminalError::InputBlocked => "input-blocked",
        }
    }
}

/// Turns the pty's bytes into text a view can draw.
///
/// Two jobs, both because a pty has no framing:
///
/// - **UTF-8 across reads.** A read can end inside a multi-byte character. The unfinished tail
///   is held until the rest arrives rather than replaced, because a Chinese character shown as
///   U+FFFD is one the user cannot read; only a sequence that is *invalid* (not merely
///   unfinished) becomes a replacement.
/// - **A column bound per line.** The line being accumulated is what grows without limit, so the
///   count is kept here and the rest of an over-long line is dropped until its newline. A wide
///   character's two columns are never split, because only whole characters are emitted.
#[derive(Default)]
pub struct OutputDecoder {
    pending: Vec<u8>,
    columns: usize,
    eliding: bool,
}

impl OutputDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode what has arrived, and say how many columns of the current line were dropped.
    pub fn push(&mut self, bytes: &[u8]) -> (String, u32) {
        self.pending.extend_from_slice(bytes);
        let mut text = String::with_capacity(self.pending.len());
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(whole) => {
                    text.push_str(whole);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = &self.pending[..error.valid_up_to()];
                    text.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match error.error_len() {
                        // Not a failure: a sequence that is still arriving. Keep it — it is at
                        // most three bytes — and wait for the next read.
                        None => {
                            self.pending.drain(..error.valid_up_to());
                            break;
                        }
                        // A sequence that can never become valid; waiting would not help.
                        Some(length) => {
                            text.push('\u{FFFD}');
                            let cut = error.valid_up_to() + length;
                            self.pending.drain(..cut);
                        }
                    }
                }
            }
        }
        self.elide(&text)
    }

    /// Apply the column bound, carrying the line's state across reads.
    fn elide(&mut self, text: &str) -> (String, u32) {
        let mut kept = String::with_capacity(text.len());
        let mut elided = 0u32;
        for character in text.chars() {
            match character {
                // A new line starts a new count.
                '\n' => {
                    self.columns = 0;
                    self.eliding = false;
                    kept.push(character);
                    continue;
                }
                // A carriage return redraws the line from its start, which for this bound is the
                // end of that line: a progress line is many short lines, and one that stayed
                // elided after its first over-long frame would never be readable again.
                '\r' => {
                    self.columns = 0;
                    self.eliding = false;
                    kept.push(character);
                    continue;
                }
                _ => {}
            }
            let width = column_width(character);
            if self.eliding {
                elided += width as u32;
            } else if self.columns + width > MAX_LINE_COLUMNS {
                self.eliding = true;
                elided += width as u32;
            } else {
                self.columns += width;
                kept.push(character);
            }
        }
        (kept, elided)
    }
}

/// How many columns a terminal draws a character across.
///
/// The wide ranges are the ones terminals agree on (UAX #11 Wide and Fullwidth). Emoji are left
/// out on purpose: terminals disagree about them, and being wrong by a column is worse than
/// counting them as text. Control characters take no column — the tty's line discipline has
/// already turned the ones that move a cursor into their effects.
fn column_width(character: char) -> usize {
    match character as u32 {
        0x00..=0x1f | 0x7f => 0,
        0x0300..=0x036f | 0x200b..=0x200f | 0xfe00..=0xfe0f => 0,
        0x1100..=0x115f
        | 0x2e80..=0x303e
        | 0x3041..=0x33ff
        | 0x3400..=0x4dbf
        | 0x4e00..=0x9fff
        | 0xa000..=0xa4cf
        | 0xac00..=0xd7a3
        | 0xf900..=0xfaff
        | 0xfe30..=0xfe6f
        | 0xff00..=0xff60
        | 0xffe0..=0xffe6
        | 0x20000..=0x3fffd => 2,
        _ => 1,
    }
}

/// The single ending this terminal is allowed, and the state that decides which path reports it.
struct Process {
    child: Child,
    exit: Option<TerminalExit>,
    reported: bool,
}

impl Process {
    /// Reap the child if it has finished, and hand back its exit the first time it is known.
    fn reap(&mut self) -> Option<TerminalExit> {
        if self.exit.is_none() {
            if let Ok(Some(status)) = self.child.try_wait() {
                self.exit = Some(TerminalExit::of(status));
            }
        }
        self.exit
    }

    /// The same, but consumed: exactly one caller ever gets `Some` (see [`TerminalEvent`]).
    fn observe(&mut self) -> Option<TerminalExit> {
        let exit = self.reap();
        match (exit, self.reported) {
            (Some(exit), false) => {
                self.reported = true;
                Some(exit)
            }
            _ => None,
        }
    }

    /// An ending with no status to report: the pty closed while the child still runs, which
    /// means something else closed the slave side. Reported, so a view is never left waiting.
    fn end_without_status(&mut self) -> bool {
        if self.reported {
            return false;
        }
        self.reported = true;
        true
    }
}

/// A running program on its own pty.
pub struct NativeTerminal {
    launch: TerminalLaunch,
    /// The pid, which is also the process group: the child called `setsid`, so it leads both.
    pid: i32,
    /// The master side, shared with the reader thread rather than duplicated, so there is one
    /// file description and one place its non-blocking flag could be changed.
    master: Arc<File>,
    process: Arc<Mutex<Process>>,
    /// Set while this terminal is torn down. A reader waiting on a pty that something else still
    /// holds open would otherwise never see EOF.
    closing: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    events: Option<Receiver<TerminalEvent>>,
    /// A sender of the struct's own, so a close can report the ending it observed without
    /// waiting for the reader to notice.
    reporter: Sender<TerminalEvent>,
}

impl NativeTerminal {
    /// Review the launch, allocate a pty for it, and start the program on it.
    ///
    /// The order is the point: a refused command never reaches a pty. Nothing about a managed
    /// `upgrade` is undone by a dialog afterwards — it simply has no terminal to run in.
    pub fn open(launch: TerminalLaunch) -> Result<Self, TerminalError> {
        launch.review().map_err(TerminalError::Refused)?;

        let pty = open_pty(launch.size)?;
        let mut command = Command::new(&launch.program);
        command
            .args(&launch.args)
            .current_dir(&launch.cwd)
            // The child gets exactly the environment computed here, so what `terminal_env`
            // dropped cannot come back through an inherited default.
            .env_clear()
            .envs(env_of(&launch))
            .stdin(slave_stdio(&pty.slave)?)
            .stdout(slave_stdio(&pty.slave)?)
            .stderr(slave_stdio(&pty.slave)?);
        // Between fork and exec, so only syscalls — the child becomes a session leader and takes
        // the slave as its controlling terminal. That is what makes SIGHUP on hangup,
        // `/dev/tty`, and Ctrl-C's SIGINT-to-the-foreground-group mean anything: §4.3's TUI is
        // not a filter.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as libc::c_ulong, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().map_err(TerminalError::Spawn)?;
        let pid = child.id() as i32;

        let process = Arc::new(Mutex::new(Process {
            child,
            exit: None,
            reported: false,
        }));
        let closing = Arc::new(AtomicBool::new(false));
        let (reporter, events) = mpsc::channel();
        let master = Arc::new(pty.master);
        let reader = match spawn_reader(
            Arc::clone(&master),
            Arc::clone(&process),
            Arc::clone(&closing),
            reporter.clone(),
        ) {
            Ok(reader) => reader,
            Err(error) => {
                // Without a reader nothing will ever drain this pty, and a `Child` that is
                // dropped is not a child that is ended. §6.2 leaves no process behind, so the
                // one path that could is closed here rather than by hoping it never happens.
                signal_group(pid, libc::SIGKILL);
                let _ = process.lock().unwrap().child.wait();
                return Err(error);
            }
        };

        Ok(NativeTerminal {
            launch,
            pid,
            master,
            process,
            closing,
            reader: Some(reader),
            events: Some(events),
            reporter,
        })
    }

    /// Take the terminal's output stream, once.
    pub fn take_events(&mut self) -> Option<Receiver<TerminalEvent>> {
        self.events.take()
    }

    /// What this terminal was started with, for the header a view draws.
    pub fn launch(&self) -> &TerminalLaunch {
        &self.launch
    }

    /// The process group this terminal owns. Negative-pid signalling only (§6.3).
    pub fn process_group(&self) -> i32 {
        self.pid
    }

    /// Send text to the child as UTF-8. `&str` and not bytes: input arrives from a UI as text,
    /// and a caller that could hand over half a character could produce one.
    pub fn write(&self, text: &str) -> Result<(), TerminalError> {
        if self.is_finished() {
            return Err(TerminalError::Ended);
        }
        let mut rest = text.as_bytes();
        let deadline = Instant::now() + INPUT_WAIT;
        while !rest.is_empty() {
            match (&*self.master).write(rest) {
                Ok(0) => {
                    return Err(TerminalError::Input(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "the pseudo-terminal accepted no bytes",
                    )));
                }
                Ok(written) => rest = &rest[written..],
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(TerminalError::InputBlocked);
                    }
                    wait(self.master.as_raw_fd(), libc::POLLOUT, POLL_INTERVAL);
                }
                Err(error) => return Err(TerminalError::Input(error)),
            }
        }
        Ok(())
    }

    /// Set the tty's window size. `TIOCSWINSZ` is what delivers SIGWINCH to the foreground
    /// group, so this is the whole of a resize: the kernel tells the child, and §4.3's
    /// requirement that the two sizes not disagree is kept by there being one size.
    pub fn resize(&self, size: TerminalSize) -> Result<(), TerminalError> {
        if self.is_finished() {
            return Err(TerminalError::Ended);
        }
        set_size(self.master.as_raw_fd(), size).map_err(TerminalError::Input)
    }

    /// The ending, if the child has finished. Immediate: this is what an IPC poll asks.
    pub fn try_exit(&self) -> Option<TerminalExit> {
        let mut process = self.process.lock().unwrap();
        let observed = process.observe();
        if let Some(exit) = observed {
            let _ = self.reporter.send(TerminalEvent::Exited(exit));
        }
        process.exit
    }

    /// Whether the child has finished.
    pub fn is_finished(&self) -> bool {
        self.process.lock().unwrap().reap().is_some()
    }

    /// End the terminal: `SIGHUP`, then `SIGTERM`, then `SIGKILL`, a grace period apart.
    ///
    /// Returns the exit once the child has been reaped. Once that has happened this never
    /// signals again — a reaped pid can be reused, and §6.3's rule is that this host signals only
    /// processes it started, so the group is left alone from then on. `None` means the child
    /// could not be *proven* dead, which is reported rather than assumed.
    pub fn close(&self) -> Option<TerminalExit> {
        if let Some(exit) = self.process.lock().unwrap().exit {
            return Some(exit);
        }
        for signal in [libc::SIGHUP, libc::SIGTERM, libc::SIGKILL] {
            signal_group(self.pid, signal);
            if let Some(exit) = self.wait_for_exit(SHUTDOWN_GRACE) {
                return Some(exit);
            }
        }
        None
    }

    fn wait_for_exit(&self, limit: Duration) -> Option<TerminalExit> {
        let deadline = Instant::now() + limit;
        loop {
            let (observed, exit) = {
                let mut process = self.process.lock().unwrap();
                (process.observe(), process.reap())
            };
            if let Some(exit) = observed {
                let _ = self.reporter.send(TerminalEvent::Exited(exit));
            }
            if exit.is_some() {
                return exit;
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(POLL_INTERVAL / 5);
        }
    }
}

impl Drop for NativeTerminal {
    /// §6.2's rule about process leaks, applied to the one entry a user can leave running: the
    /// app closing takes this with it — the same decision T4b made for `AgentInstance`.
    fn drop(&mut self) {
        self.close();
        self.closing.store(true, Ordering::SeqCst);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

/// A pty master, and the slave path to open for the child.
struct Pty {
    master: File,
    slave: PathBuf,
}

fn open_pty(size: TerminalSize) -> Result<Pty, TerminalError> {
    // SAFETY: every call is a syscall on a descriptor this function owns; the descriptor moves
    // into an `OwnedFd` immediately, so there is exactly one owner of it on every path out.
    unsafe {
        // `O_CLOEXEC` is not decoration: without it the child would inherit the master side of
        // its own terminal, keep the pty alive after exiting, and be able to read what the host
        // writes to it.
        let fd = libc::posix_openpt(
            libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC | libc::O_NONBLOCK,
        );
        if fd == -1 {
            return Err(pty_error("posix_openpt"));
        }
        let master = OwnedFd::from_raw_fd(fd);
        if libc::grantpt(fd) == -1 {
            return Err(pty_error("grantpt"));
        }
        if libc::unlockpt(fd) == -1 {
            return Err(pty_error("unlockpt"));
        }
        let mut name = [0 as libc::c_char; 256];
        let code = libc::ptsname_r(fd, name.as_mut_ptr(), name.len());
        if code != 0 {
            return Err(TerminalError::Pty(format!(
                "ptsname_r: {}",
                io::Error::from_raw_os_error(code)
            )));
        }
        let slave = PathBuf::from(CStr::from_ptr(name.as_ptr()).to_string_lossy().into_owned());
        // Before the child exists, so its very first question about the window size has the real
        // answer: a child that starts at 0×0 and is corrected a moment later draws its first
        // frame wrong.
        set_size(fd, size).map_err(|error| TerminalError::Pty(format!("TIOCSWINSZ: {error}")))?;
        Ok(Pty {
            master: File::from(master),
            slave,
        })
    }
}

fn pty_error(what: &str) -> TerminalError {
    TerminalError::Pty(format!("{what}: {}", io::Error::last_os_error()))
}

fn slave_stdio(path: &Path) -> Result<Stdio, TerminalError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| TerminalError::Pty(format!("opening {}: {error}", path.display())))?;
    Ok(Stdio::from(file))
}

/// The app's environment, this module's policy applied, the caller's values last.
fn env_of(launch: &TerminalLaunch) -> Vec<(String, String)> {
    // `vars_os` rather than `vars`: a single non-UTF-8 variable in the developer's environment
    // must not be able to panic the app that starts a terminal.
    let inherited: Vec<(String, String)> = std::env::vars_os()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect();
    let mut env = terminal_env(&inherited);
    // The caller's values win over the app's and over the policy's: §8.1's profile roots are
    // exactly this kind of name, and a terminal pointed at the wrong profile is the failure that
    // rule exists to prevent.
    for (name, value) in &launch.env {
        env.retain(|(existing, _)| existing != name);
        env.push((name.clone(), value.clone()));
    }
    env
}

fn set_size(fd: RawFd, size: TerminalSize) -> io::Result<()> {
    let winsize = libc::winsize {
        ws_row: size.rows,
        ws_col: size.cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: `fd` is a pty this module opened, and the third argument is the `winsize` pointer
    // `TIOCSWINSZ` reads.
    let result = unsafe { libc::ioctl(fd, libc::TIOCSWINSZ as libc::c_ulong, &winsize) };
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Signal a whole process group, by negative pid.
///
/// `process.rs` reaches the same effect through `kill(1)` because `libc` was not a direct
/// dependency of this crate; here the call is available, so the group is signalled directly.
/// What both keep is the property §6.3 is about: a target that is a group this host created,
/// never a name that could match someone else's process.
fn signal_group(pgid: i32, signal: i32) {
    if pgid <= 1 {
        // 0 would be "every process in my own group" and 1 is init. Neither is ever this
        // terminal's child, and a signal sent to either cannot be taken back.
        return;
    }
    // SAFETY: a negative pid signals a process group. The result is ignored on purpose: ESRCH
    // means the group is already gone, which is the state this function is trying to reach.
    unsafe {
        libc::kill(-pgid, signal);
    }
}

/// Wait for a descriptor to become ready, up to `timeout`. An error counts as "not ready": every
/// caller either asks again or gives up.
fn wait(fd: RawFd, events: libc::c_short, timeout: Duration) -> bool {
    let mut poll_fd = libc::pollfd {
        fd,
        events,
        revents: 0,
    };
    let millis = timeout.as_millis().min(i32::MAX as u128) as i32;
    // SAFETY: one `pollfd` on the stack, a count of one, and a timeout.
    unsafe { libc::poll(&mut poll_fd, 1, millis) > 0 }
}

/// Read the pty until the program this terminal started has ended.
fn spawn_reader(
    master: Arc<File>,
    process: Arc<Mutex<Process>>,
    closing: Arc<AtomicBool>,
    events: Sender<TerminalEvent>,
) -> Result<JoinHandle<()>, TerminalError> {
    std::thread::Builder::new()
        .name("nekowite-native-terminal".to_string())
        .spawn(move || {
            let mut decoder = OutputDecoder::new();
            let mut buffer = vec![0u8; READ_CHUNK];
            loop {
                let mut gone = false;
                let ready = wait(master.as_raw_fd(), libc::POLLIN, POLL_INTERVAL);
                if ready {
                    match (&*master).read(&mut buffer) {
                        Ok(0) => gone = true,
                        Ok(read) => {
                            let (text, elided) = decoder.push(&buffer[..read]);
                            if !text.is_empty() || elided > 0 {
                                let _ = events.send(TerminalEvent::Output {
                                    text,
                                    elided_columns: elided,
                                });
                            }
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                        // Linux reports a pty whose slave side is gone as EIO, which is the same
                        // fact as a zero-length read written differently.
                        Err(error) if error.raw_os_error() == Some(libc::EIO) => gone = true,
                        Err(_) => gone = true,
                    }
                }

                if closing.load(Ordering::SeqCst) {
                    let mut state = process.lock().unwrap();
                    let ended = state.end_without_status();
                    drop(state);
                    if ended {
                        let _ = events.send(TerminalEvent::Exited(TerminalExit::UNKNOWN));
                    }
                    break;
                }

                // The program this terminal started *is* the terminal's life. But it is not the
                // end of the *stream*: a program that exits has already written everything it
                // will write, and that last line is still in the pty — so the reader goes on
                // until the pty has nothing left, whether because it is gone or because a poll
                // after the reap found nothing to read. Reporting on the reap alone was a real
                // bug here: it dropped the tail of a program whose output did not fit in one
                // read, which is most of them.
                let reaped = process.lock().unwrap().reap().is_some();
                if gone || (reaped && !ready) {
                    // A pty that is drained but not yet gone (the child has just ended) is worth
                    // one short wait, so the ending carries the child's own status rather than
                    // "unknown".
                    await_exit(&process, SHUTDOWN_GRACE);
                    let mut state = process.lock().unwrap();
                    let ended = match state.observe() {
                        Some(exit) => Some(exit),
                        None => state.end_without_status().then_some(TerminalExit::UNKNOWN),
                    };
                    drop(state);
                    if let Some(exit) = ended {
                        let _ = events.send(TerminalEvent::Exited(exit));
                    }
                    break;
                }
            }
        })
        .map_err(TerminalError::Spawn)
}

/// Wait for the child to be reaped, without consuming the one report.
fn await_exit(process: &Mutex<Process>, limit: Duration) -> Option<TerminalExit> {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(exit) = process.lock().unwrap().reap() {
            return Some(exit);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}
