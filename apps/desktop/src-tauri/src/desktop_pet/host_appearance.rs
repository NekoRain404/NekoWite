//! The *application's* own appearance, as the pet's windows are told it (§1's 「保留现有主题、强调色」).
//!
//! **Why this is a relay and not a read.** The app's theme, colour scheme, accent, contrast and body
//! size live in the main window's own store (`apps/desktop/src/stores/appearance.ts`), which a pet
//! window may not reach — §7.1's isolation, and `app/desktop-pet-entry.test.ts` fails on an import
//! graph that does. So the app *publishes* what it is drawing
//! (`desktop_pet_publish_host_appearance`, called by `app/pet-host-appearance-link.ts`), this module
//! holds it, and `desktop_pet_host_appearance` hands it to a window that asks. One publisher, one
//! holder, one reader: the value cannot disagree with itself, and nothing about the app's settings
//! crosses except these five fields.
//!
//! **Why a command and not an event.** §5.3's 「事件不能作为无需授权的配置写入口」: an event is
//! broadcast to whatever happens to be listening, while a command is authorised per window by the
//! ACL (`build.rs`'s manifest, `capabilities/default.json`). What is *pushed* afterwards is the
//! resulting value on `pet-host-appearance`, which is a read of state this module already holds.
//!
//! **What is validated here, and what deliberately is not.** A theme member this build does not know
//! becomes [`HostTheme::System`], because the alternative reaches a stylesheet as
//! `data-theme="something"` — a word no selector matches, which draws the light baseline and reports
//! a setting that worked. The two *names* (`colorScheme`, `accent`) are not checked against any
//! list: they are `palettes.css`'s member names, both pages load that stylesheet, and a name no rule
//! matches draws that axis's own default in either of them — so the app's window and the pet's agree
//! about a member this build has never heard of without this side carrying a second copy of the
//! palette's index. An empty string is not a name and takes the default. The body size is taken as
//! finite and otherwise left alone: its *range* is the app's own control's
//! (`apps/desktop/src/features/desktop-pet/services/pet-page-appearance.ts` clamps it against the
//! real setter in a test), and a second clamp here would be a second rule.
//!
//! Nothing here draws. The colours are `palettes.css`'s on both pages, and this module's whole job is
//! to remember which of them the app is using.

use serde::{Deserialize, Serialize};

/// The three members a theme setting can hold, spelled as the schema spells them.
///
/// The same three `message.theme` has (`settings/fields.rs`), and the same three the app's own
/// `appearance.theme` has (`stores/appearance-schema.ts`'s `Theme`): one vocabulary, three places
/// that read it, and one decision — which of the two palettes `palettes.css` declares is drawn.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HostTheme {
    /// Follow whatever decides it — the engine, on a page that has no other answer.
    System,
    Light,
    Dark,
}

impl HostTheme {
    /// The member the schema declares as the default, and therefore the reading of every value this
    /// build cannot act on. `system` is what a fresh install draws and what the pet followed before
    /// the app published anything; reading an unknown word as `light` would pin a theme the user
    /// never chose and reading it as `dark` would invent one.
    pub const DEFAULT: Self = Self::System;

    /// The member a published string names, or the default for anything else.
    pub fn of(value: Option<&str>) -> Self {
        match value {
            Some("light") => Self::Light,
            Some("dark") => Self::Dark,
            _ => Self::DEFAULT,
        }
    }

    /// The word `data-theme` is written with, which is also the wire's spelling.
    pub fn name(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
            Self::System => "system",
        }
    }
}

/// The body size an app that has published none is drawn at, in CSS pixels.
///
/// `stores/appearance-schema.ts`'s `APPEARANCE_DEFAULTS.bodyFontSize`, and it is also what
/// `tokens.css` declares on `:root` for a page no shell has mounted — so the pet window's own
/// constant is this number until the app says otherwise. Pinned against that file by the test below
/// rather than by this sentence.
pub const HOST_BODY_FONT_SIZE: f64 = 15.0;

/// The name `palettes.css` gives the colour scheme a fresh install draws in.
const DEFAULT_COLOR_SCHEME: &str = "default";
/// The name `palettes.css` gives the accent a fresh install draws in.
const DEFAULT_ACCENT: &str = "ink";

/// The application's own appearance, as the pet's windows are told it.
///
/// Five fields, and each one is an *axis* rather than a colour: the names go on the page root as
/// attributes and `palettes.css` decides what they come to (`features/desktop-pet/services/
/// pet-page-appearance.ts` on the TypeScript side is where the spelling lives).
#[derive(Clone, PartialEq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostAppearance {
    /// The app's theme setting — see [`HostTheme`].
    pub theme: HostTheme,
    /// `palettes.css`'s colour-scheme member (`default`, `sunset`, …).
    pub color_scheme: String,
    /// `palettes.css`'s accent member (`ink`, `coral`, …).
    pub accent: String,
    /// The accessibility axis: `data-contrast="high"` where the user asked for it.
    pub high_contrast: bool,
    /// The body size the app is drawn at, in CSS pixels (`AppShell.vue`'s `--app-body-size`).
    pub body_font_size: f64,
}

