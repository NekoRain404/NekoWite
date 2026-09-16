//! T15: the native terminal entry, against a real pty and a real child process.
//!
//! Four of the five acceptance cases are only real here, because each is a *kernel* fact rather
//! than a branch: Chinese has to survive the tty's byte path, a resize has to reach a running
//! child through `TIOCSWINSZ`, a cancel has to end a process group, and an exit has to be the
//! child's own status. A mock could assert any of them and prove nothing.
//!
//! The fifth — 受管升级限制 — is a policy, and its tests are the ones that never start anything:
//! what matters is that a refused command has no pty, so the fixture those tests would have run
//! leaves no marker file behind.
//!
//! The module is included by path because the file that registers it in `agent_runtime/mod.rs`
//! belongs to another task (T2 did the same while its registration was pending). Nothing in the
//! module refers to `crate::`, so the include compiles against the same source the app ships.

#[path = "../src/agent_runtime/native_terminal.rs"]
mod native_terminal;

use native_terminal::{
    InstallKind, MAX_LINE_COLUMNS, NativeTerminal, OutputDecoder, RefusalKind, TerminalError,
    TerminalEvent, TerminalExit, TerminalLaunch, TerminalSize, terminal_env,
};

use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

/// Generous enough that a slow machine does not flake, short enough that a hang fails the run
/// rather than the suite timeout.
const PATIENCE: Duration = Duration::from_secs(10);

/// A repository-internal scratch directory (`target/tmp`), not `/tmp`: §3.2 keeps development
/// fixtures inside the repository, and the maintainer's `/tmp` is not this task's to litter.
fn scratch(label: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("native-terminal-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("a scratch directory");
    dir
}

/// A POSIX shell script written by the test, executable.
///
/// A script rather than a second Rust binary: it needs no build step, it says exactly what the
/// child does with the terminal, and `/bin/sh` is the one interpreter a Linux user always has.
fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, body).expect("the fixture is written");
    let mut permissions = fs::metadata(&path).expect("the fixture exists").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&path, permissions).expect("the fixture is executable");
    path
}

/// An absolute path to a coreutil this test needs — the review refuses anything else.
fn program(name: &str) -> PathBuf {
    for directory in ["/usr/bin", "/bin"] {
        let candidate = Path::new(directory).join(name);
        if candidate.is_file() {
            return candidate;
        }
    }
    panic!("this test needs {name} in /usr/bin or /bin");
}

/// A program that has a shell's *name* without needing that shell installed: the review works on
/// the basename, and `/bin/sh` under the name `zsh` is exactly the case it must catch.
fn named(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    let _ = fs::remove_file(&path);
    symlink(program("sh"), &path).expect("a renamed shell");
    path
}

fn launch(program: PathBuf, args: &[&str], dir: &Path) -> TerminalLaunch {
    TerminalLaunch {
        program,
        args: args.iter().map(|arg| arg.to_string()).collect(),
        cwd: dir.to_path_buf(),
        env: Vec::new(),
        size: TerminalSize::new(80, 24),
        install: InstallKind::Bundled,
    }
}

fn opened(launch: TerminalLaunch) -> (NativeTerminal, Receiver<TerminalEvent>) {
    let mut terminal = NativeTerminal::open(launch).expect("the fixture terminal opens");
    let events = terminal.take_events().expect("the stream is taken once");
    (terminal, events)
}

/// Everything the terminal produced until `done` is satisfied, or the patience runs out.
///
/// Output is still read after the exit event: a close reports the ending as soon as it observes
/// it, and the last thing a program wrote can arrive behind that.
fn read_until(
    events: &Receiver<TerminalEvent>,
    done: impl Fn(&str) -> bool,
    limit: Duration,
) -> (String, Option<TerminalExit>) {
    let deadline = Instant::now() + limit;
    let mut text = String::new();
    let mut exit = None;
    let mut tail = limit;
    loop {
        let left = deadline.saturating_duration_since(Instant::now()).min(tail);
        match events.recv_timeout(left) {
            Ok(TerminalEvent::Output { text: chunk, .. }) => {
                text.push_str(&chunk);
                if done(&text) {
                    return (text, exit);
                }
            }
            Ok(TerminalEvent::Exited(ended)) => {
                if done(&text) {
                    return (text, Some(ended));
                }
                if exit.is_some() {
                    return (text, exit);
                }
                exit = Some(ended);
                tail = Duration::from_millis(500);
            }
            Err(_) => return (text, exit),
        }
    }
}

