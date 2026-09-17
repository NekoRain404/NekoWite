//! Who is allowed to ask (§7.1's 「前端不能自选任意 label」).
//!
//! These tests forge labels deliberately: a forged label is exactly what a front end can send, and
//! `CallerWindow::from_window_label` is the same constructor the `#[tauri::command]` shim calls
//! with the label Tauri reported. What they establish is that forging gets you nothing — the
//! operation takes no window argument, so the only identity there is to present is the one the
//! windowing system already assigned.
//!
//! The two refusals §7.1 cares about are both here: the main window, which must never be reachable
//! from a pet-shaped request, and a sibling pet, which is a real label of a real window and is
//! still refused because it is not the window that called. §11's 权限 row asks for exactly this
//! (「桌宠窗口伪造授权/文件写入 IPC 被拒」), and the entry these tests drive is the authorization
//! entry rather than something behind it — there is no other way to close a window here.

use crate::desktop_pet::window_host::{Closed, HostRefusal, BALL_LABEL};
use crate::support::{caller, with_host, MAIN_WINDOW};

#[test]
fn a_pet_window_may_close_itself() {
    let (mut host, surfaces) = with_host();
    let instance = host.open("cat").expect("opens");

    let closed = host
        .close_own(&caller(instance.label.as_str()))
        .expect("a window may always close itself");

    assert_eq!(closed.label, instance.label);
    assert_eq!(closed.character_id, "cat");
    assert!(host.instances().is_empty());
    assert!(
        surfaces.live_characters().is_empty(),
        "the window outlived its close"
    );
}

/// The ball is a pet window and not a character window, and the two operations that act on *the
/// caller's own window* are refused for it by name.
///
/// This is the structural half of 「the ball is a stable click target」: §7.2 makes 鼠标穿透 a
/// property of a window, the pet's capability grants the permission to the pet's windows as a
/// group (`windows: ["pet-*"]` — the ball has to match it or hold no IPC at all), and what keeps
/// the ball from using it is that the host resolves a caller through the character registry, where
/// the ball has no entry. It cannot be hidden this way either: the ball's life is the feature
/// switch's, and a window that could close itself could be closed by a click.
#[test]
fn the_ball_may_not_close_itself_and_may_not_be_made_click_through() {
    let (mut host, surfaces) = with_host();
    let instance = host.open("cat").expect("opens");

    assert_eq!(
        host.close_own(&caller(BALL_LABEL)),
        Err(HostRefusal::UnrecognizedCaller {
            observed: BALL_LABEL.to_string()
        })
    );
    assert_eq!(
        host.set_click_through(&caller(BALL_LABEL), true),
        Err(HostRefusal::UnrecognizedCaller {
            observed: BALL_LABEL.to_string()
        })
    );
    assert!(
        surfaces.state().click_through.is_empty(),
        "the compositor was told"
    );
    assert_eq!(
        surfaces.live(),
        vec![BALL_LABEL.to_string(), instance.label.as_str().to_string()]
    );
}

#[test]
fn the_main_window_is_not_reachable_from_a_pet_shaped_request() {
    let (mut host, surfaces) = with_host();
    host.open("cat").expect("opens");

    // This is the request §7.1 forbids: a front end naming a window it does not own.
    assert_eq!(
        host.close_own(&caller(MAIN_WINDOW)),
        Err(HostRefusal::UnrecognizedCaller {
            observed: MAIN_WINDOW.to_string()
        })
    );
    assert_eq!(host.instances().len(), 1);
    assert_eq!(
        surfaces.live_characters().len(),
        1,
        "a window was closed anyway"
    );
}

#[test]
fn a_sibling_pet_window_cannot_be_closed_by_another_pet_window() {
    let (mut host, surfaces) = with_host();
    let first = host.open("one").expect("opens");
    let second = host.open("two").expect("opens");

    // `second` is a real label of a real pet window — the check is not "does this look like ours"
    // but "is this the window that called".
    assert_eq!(
        host.close_own(&caller(second.label.as_str())),
        Ok(Closed {
            label: second.label.clone(),
            character_id: "two".to_string(),
        })
    );
    assert_eq!(host.instances(), [first.clone()]);
    assert_eq!(
        surfaces.live_characters(),
        vec![first.label.as_str().to_string()]
    );
}

#[test]
fn a_label_from_a_closed_window_is_refused_rather_than_reused() {
    let (mut host, _) = with_host();
    let first = host.open("one").expect("opens");
    host.close_own(&caller(first.label.as_str()))
        .expect("closes itself");

    let second = host.open("two").expect("opens");

    // Upstream picked the lowest free index, so `second` would have taken `first`'s label and a
    // caller left over from the closed window would have been believed.
    assert_ne!(second.label, first.label);
    assert_eq!(
        host.close_own(&caller(first.label.as_str())),
        Err(HostRefusal::UnrecognizedCaller {
            observed: first.label.as_str().to_string()
        })
    );
    assert_eq!(host.instances().len(), 1);
}

#[test]
fn click_through_is_identity_checked_too() {
    let (mut host, surfaces) = with_host();
    let instance = host.open("cat").expect("opens");
    let label = instance.label.as_str().to_string();

    assert!(matches!(
        host.set_click_through(&caller(MAIN_WINDOW), true),
        Err(HostRefusal::UnrecognizedCaller { .. })
    ));
    assert!(surfaces.state().click_through.is_empty());

    host.set_click_through(&caller(&label), true)
        .expect("its own window");
    assert_eq!(surfaces.state().click_through.get(&label), Some(&true));
}