impl Default for HostAppearance {
    /// What a host that has been told nothing answers: the app's own defaults.
    ///
    /// Not a fourth opinion. On a fresh install the app draws `system`, the `default` scheme, the
    /// `ink` accent, normal contrast and 15px in its own window, and a pet that answered something
    /// else for "the app has not published yet" would be the one surface in this application that is
    /// not the app's appearance.
    fn default() -> Self {
        Self {
            theme: HostTheme::DEFAULT,
            color_scheme: DEFAULT_COLOR_SCHEME.to_string(),
            accent: DEFAULT_ACCENT.to_string(),
            high_contrast: false,
            body_font_size: HOST_BODY_FONT_SIZE,
        }
    }
}

impl HostAppearance {
    /// The appearance a published write means, field by field.
    ///
    /// See this module's header for what is checked and what is deliberately not. Every field takes
    /// a default rather than failing the publish: the app sends values its own store validated, so
    /// what reaches the second arm is a value from something that is not that store — a newer build,
    /// a hand-driven invoke — and refusing the *whole* appearance for one of five fields would take
    /// the four good axes down with it.
    pub fn of(write: HostAppearanceWrite) -> Self {
        Self {
            theme: HostTheme::of(write.theme.as_deref()),
            color_scheme: name_or_default(write.color_scheme, DEFAULT_COLOR_SCHEME),
            accent: name_or_default(write.accent, DEFAULT_ACCENT),
            high_contrast: write.high_contrast == Some(true),
            body_font_size: write
                .body_font_size
                .filter(|size| size.is_finite())
                .unwrap_or(HOST_BODY_FONT_SIZE),
        }
    }
}

/// What the app window publishes.
///
/// Every field optional, so a partial payload is a partial update of a value nobody has published
/// yet rather than a rejected call: the app always sends all five, and a caller that sends fewer is
/// describing what it knows.
#[derive(Clone, PartialEq, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostAppearanceWrite {
    pub theme: Option<String>,
    pub color_scheme: Option<String>,
    pub accent: Option<String>,
    pub high_contrast: Option<bool>,
    pub body_font_size: Option<f64>,
}

/// The app's appearance, as the process holds it: what was published last, or the defaults.
///
/// One value for the process (§7.1 has one main window, and one appearance), the same "one for the
/// process" arrangement the care ledger and the task feed have. It lives on `DesktopPetState` — the
/// pet's whole backend — and not in a `static`, so a test builds its own instead of sharing one with
/// every other test in the binary.
#[derive(Debug, Default)]
pub struct HostAppearanceRelay {
    value: HostAppearance,
}

impl HostAppearanceRelay {
    /// A relay nothing has published to: the app's own defaults — see [`HostAppearance::default`].
    pub fn new() -> Self {
        Self::default()
    }

    /// Take one published appearance, and answer with what is now held.
    ///
    /// The normalised value is returned so the caller can relay *that* rather than the raw write:
    /// a window must never be handed a value the relay would not answer with, or the pushed value
    /// and the read would be two answers to one question.
    pub fn publish(&mut self, write: HostAppearanceWrite) -> HostAppearance {
        self.value = HostAppearance::of(write);
        self.value.clone()
    }

    /// What the app last published, or the defaults.
    pub fn current(&self) -> HostAppearance {
        self.value.clone()
    }
}