fn is_alive(pid: i32) -> bool {
    // Signal 0 asks the kernel whether the process exists without delivering anything.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// One variable of the environment a child printed, by whole line: `COLORTERM=` contains the
/// letters of `TERM=`, and a substring search would answer a different question than the one
/// asked — which is how this test first read a `TERM` the app had not set.
fn variable(text: &str, name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    text.lines()
        .find(|line| line.starts_with(&prefix))
        .map(|line| line[prefix.len()..].to_string())
}

#[test]
fn a_shell_told_to_run_a_string_is_refused_however_it_is_spelled() {
    let dir = scratch("shells");
    for name in ["sh", "bash", "zsh", "dash"] {
        let shell = named(&dir, name);
        for flag in ["-c", "-ic", "-lc", "--command"] {
            let refused = launch(shell.clone(), &[flag, "opencode upgrade"], &dir)
                .review()
                .expect_err(&format!("{name} {flag} is a command string"));
            assert_eq!(refused.kind, RefusalKind::ShellCommand);
            assert_eq!(refused.code(), "shell-command");
            assert!(
                refused.detail.contains(flag),
                "the refusal names the flag it refused: {}",
                refused.detail
            );
        }
        // The same shell without a command string is a shell the user may sit in front of: what
        // §4.3 refuses is the *programmatic* command string, not the user typing commands.
        launch(shell, &[], &dir)
            .review()
            .expect("an interactive shell is not a command string");
    }
    // A flag that merely ends in `c` is not a command flag.
    launch(named(&dir, "sh"), &["--color", "always"], &dir)
        .review()
        .expect("--color is not a command flag");
}

#[test]
fn privilege_escalation_is_refused_as_a_program_and_as_a_first_word() {
    let dir = scratch("escalation");
    for name in ["sudo", "doas", "pkexec", "su"] {
        let refused = launch(named(&dir, name), &["true"], &dir)
            .review()
            .expect_err("an escalator is never the program");
        assert_eq!(refused.kind, RefusalKind::PrivilegeEscalation);
        assert_eq!(refused.code(), "privilege-escalation");
        assert_eq!(refused.detail, name);
    }
    let engine = script(&dir, "opencode", "#!/bin/sh\nexit 0\n");
    let refused = launch(engine.clone(), &["sudo", "opencode", "upgrade"], &dir)
        .review()
        .expect_err("a wrapper naming an escalator is the same act");
    assert_eq!(refused.kind, RefusalKind::PrivilegeEscalation);
    assert_eq!(refused.detail, "sudo");
    // The search stops at the first word on purpose: everything after it is the program's own
    // argument, and `run "sudo make install"` is a prompt — refusing it would be refusing the
    // user's words rather than an escalation.
    launch(engine.clone(), &["run", "sudo make install"], &dir)
        .review()
        .expect("a prompt is not a command");
    launch(engine, &["--log-level", "DEBUG", "doas"], &dir)
        .review()
        .expect("a word in a flag's value is not a command either");
}

#[test]
fn a_managed_install_may_not_run_its_own_lifecycle() {
    let dir = scratch("lifecycle");
    let engine = script(&dir, "opencode", "#!/bin/sh\nexit 0\n");
    for install in [InstallKind::Bundled, InstallKind::Managed] {
        for verb in ["upgrade", "uninstall"] {
            let mut request = launch(engine.clone(), &[verb], &dir);
            request.install = install;
            let refused = request.review().expect_err("the host owns this lifecycle");
            assert_eq!(refused.kind, RefusalKind::ManagedLifecycle);
            assert_eq!(refused.code(), "managed-lifecycle");
            assert_eq!(refused.detail, verb);
        }
        // Everything else the terminal is for still starts.
        let mut request = launch(engine.clone(), &["run", "fix the note"], &dir);
        request.install = install;
        request.review().expect("`run` is not a lifecycle verb");
        // A global flag in front of the verb does not smuggle it past — not even one that takes
        // a value, which is the spelling the policy cannot parse its way through.
        for args in [
            &["--print-logs", "upgrade"][..],
            &["--log-level", "DEBUG", "uninstall"][..],
        ] {
            let mut request = launch(engine.clone(), &args, &dir);
            request.install = install;
            let refused = request.review().expect_err("still a lifecycle verb");
            assert_eq!(refused.kind, RefusalKind::ManagedLifecycle);
            assert_eq!(refused.detail, args[args.len() - 1]);
        }
    }
    // §3.3: an external installation is the user's. They may upgrade their own engine by typing
    // it — what the app never does is run it *for* them.
    let mut external = launch(engine, &["upgrade"], &dir);
    external.install = InstallKind::External;
    external.review().expect("the user's own engine is the user's");
}

#[test]
fn a_program_that_is_not_the_validated_one_is_refused() {
    let dir = scratch("absolute");
    let relative = launch(PathBuf::from("opencode"), &[], &dir)
        .review()
        .expect_err("a bare name would be resolved through PATH");
    assert_eq!(relative.kind, RefusalKind::NotAbsolute);
    assert_eq!(relative.code(), "program-not-absolute");

    let plain = dir.join("not-executable");
    fs::write(&plain, "#!/bin/sh\n").expect("a file without an exec bit");
    let refused = launch(plain, &[], &dir)
        .review()
        .expect_err("a file without an exec bit cannot be started");
    assert_eq!(refused.kind, RefusalKind::NotExecutable);
    assert_eq!(refused.code(), "program-not-executable");

    let missing = dir.join("vanished");
    assert_eq!(
        launch(missing, &[], &dir).review().expect_err("gone").kind,
        RefusalKind::NotExecutable
    );
}

#[test]
fn a_refused_command_never_reaches_a_pty_or_a_child() {
    let dir = scratch("refused");
    let marker = dir.join("ran");
    let engine = script(
        &dir,
        "opencode",
        &format!("#!/bin/sh\ntouch {}\n", marker.display()),
    );
    let error = NativeTerminal::open(launch(engine, &["upgrade"], &dir))
        .err()
        .expect("a managed upgrade is refused");
    assert_eq!(error.code(), "managed-lifecycle");
    assert!(matches!(&error, TerminalError::Refused(_)));
    // The half that matters: nothing ran. A refusal that had already started the program and
    // then reported would be a dialog, and what §4.3 asks for is that there be no terminal.
    assert!(!marker.exists(), "the refused program was started anyway");
}

#[test]
fn a_program_that_cannot_be_started_says_why() {
    let dir = scratch("spawn");
    let mut request = launch(program("true"), &[], &dir);
    // The registry validates the program; where it runs is the other half of a launch, and a
    // working directory that has gone away fails there. The reason travels with the failure —
    // "spawn failed" would send a reader looking for a missing binary that is not missing.
    request.cwd = dir.join("vanished");
    let error = NativeTerminal::open(request).err().expect("the launch fails");
    assert_eq!(error.code(), "spawn-failed");
    assert!(matches!(
        &error,
        TerminalError::Spawn(reason) if reason.kind() == std::io::ErrorKind::NotFound
    ));
}

#[test]
fn a_terminal_size_is_never_empty_and_never_contradicts_the_measurement() {
    assert_eq!(TerminalSize::new(0, 0), TerminalSize { cols: 1, rows: 1 });
    assert_eq!(
        TerminalSize::from_pixels(800.0, 320.0, 8.0, 16.0),
        TerminalSize { cols: 100, rows: 20 }
    );
    // Nothing measured yet: the default, not a size the tty would have to ignore.
    assert_eq!(
        TerminalSize::from_pixels(0.0, 0.0, 8.0, 16.0),
        TerminalSize::DEFAULT
    );
    // A hidden element divides into a `NaN`, and one bad axis does not spoil the other.
    assert_eq!(
        TerminalSize::from_pixels(f64::NAN, 100.0, 8.0, 16.0),
        TerminalSize { cols: 80, rows: 6 }
    );
    // A cell size of zero is the failure that would make the division meaningless.
    assert_eq!(
        TerminalSize::from_pixels(800.0, 320.0, 0.0, 0.0),
        TerminalSize::DEFAULT
    );
}

#[test]
fn a_chinese_character_split_across_reads_arrives_whole() {
    // 中 is three bytes. Until the third arrives there is no character, and a host that guessed
    // would be showing one the reader did not write.
    let bytes = "中".as_bytes();
    let mut decoder = OutputDecoder::new();
    for byte in &bytes[..bytes.len() - 1] {
        let (text, elided) = decoder.push(&[*byte]);
        assert!(text.is_empty(), "an unfinished character is not text yet");
        assert_eq!(elided, 0);
    }
    let (text, _) = decoder.push(&bytes[bytes.len() - 1..]);
    assert_eq!(text, "中");

    // The same, a byte at a time, over a whole sentence — including punctuation, which is
    // full-width and therefore three bytes each.
    let sentence = "你好，世界：这是原生终端。\n";
    let mut decoder = OutputDecoder::new();
    let mut seen = String::new();
    for byte in sentence.as_bytes() {
        let (text, _) = decoder.push(&[*byte]);
        seen.push_str(&text);
    }
    assert_eq!(seen, sentence);
    assert!(!seen.contains('\u{FFFD}'));
}

#[test]
fn an_invalid_byte_becomes_one_replacement_and_does_not_stall_the_stream() {
    let mut decoder = OutputDecoder::new();
    // 0xFF can never begin a UTF-8 sequence: waiting would be waiting forever.
    let (text, _) = decoder.push(&[0xff, b'a']);
    assert_eq!(text, "\u{FFFD}a");
    // A *truncated* sequence is different: it is still arriving.
    let (text, _) = decoder.push(&[0xc3]);
    assert_eq!(text, "");
    let (text, _) = decoder.push(&[0xa9, b'!']);
    assert_eq!(text, "é!");
}

#[test]
fn a_line_past_the_column_bound_is_cut_between_characters() {
    let mut decoder = OutputDecoder::new();
    // 5000 Chinese characters: 10000 columns against a bound of 8192, so 4096 of them fit —
    // each occupying two columns, which is the whole reason the bound is not in bytes.
    let long: String = "汉".repeat(5000);
    let (kept, elided) = decoder.push(format!("{long}\n尾\n").as_bytes());
    let first = kept.split('\n').next().expect("a first line");
    assert_eq!(first.chars().count(), MAX_LINE_COLUMNS / 2);
    assert!(first.chars().all(|character| character == '汉'));
    assert_eq!(elided, ((5000 - MAX_LINE_COLUMNS / 2) * 2) as u32);
    // The bound is per line: the newline resets it, so the next line is whole.
    assert!(kept.ends_with("尾\n"), "the next line survived: {kept:?}");
    assert!(!kept.contains('\u{FFFD}'), "nothing was cut inside a character");

    // A carriage return starts a new line for the same purpose — a progress line redrawn from
    // its start is many short lines, not one endless one, and it must not stay elided forever.
    let mut decoder = OutputDecoder::new();
    let (_, elided) = decoder.push(format!("{long}\r").as_bytes());
    assert!(elided > 0);
    let (kept, elided) = decoder.push("下一行\n".as_bytes());
    assert_eq!(kept, "下一行\n");
    assert_eq!(elided, 0);
}

#[test]
fn a_chinese_line_reaches_the_child_byte_for_byte() {
    let dir = scratch("chinese");
    // `wc -c` is the witness: it reports how many bytes it read, so a character that lost or
    // gained a byte anywhere on the way shows up as a number that is not 7.
    let (terminal, events) = opened(launch(program("wc"), &["-c"], &dir));
    // What a header draws: the program this terminal is actually running, not a claim about it.
    assert_eq!(terminal.launch().program, program("wc"));
    assert_eq!(terminal.launch().args, vec!["-c".to_string()]);
    terminal.write("你好\n").expect("the line is written");
    // ^D at the start of a line is what the tty's line discipline reads as end-of-file.
    terminal.write("\u{4}").expect("end of input");
    let (text, _) = read_until(&events, |text| text.contains('7'), PATIENCE);
    assert!(
        text.contains('7'),
        "the child read 你好 plus a newline as 7 bytes, not 6 or 8: {text:?}"
    );
    // The same bytes came back through the tty's echo, so the terminal itself carried Chinese.
    assert!(text.contains("你好"), "the echo shows the text: {text:?}");
    assert!(!text.contains('\u{FFFD}'), "nothing was replaced: {text:?}");
    terminal.close();
}

#[test]
fn the_child_is_given_a_utf8_locale_and_no_second_opinion_about_the_size() {
    // The policy, on its own: a C locale is what turns Chinese into mojibake in a Node engine.
    let env = terminal_env(&[
        ("LC_ALL".to_string(), "C".to_string()),
        ("LANG".to_string(), "C".to_string()),
        ("COLUMNS".to_string(), "200".to_string()),
        ("LINES".to_string(), "50".to_string()),
        ("PATH".to_string(), "/usr/bin".to_string()),
    ]);
    let value = |name: &str| {
        env.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    };
    assert_eq!(value("LC_ALL"), None);
    // §4.3: a program that believes COLUMNS over the tty is exactly the disagreement resize
    // must not have, so neither variable survives.
    assert_eq!(value("COLUMNS"), None);
    assert_eq!(value("LINES"), None);
    assert_eq!(value("LANG").as_deref(), Some("C.UTF-8"));
    assert_eq!(value("TERM").as_deref(), Some("xterm-256color"));
    assert_eq!(value("PATH").as_deref(), Some("/usr/bin"));

    // A locale the user already chose is theirs and is kept — including a Chinese one.
    let env = terminal_env(&[
        ("LANG".to_string(), "zh_CN.UTF-8".to_string()),
        ("TERM".to_string(), "screen".to_string()),
    ]);
    assert_eq!(env.iter().filter(|(key, _)| key == "LANG").count(), 1);
    assert_eq!(
        env.iter()
            .find(|(key, _)| key == "LANG")
            .map(|(_, value)| value.as_str()),
        Some("zh_CN.UTF-8")
    );
    assert_eq!(
        env.iter()
            .find(|(key, _)| key == "TERM")
            .map(|(_, value)| value.as_str()),
        Some("screen")
    );

    // …and the same on a real child, which is the half a policy test cannot show.
    let dir = scratch("locale");
    let (terminal, events) = opened(launch(program("env"), &[], &dir));
    let (text, _) = read_until(
        &events,
        |text| variable(text, "TERM").is_some() && variable(text, "LANG").is_some(),
        PATIENCE,
    );
    let shown = variable(&text, "TERM");
    assert!(shown.is_some(), "the child saw a TERM: {text:?}");
    let locale = variable(&text, "LANG").unwrap_or_default();
    assert!(
        locale.to_ascii_uppercase().contains("UTF-8")
            || locale.to_ascii_uppercase().contains("UTF8"),
        "the child's locale can encode Chinese: {locale:?}"
    );
    assert_eq!(variable(&text, "COLUMNS"), None, "no competing size: {text:?}");
    assert_eq!(variable(&text, "LINES"), None, "no competing size: {text:?}");
    let lc_all = variable(&text, "LC_ALL");
    assert!(
        lc_all.is_none() || lc_all.as_deref().unwrap_or_default().to_ascii_uppercase().contains("UTF-8"),
        "LC_ALL=C would override the locale and was dropped: {lc_all:?}"
    );
    terminal.close();
}

#[test]
fn the_child_reports_the_window_size_and_a_live_resize_reaches_it() {
    let dir = scratch("resize");
    // The child answers with its own tty's size, at start and again on every SIGWINCH — so the
    // size that arrives here came through the kernel, not through a value this test wrote down.
    // Phase one: a child that is *not* waiting on input, so the only thing that can make it
    // speak is the signal itself. A terminal emulator's resize is a signal, not a prompt.
    let waiting = script(
        &dir,
        "winch",
        "#!/bin/sh\ntrap 'echo winch:$(stty size)' WINCH\necho start:$(stty size)\n\
         i=0\nwhile [ \"$i\" -lt 50 ]; do i=$((i+1)); sleep 0.2; done\n",
    );
    let (waiting, waiting_events) = opened(launch(waiting, &[], &dir));
    let (text, _) = read_until(&waiting_events, |text| text.contains("start:24 80"), PATIENCE);
    assert!(text.contains("start:24 80"), "the tty's own report: {text:?}");
    waiting
        .resize(TerminalSize::new(100, 30))
        .expect("a live resize");
    let (text, _) = read_until(&waiting_events, |text| text.contains("winch:"), PATIENCE);
    assert!(
        text.contains("winch:30 100"),
        "the running child was told, and told the new size: {text:?}"
    );
    waiting.close();

    // Phase two: a child that reads and answers, so the resize is proved to sit in the middle of
    // a working session rather than to be the only thing that ever happened.
    let echo = script(
        &dir,
        "echoer",
        "#!/bin/sh\necho start:$(stty size)\n\
         while IFS= read -r line; do echo now:$(stty size); printf 'read:%s\\n' \"$line\"; done\n",
    );
    let (terminal, events) = opened(launch(echo, &[], &dir));
    let (text, _) = read_until(&events, |text| text.contains("start:24 80"), PATIENCE);
    assert!(text.contains("start:24 80"), "the tty's own report: {text:?}");

    terminal.write("一\n").expect("write");
    let (text, _) = read_until(&events, |text| text.contains("read:一"), PATIENCE);
    assert!(
        text.contains("read:一"),
        "Chinese survived the round trip: {text:?}"
    );

    terminal
        .resize(TerminalSize::new(100, 30))
        .expect("a live resize");
    terminal.write("二\n").expect("write");
    let (text, _) = read_until(&events, |text| text.contains("read:二"), PATIENCE);
    assert!(
        text.contains("read:二"),
        "input and output both survived the resize: {text:?}"
    );
    assert!(
        text.contains("now:30 100"),
        "the child's next turn saw the new size: {text:?}"
    );
    assert!(!text.contains('\u{FFFD}'));
    terminal.close();
}

#[test]
fn cancelling_ends_the_process_group_and_never_signals_it_twice() {
    let dir = scratch("cancel");
    let (terminal, events) = opened(launch(program("sleep"), &["600"], &dir));
    let pid = terminal.process_group();
    assert!(is_alive(pid), "the child was started");

    let exit = terminal.close().expect("the child was reaped");
    // SIGHUP first: a terminal that hung up is what a program on a pty is owed before it is
    // killed, and it is enough for anything that is not deliberately ignoring it.
    assert_eq!(exit.signal, Some(libc::SIGHUP));
    assert_eq!(exit.code, None);
    assert!(!is_alive(pid), "the child did not survive the cancel");
    let (_, reported) = read_until(&events, |_| false, Duration::from_millis(300));
    assert_eq!(reported, Some(exit), "the ending was reported once");
    // A reaped pid can be reused, so the second close must not signal anything: it returns the
    // ending it already has (§6.3 — only processes this host started are ever signalled).
    assert_eq!(terminal.close(), Some(exit));
    assert!(terminal.is_finished());
    let (_, second) = read_until(&events, |_| false, Duration::from_millis(200));
    assert_eq!(second, None, "a terminal ends once");
}

#[test]
fn dropping_the_terminal_does_not_leave_the_program_behind() {
    let dir = scratch("drop");
    let pid = {
        let (terminal, _events) = opened(launch(program("sleep"), &["600"], &dir));
        let pid = terminal.process_group();
        assert!(is_alive(pid));
        pid
    };
    // The drop itself is what has to end it: §6.2 has no daemon left behind, and the app closing
    // is the ordinary way this happens.
    assert!(!is_alive(pid), "the child outlived the terminal that started it");
}

#[test]
fn the_exit_status_is_the_program_s_own() {
    let dir = scratch("exit");
    let child = script(&dir, "seven", "#!/bin/sh\nexit 7\n");
    let (terminal, events) = opened(launch(child, &[], &dir));
    let (_, exit) = read_until(&events, |_| false, PATIENCE);
    assert_eq!(
        exit,
        Some(TerminalExit {
            code: Some(7),
            signal: None
        })
    );
    assert_eq!(terminal.try_exit(), exit, "the ending is readable, not reported twice");
    assert!(terminal.is_finished());

    // A terminal that has ended refuses what a terminal can no longer do, rather than accepting
    // it and dropping it: the reader is owed the difference between "sent" and "nobody is there".
    terminal.write("hello").expect_err("writing to a dead child");
    assert_eq!(
        terminal
            .write("hello")
            .expect_err("writing to a dead child")
            .code(),
        "terminal-ended"
    );
    assert_eq!(
        terminal
            .resize(TerminalSize::new(90, 30))
            .expect_err("resizing a dead tty")
            .code(),
        "terminal-ended"
    );
    assert_eq!(terminal.close(), exit, "closing an ended terminal is idempotent");

    let (terminal, events) = opened(launch(program("false"), &[], &dir));
    let (_, exit) = read_until(&events, |_| false, PATIENCE);
    assert_eq!(
        exit,
        Some(TerminalExit {
            code: Some(1),
            signal: None
        })
    );
    let _ = terminal.close();
}
