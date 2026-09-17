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
    BALL_LABEL,
};

/// The window the app already has, used as the forged caller every identity test tries first.
pub const MAIN_WINDOW: &str = "main";

/// One call to open, kept whole so the presentation can be asserted after the fact.
#[derive(Clone, PartialEq, Debug)]
pub struct OpenCall {
    pub label: String,
    pub page: String,
    pub at: Placement,
    /// The size the host asked for, kept so the ball's 80x80 and the character's 260x320 can be
    /// told apart after the fact — they are the two numbers that make the ball the reference's
    /// surface rather than a second character window.
    pub size: (f64, f64),
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
        self.state
            .lock()
            .expect("the fake's lock is never held across a panic")
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

    /// The opens that are not the ball's.
    ///
    /// The ball comes up with the pet (`PetWindowHost::open`), so a case whose subject is a
    /// character window counts these rather than `opened()`: the ball's own open is real, and
    /// {@link Self::ball_call} is where it is asserted about.
    pub fn character_opens(&self) -> Vec<OpenCall> {
        self.opened()
            .into_iter()
            .filter(|call| call.label != BALL_LABEL)
            .collect()
    }

    /// The character window opened last. The ball's open is the first one of every enable, so
    /// `last_open` would be the character's too — this says so rather than depending on it.
    pub fn last_character_open(&self) -> OpenCall {
        self.character_opens()
            .pop()
            .expect("no character window was opened")
    }

    /// The ball's open call, which is the first one of the enable that brought the pet up.
    pub fn ball_call(&self) -> OpenCall {
        self.opened()
            .into_iter()
            .find(|call| call.label == BALL_LABEL)
            .expect("the ball was never opened")
    }

    /// The live windows that are not the ball's.
    pub fn live_characters(&self) -> Vec<String> {
        self.live()
            .into_iter()
            .filter(|label| label != BALL_LABEL)
            .collect()
    }
}

impl PetSurfaces for FakeSurfaces {
    fn open(
        &mut self,
        label: &PetWindowLabel,
        page: &str,
        at: Placement,
        size: (f64, f64),
        style: WindowStyle,
        visible: bool,
    ) -> Result<(), String> {
        let mut state = self.state();
        state.opened.push(OpenCall {
            label: label.as_str().to_string(),
            page: page.to_string(),
            at,
            size,
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
        host.open(&format!("character-{index}"))
            .expect("within the cap");
    }
}