/// A palette member as a name, or the default where the write carries nothing a name can be made of.
fn name_or_default(value: Option<String>, fallback: &str) -> String {
    match value {
        Some(name) if !name.is_empty() => name,
        _ => fallback.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The defaults this module answers with, taken from the app's own schema document rather than
    /// from this file's idea of them. A default that moves on the app's side and not here would
    /// otherwise draw the pet in last year's appearance, silently, on every install that had not
    /// published an appearance yet.
    #[test]
    fn the_defaults_are_the_ones_the_apps_schema_declares() {
        let schema = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../src/stores/appearance-schema.ts"),
        )
        .expect("the app's appearance schema is part of this contract");
        // The *document* and not the interface beside it: the two declare the same field names, and
        // the first `theme:` in the file is the type's.
        let document = schema
            .split("APPEARANCE_DEFAULTS: AppearanceSettings = {")
            .nth(1)
            .and_then(|rest| rest.split('}').next())
            .expect("the schema declares its defaults");
        let defaults = HostAppearance::default();

        for (field, want) in [
            ("theme:", format!("'{}'", defaults.theme.name())),
            ("colorScheme:", format!("'{}'", defaults.color_scheme)),
            ("accent:", format!("'{}'", defaults.accent)),
            ("bodyFontSize:", defaults.body_font_size.to_string()),
        ] {
            let line = document
                .lines()
                .find(|line| line.trim_start().starts_with(field))
                .unwrap_or_else(|| panic!("the schema declares {field}"));
            assert!(
                line.contains(&want),
                "the app's {field} is {want}, and the schema says: {line}"
            );
        }
        assert!(
            document.lines().any(
                |line| line.trim_start().starts_with("highContrast:") && line.contains("false")
            ),
            "high contrast is off in the schema's defaults"
        );
    }

    #[test]
    fn a_relay_nobody_has_published_to_answers_the_apps_defaults() {
        let relay = HostAppearanceRelay::new();
        assert_eq!(relay.current(), HostAppearance::default());
        assert_eq!(relay.current().theme, HostTheme::System);
        assert_eq!(relay.current().color_scheme, "default");
        assert_eq!(relay.current().accent, "ink");
        assert!(!relay.current().high_contrast);
        assert_eq!(relay.current().body_font_size, 15.0);
    }

    #[test]
    fn every_axis_a_publish_carries_is_kept() {
        let mut relay = HostAppearanceRelay::new();
        let held = relay.publish(HostAppearanceWrite {
            theme: Some("dark".to_string()),
            color_scheme: Some("sunset".to_string()),
            accent: Some("coral".to_string()),
            high_contrast: Some(true),
            body_font_size: Some(17.5),
        });
        assert_eq!(
            held,
            HostAppearance {
                theme: HostTheme::Dark,
                color_scheme: "sunset".to_string(),
                accent: "coral".to_string(),
                high_contrast: true,
                body_font_size: 17.5,
            }
        );
        assert_eq!(relay.current(), held);
    }

    #[test]
    fn the_theme_members_are_the_three_the_schema_has() {
        assert_eq!(HostTheme::of(Some("light")), HostTheme::Light);
        assert_eq!(HostTheme::of(Some("dark")), HostTheme::Dark);
        assert_eq!(HostTheme::of(Some("system")), HostTheme::System);
        assert_eq!(HostTheme::name(HostTheme::Light), "light");
        assert_eq!(HostTheme::name(HostTheme::Dark), "dark");
        assert_eq!(HostTheme::name(HostTheme::System), "system");
    }

    /// A member this build cannot act on is the *default*, never a word that reaches a stylesheet.
    ///
    /// `data-theme="solarized"` matches no block in `palettes.css`, so it draws the light baseline
    /// and reports a setting that worked — which is the defect the whole theme rule exists to keep
    /// out, one layer up.
    #[test]
    fn a_theme_this_build_does_not_know_is_the_default() {
        assert_eq!(HostTheme::of(Some("solarized")), HostTheme::System);
        assert_eq!(HostTheme::of(Some("")), HostTheme::System);
        assert_eq!(HostTheme::of(None), HostTheme::System);
    }

    /// The two names cross unread — `palettes.css` is the table they belong to, on both pages.
    ///
    /// What is refused is a value that is not a name at all: an empty string would be written as
    /// `data-accent=""`, which matches the bare `[data-accent]` half of the dark-mode soft-accent
    /// rule and nothing else — a present attribute meaning nothing.
    #[test]
    fn the_palette_names_cross_unread_and_an_empty_one_is_the_default() {
        let mut relay = HostAppearanceRelay::new();
        let held = relay.publish(HostAppearanceWrite {
            color_scheme: Some("a-scheme-a-newer-build-added".to_string()),
            accent: Some(String::new()),
            ..HostAppearanceWrite::default()
        });
        assert_eq!(held.color_scheme, "a-scheme-a-newer-build-added");
        assert_eq!(held.accent, "ink");
        assert_eq!(
            HostAppearance::of(HostAppearanceWrite {
                color_scheme: None,
                ..HostAppearanceWrite::default()
            })
            .color_scheme,
            "default"
        );
    }

    #[test]
    fn a_size_that_is_not_a_number_is_the_default_and_a_fraction_is_kept() {
        let mut relay = HostAppearanceRelay::new();
        for size in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let held = relay.publish(HostAppearanceWrite {
                body_font_size: Some(size),
                ..HostAppearanceWrite::default()
            });
            assert_eq!(held.body_font_size, HOST_BODY_FONT_SIZE);
        }
        // The range belongs to the app's own control, and the page clamps it against the real setter
        // (`pet-page-appearance.ts`'s `PET_PAGE_BODY_SIZE`); a second clamp here would be a second
        // rule, and a fraction is a size a stylesheet can hold.
        let held = relay.publish(HostAppearanceWrite {
            body_font_size: Some(13.5),
            ..HostAppearanceWrite::default()
        });
        assert_eq!(held.body_font_size, 13.5);
    }

    #[test]
    fn a_write_that_names_no_axis_leaves_none_of_the_defaults_behind_a_stale_value() {
        // The second publish replaces the first: this is a value, not a set of overrides, and a
        // window that read "the accent the app is using" must never be handed one from an earlier
        // publish that this one did not mention.
        let mut relay = HostAppearanceRelay::new();
        relay.publish(HostAppearanceWrite {
            accent: Some("coral".to_string()),
            high_contrast: Some(true),
            ..HostAppearanceWrite::default()
        });
        let held = relay.publish(HostAppearanceWrite::default());
        assert_eq!(held, HostAppearance::default());
    }
}
