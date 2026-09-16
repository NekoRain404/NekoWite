//! A window system that is not one.
//!
//! `window_host.rs` takes its windowing through a port (§10.2), so the host's rules — the cap, the
//! labels, who may close what — can be exercised with no compositor in sight. This is that port,
//! backed by lists, plus the two helpers the domain files share.
//!
//! It is `Arc<Mutex<_>>` rather than `Rc<RefCell<_>>` because `PetSurfaces` is `Send`: what a test
//! may substitute has to be at least what the real adapter is, or the substitution would be
//! testing a shape the product does not have.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use crate::desktop_pet::window_host::{
    CallerWindow, PetSurfaces, PetWindowHost, PetWindowLabel, Placement, WindowStyle, WorkArea,
};

/// The window the app already has, used as the forged caller every identity test tries first.
pub const MAIN_WINDOW: &str = "main";

/// One call to open, kept whole so the presentation can be asserted after the fact.
#[derive(Clone, PartialEq, Debug)]
pub struct OpenCall {
    pub label: String,
    pub page: String,
    pub at: Placement,
    pub style: WindowStyle,
    pub visible: bool,
}

#[derive(Default)]
pub struct SurfaceState {
    pub opened: Vec<OpenCall>,
    pub live: Vec<String>,
    pub hidden: BTreeMap<String, bool>,
    pub click_through: BTreeMap<String, bool>,
    pub closed: Vec<String>,
    /// Labels the window system refuses to close, so the host's handling of a real failure has a
    /// way to be reached without inventing one.
    pub refuse_close: Vec<String>,
    pub work_area: Option<WorkArea>,
}

#[derive(Clone, Default)]
pub struct FakeSurfaces {
    state: Arc<Mutex<SurfaceState>>,
}

impl FakeSurfaces {
    /// A fake with a screen, so that the cascade has something to clamp into.
    pub fn new() -> Self {
        let fake = Self::default();
        fake.state.lock().expect("lock").work_area = Some(WorkArea {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        });
        fake
    }

    pub fn state(&self) -> std::sync::MutexGuard<'_, SurfaceState> {
        self.state.lock().expect("the fake's lock is never held across a panic")
    }

    pub fn live(&self) -> Vec<String> {
        self.state().live.clone()
    }

    pub fn opened(&self) -> Vec<OpenCall> {
        self.state().opened.clone()
    }

    pub fn last_open(&self) -> OpenCall {
        self.opened().pop().expect("no window was opened")
    }
}

impl PetSurfaces for FakeSurfaces {
    fn open(
        &mut self,
        label: &PetWindowLabel,
        page: &str,
        at: Placement,
        style: WindowStyle,
        visible: bool,
    ) -> Result<(), String> {
        let mut state = self.state();
        state.opened.push(OpenCall {
            label: label.as_str().to_string(),
            page: page.to_string(),
            at,
            style,
            visible,
        });
        state.live.push(label.as_str().to_string());
        state.hidden.insert(label.as_str().to_string(), !visible);
        Ok(())
    }

    fn close(&mut self, label: &PetWindowLabel) -> Result<(), String> {
        let mut state = self.state();
        if state.refuse_close.contains(&label.as_str().to_string()) {
            return Err("the compositor declined".to_string());
        }
        state.live.retain(|live| live != label.as_str());
        state.closed.push(label.as_str().to_string());
        Ok(())
    }

    fn set_visible(&mut self, label: &PetWindowLabel, visible: bool) -> Result<(), String> {
        self.state()
            .hidden
            .insert(label.as_str().to_string(), !visible);
        Ok(())
    }

    fn set_click_through(&mut self, label: &PetWindowLabel, ignore: bool) -> Result<(), String> {
        self.state()
            .click_through
            .insert(label.as_str().to_string(), ignore);
        Ok(())
    }

    fn work_area(&self) -> Option<WorkArea> {
        self.state().work_area
    }
}

/// A host with a fake behind it, and the fake, so a test can read what the host asked for.
pub fn with_host() -> (PetWindowHost, FakeSurfaces) {
    let surfaces = FakeSurfaces::new();
    (PetWindowHost::new(Box::new(surfaces.clone())), surfaces)
}

pub fn caller(label: &str) -> CallerWindow {
    CallerWindow::from_window_label(label)
}

/// Fill the host with `count` characters, so a cap test is about the cap and not about names.
pub fn fill(host: &mut PetWindowHost, count: usize) {
    for index in 0..count {
        host.open(&format!("character-{index}")).expect("within the cap");
    }
}
