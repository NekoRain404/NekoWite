//! Teardown: that shutdown takes the process group with it, and that it gives the engine its own
//! exit first.
//!
//! §6.2's order — 「先正常取消/退出再限时终止」 — is the whole of this file: closing the connection
//! closes the child's stdin and the child is expected to finish on its own, with the group kill as
//! the timed fallback rather than the first move. The two pid helpers are here rather than in
//! `support.rs` because nothing outside this file asks whether a process is still there.

use std::fs;
use std::path::Path;
use std::time::Duration;

use crate::support::{fixture, start, temp_dir, PATIENCE};

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

#[tokio::test]
async fn shutdown_takes_the_whole_process_group_with_it() {
    // The fixture forks a grandchild that sleeps — a stand-in for the tool
    // subprocesses the engine leaves behind. Killing only the process we were
    // handed leaves that grandchild running after the app closes, which §6.2
    // forbids; the group kill the SDK performs is what prevents it.
    let capture = temp_dir("tree").join("capture");
    let (runtime, _events) = start(&fixture("tree", Some(&capture))).await;
    // No initialize: this behaviour never answers one, and the point is the
    // process tree it leaves behind.
    let pids = wait_for_pids(&capture).await;

    runtime.shutdown();
    // The kill happens during the transport's drop, on the connection task; the
    // processes need a moment to actually disappear.
    let gone = wait_until_gone(&pids).await;

    assert!(gone, "these processes outlived shutdown: {pids:?}");
}

#[tokio::test]
async fn shutdown_gives_the_engine_time_to_exit_on_its_own() {
    // §6.2 asks for 「先正常取消/退出再限时终止」 — a normal exit first, a timed
    // termination only if that fails. Closing the connection closes the child's
    // stdin, and this fixture then behaves like an engine finishing a write:
    // it waits, records that it got there, and exits by itself.
    //
    // The record is the measurement. If the group were killed the instant the
    // connection dropped — which is what I first reported, from reading
    // `ChildGuard` alone — this file would never be written.
    let capture = temp_dir("grace").join("capture");
    let (runtime, _events) = start(&fixture("slow-exit", Some(&capture))).await;
    runtime.initialize().await.expect("initialize");

    runtime.shutdown();

    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let recorded = fs::read_to_string(&capture).unwrap_or_default();
        if recorded.contains("exited-cleanly=yes") {
            assert!(recorded.contains("eof-seen=yes"), "EOF must arrive first");
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the engine was killed before it could exit on its own: {recorded:?}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Waits for the fixture to report its own pid and its child's.
async fn wait_for_pids(capture: &Path) -> Vec<i32> {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        if let Ok(recorded) = fs::read_to_string(capture) {
            let pids: Vec<i32> = recorded
                .lines()
                .filter_map(|line| {
                    line.strip_prefix("pid=")
                        .or_else(|| line.strip_prefix("child="))
                        .and_then(|value| value.trim().parse().ok())
                })
                .collect();
            if pids.len() == 2 {
                return pids;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the fixture never reported its process tree"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Whether every pid is gone. `kill -0` only asks the kernel; nothing here
/// signals anything, because these pids are evidence, not targets.
async fn wait_until_gone(pids: &[i32]) -> bool {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let alive = pids
            .iter()
            .any(|pid| Path::new(&format!("/proc/{pid}")).exists());
        if !alive {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
