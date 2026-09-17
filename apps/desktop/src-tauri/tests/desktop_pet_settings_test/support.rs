//! The fixtures the behaviour files share: a store in a temporary directory, a window system that
//! is not one, and the two readers that pull the TypeScript schema off disk.
//!
//! The window system is here rather than in `switch.rs` alone because a store test needs it too:
//! what the enable path does to a window is one of the things a settings record decides, and
//! asserting it against a fake is the only way to see it without a compositor.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use nekowite_lib::desktop_pet::window_host::{
    PetSurfaces, PetWindowHost, PetWindowLabel, Placement, WindowStyle, WorkArea, BALL_LABEL,
};
use nekowite_lib::desktop_pet::PetSettingsStore;

/// A store root nothing else in the process is using.
///
/// Removed first and named after the test, so a leftover from a killed run cannot make the next one
/// pass — the convention `desktop_pet_resources_test/support.rs` established for the same reason.
pub fn store(label: &str) -> (PetSettingsStore, PathBuf) {
    let data =
        std::env::temp_dir().join(format!("nkw-pet-settings-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).expect("a temporary data directory");
    let store = PetSettingsStore::new(&data).expect("an absolute data directory is in scope");
    (store, data)
}

/// The TypeScript file the values and record rules are a mirror of.
pub fn pet_contract_source(relative: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path:?}: {error}"))
}

/// The source of `pet-contracts/config.ts`, which declares the schema this side mirrors.
pub fn config_contract() -> String {
    pet_contract_source("../src/platform/gateways/pet-contracts/config.ts")
}

/// The source of `pet-settings-values.ts`, which declares the problem vocabulary.
pub fn values_contract() -> String {
    pet_contract_source("../src/features/desktop-pet-settings/services/pet-settings-values.ts")
}

/// The text between two markers, or a panic naming the marker that moved.
///
/// A marker that is not found is a failure and not an empty slice: a test that silently compared
/// nothing with nothing would pass on the day the other side renamed its declaration, which is the
/// one day it has something to say.
pub fn slice_between<'a>(text: &'a str, from: &str, to: &str) -> &'a str {
    let start = text
        .find(from)
        .unwrap_or_else(|| panic!("{from:?} is not in the file"))
        + from.len();
    let rest = &text[start..];
    let end = rest
        .find(to)
        .unwrap_or_else(|| panic!("{to:?} is not after {from:?}"));
    &rest[..end]
}

/// Every `'…'`-quoted string in a slice, as written.
pub fn quoted(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('\'') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('\'') else { break };
        found.push(after[..close].to_string());
        rest = &after[close + 1..];
    }
    found
}

/// Whether a line is a comment, so a block of them can be dropped before it is parsed.
pub fn is_comment(line: &str) -> bool {
    line.trim_start().starts_with("//")
}

/// A window system that records what it was asked to do and refuses nothing.
///
/// `window_host.rs` takes its windowing through a port, so the enable path's effect on the windows
/// can be asserted without a compositor. This is that port, backed by lists; it is the smallest
/// shape the host needs, and `desktop_pet_ipc_test/support.rs` has the fuller one D12's command
/// tests use.
#[derive(Clone, Default)]
pub struct FakeSurfaces {
    state: Arc<Mutex<SurfaceState>>,
}

#[derive(Default)]
pub struct SurfaceState {
    /// Every window opened, as (label, page).
    pub opened: Vec<(String, String)>,
    /// The size every window was opened at, as (label, size), in the same order. Kept apart from
    /// `opened` rather than widening its pair: the page a window loads and the number it was built
    /// at are different claims, and every existing case about the first should not have to destructure
    /// the second.
    pub opened_at: Vec<(String, (f64, f64))>,
    pub live: Vec<String>,
    pub closed: Vec<String>,
    /// The presentation each window was opened with, by label. Kept because one of its flags is a
    /// setting (`view.alwaysOnTop`), and what a case has to be able to assert is the flag the host
    /// *asked for* rather than the one this file assumed.
    pub styles: std::collections::BTreeMap<String, WindowStyle>,
    /// Every always-on-top change, as (label, value) in the order they were asked for.
    pub on_top: Vec<(String, bool)>,
    /// Labels this fake refuses to restack, so the host's handling of a real refusal is reachable.
    pub refuse_on_top: Vec<String>,
    /// Every resize, as (label, size) in the order they were asked for. A size setting reaches a
    /// window that is already open through this call and no other, so what a case asserts about
    /// `character.size` or `general.ballSize` is this list.
    pub resized: Vec<(String, (f64, f64))>,
    /// Labels this fake refuses to resize, the way `refuse_on_top` refuses a restack.
    pub refuse_resize: Vec<String>,
}

