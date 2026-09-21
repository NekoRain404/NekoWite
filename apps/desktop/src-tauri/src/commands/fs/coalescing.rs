//! Burst bookkeeping for the folder watcher: when an event should be forwarded now, and which held
//! events have gone quiet and must be flushed.
//!
//! **This file was split out of `commands/fs.rs`**, and out of the watcher that was extracted
//! beside it. One subject: the pure decision about a burst — no watcher, no Tauri handle, no I/O,
//! which is what makes it testable without starting one. It changes when the coalescing rule
//! changes, and not when `notify`'s callback shape or the watcher's lifecycle does.
//!
//! The rule it implements, in one sentence: the first event for a path is forwarded immediately,
//! and anything that follows inside the window is HELD rather than dropped, because the last write
//! in a burst is the one whose content is on disk. The long comment on [`should_emit_change`] is
//! why the leading-edge version was wrong, and it survives the move verbatim.

use std::collections::HashMap;
use std::time::Instant;

/// How long a quiet period must last before a burst is considered over.
pub(super) const COALESCE_WINDOW: std::time::Duration = std::time::Duration::from_millis(150);

/// Whether an event that already arrived for a pending burst should be
/// forwarded, i.e. whether this path should be reported NOW.
///
/// The previous version of this was leading-edge — it forwarded the first event
/// and dropped everything for the same path and kind inside the window, without
/// refreshing the timestamp. That silently discarded the *later* half of a burst,
/// and the later half is the one that matters: two external writes 50 ms apart
/// produced one event for the content in between, so an open note reloaded to a
/// state that was already stale and then nothing ever arrived to correct it —
/// until the user saved, overwriting the newer external text with the stale copy.
///
/// Now the first event is forwarded immediately (so a single edit is still
/// instant) and any follow-up within the window is *held* — the caller re-emits
/// it after the burst goes quiet, which means the last state always reaches
/// subscribers.
pub(super) fn should_emit_change(
    last: Option<&(String, Instant)>,
    kind: &str,
    now: Instant,
) -> bool {
    match last {
        Some((last_kind, at)) => last_kind != kind || now.duration_since(*at) >= COALESCE_WINDOW,
        None => true,
    }
}

/// A burst awaiting its trailing edge: the event to re-emit once the burst goes
/// quiet, and when that quiet period started.
pub(super) struct PendingBurst {
    pub(super) kind: String,
    pub(super) at: Instant,
}

/// Pull every burst that has been quiet for [`COALESCE_WINDOW`].
pub(super) fn take_settled_pending(
    pending: &mut HashMap<String, PendingBurst>,
    now: Instant,
) -> Vec<(String, PendingBurst)> {
    let keys: Vec<String> = pending
        .iter()
        .filter(|(_, p)| now.duration_since(p.at) >= COALESCE_WINDOW)
        .map(|(k, _)| k.clone())
        .collect();
    keys.into_iter()
        .filter_map(|k| pending.remove(&k).map(|p| (k, p)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        should_emit_change, take_settled_pending, HashMap, Instant, PendingBurst, COALESCE_WINDOW,
    };

    fn last(kind: &str, at: Instant) -> (String, Instant) {
        (kind.to_string(), at)
    }

    #[test]
    fn first_event_for_a_path_is_always_forwarded() {
        assert!(should_emit_change(None, "modified", Instant::now()));
    }

    #[test]
    fn the_duplicate_notify_delivers_for_one_write_is_dropped() {
        // Windows reports a single write as two identical `modified` events.
        let t0 = Instant::now();
        let previous = last("modified", t0);
        assert!(!should_emit_change(
            Some(&previous),
            "modified",
            t0 + std::time::Duration::from_millis(1)
        ));
    }

    #[test]
    fn a_replacement_burst_still_reaches_subscribers() {
        // An atomic write is `removed` then `created`/`modified` for one path:
        // different kinds, so both are forwarded and the file is never left
        // looking deleted.
        let t0 = Instant::now();
        let removed = last("removed", t0);
        assert!(should_emit_change(
            Some(&removed),
            "created",
            t0 + std::time::Duration::from_millis(2)
        ));
    }

    #[test]
    fn the_same_kind_later_is_a_new_edit() {
        let t0 = Instant::now();
        let previous = last("modified", t0);
        assert!(should_emit_change(
            Some(&previous),
            "modified",
            t0 + COALESCE_WINDOW
        ));
    }

    #[test]
    fn take_settled_pending_emits_the_quiet_tail() {
        let t0 = Instant::now();
        let mut pending = HashMap::new();
        pending.insert(
            "a.md".into(),
            PendingBurst {
                kind: "modified".into(),
                at: t0,
            },
        );
        pending.insert(
            "b.md".into(),
            PendingBurst {
                kind: "created".into(),
                at: t0 + COALESCE_WINDOW,
            },
        );
        let settled = take_settled_pending(&mut pending, t0 + COALESCE_WINDOW);
        assert_eq!(settled.len(), 1);
        assert_eq!(settled[0].0, "a.md");
        assert_eq!(settled[0].1.kind, "modified");
        assert!(pending.contains_key("b.md"));
    }
}