impl FakeSurfaces {
    /// A fake with a screen, so the cascade has something to clamp into.
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> std::sync::MutexGuard<'_, SurfaceState> {
        self.state
            .lock()
            .expect("the fake's lock is never held across a panic")
    }

    pub fn opened(&self) -> Vec<(String, String)> {
        self.state().opened.clone()
    }

    /// The opens that are not the ball's.
    ///
    /// The ball comes up with the pet (`PetWindowHost::open`), so a case about the character
    /// window counts these; {@link Self::ball_open} is the ball's own.
    pub fn character_opens(&self) -> Vec<(String, String)> {
        self.opened()
            .into_iter()
            .filter(|(label, _)| label != BALL_LABEL)
            .collect()
    }

    /// The ball's open call, or `None` when the pet came up without one.
    pub fn ball_open(&self) -> Option<(String, String)> {
        self.opened()
            .into_iter()
            .find(|(label, _)| label == BALL_LABEL)
    }

    pub fn live(&self) -> Vec<String> {
        self.state().live.clone()
    }

    /// Every always-on-top change the host asked for, in order.
    pub fn on_top_changes(&self) -> Vec<(String, bool)> {
        self.state().on_top.clone()
    }

    /// The presentation one window was opened with, or `None` when it was never opened.
    pub fn style_of(&self, label: &str) -> Option<WindowStyle> {
        self.state().styles.get(label).copied()
    }

    /// Every resize the host asked for, in order.
    pub fn resizes(&self) -> Vec<(String, (f64, f64))> {
        self.state().resized.clone()
    }

    /// The size one window was opened at, or `None` when it was never opened. The last one wins: a
    /// label is never reused by the host (`window_host.rs`'s header), so this is a fact about one
    /// window rather than about an ordering.
    pub fn size_of(&self, label: &str) -> Option<(f64, f64)> {
        self.state()
            .opened_at
            .iter()
            .filter(|(opened, _)| opened == label)
            .next_back()
            .map(|(_, size)| *size)
    }
}

impl PetSurfaces for FakeSurfaces {
    fn open(
        &mut self,
        label: &PetWindowLabel,
        page: &str,
        _at: Placement,
        size: (f64, f64),
        style: WindowStyle,
        _visible: bool,
    ) -> Result<(), String> {
        let mut state = self.state();
        state
            .opened
            .push((label.as_str().to_string(), page.to_string()));
        state.opened_at.push((label.as_str().to_string(), size));
        state.live.push(label.as_str().to_string());
        state.styles.insert(label.as_str().to_string(), style);
        Ok(())
    }

    fn close(&mut self, label: &PetWindowLabel) -> Result<(), String> {
        let mut state = self.state();
        state.closed.push(label.as_str().to_string());
        state.live.retain(|live| live != label.as_str());
        Ok(())
    }

    fn resize(&mut self, label: &PetWindowLabel, size: (f64, f64)) -> Result<(), String> {
        let mut state = self.state();
        if state.refuse_resize.contains(&label.as_str().to_string()) {
            return Err("the compositor declined".to_string());
        }
        // The windows this fake believes are live, so that a resize of a window that is not open
        // through the host is visible as such rather than counted. Nothing here refuses for it —
        // the host is what keeps from asking, and a fake that refused too would hide a host that
        // asked about a window it had already closed.
        state.resized.push((label.as_str().to_string(), size));
        Ok(())
    }

    fn set_visible(&mut self, _label: &PetWindowLabel, _visible: bool) -> Result<(), String> {
        Ok(())
    }

    fn set_click_through(&mut self, _label: &PetWindowLabel, _ignore: bool) -> Result<(), String> {
        Ok(())
    }

    fn set_always_on_top(&mut self, label: &PetWindowLabel, on_top: bool) -> Result<(), String> {
        let mut state = self.state();
        if state.refuse_on_top.contains(&label.as_str().to_string()) {
            return Err("the compositor declined".to_string());
        }
        state.on_top.push((label.as_str().to_string(), on_top));
        Ok(())
    }

    /// `None`, the way §7.2 wants it: a monitor that cannot be read is not replaced by a size
    /// somebody guessed. The host clamps nothing into a work area it does not have, which is the
    /// arm the tests below exercise.
    fn work_area(&self) -> Option<WorkArea> {
        None
    }
}

/// A host over a fake, and the fake to ask afterwards.
pub fn host() -> (PetWindowHost, FakeSurfaces) {
    let surfaces = FakeSurfaces::new();
    (PetWindowHost::new(Box::new(surfaces.clone())), surfaces)
}
