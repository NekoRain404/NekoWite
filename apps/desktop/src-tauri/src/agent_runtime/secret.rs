//! The one value this host must never print.
//!
//! A credential is a type rather than a discipline, and this file is where that type lives. It is
//! here rather than beside the file that stores credentials (`profile.rs`) or the struct that hands
//! them to a process (`process::EngineLaunch`) because *both* need it, and a type either of them
//! owned would make one depend on the other: the launch environment is built out of a definition
//! *and* a profile, so "this may not be printed" is a property they share rather than a property of
//! either one.
//!
//! §8.1 asks for it (「凭据不出现在命令行参数与诊断日志」) and P0 §3 says where a credential travels
//! (the environment; `/proc/<pid>/cmdline` is world-readable, so never `argv`). What this module
//! adds is the mechanism: a value with no `Display`, no `Serialize` and a hand-written `Debug` that
//! prints a placeholder — so a struct that derives `Debug` and holds one *cannot* print it, and the
//! mistake is unrepresentable rather than documented.
//!
//! `EngineLaunch` is the struct that made this necessary. T3a found it deriving `Debug` while its
//! `env` was a `Vec<(String, String)>`: the type was printable, so no impl and no comment could
//! have stopped a `{:?}` of a launch from writing a provider key into a log the moment T12's
//! profiles started injecting one. The field is a [`Secret`] now, and the derive it kept is safe.

use std::fmt;

/// A value that must never reach a log line, a report or an error message.
///
/// The protection is the type rather than discipline: `Debug` prints the placeholder, and there is
/// no `Display`, no `Serialize` and no accessor except [`Secret::expose`], which is called by name
/// where the value is genuinely needed — the launch environment, the credential file this host
/// writes, and the redactor that removes the value from the engine's own stderr.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The value itself. Every caller of this is a possible leak, which is why there are only a
    /// few and each one is stated at [`Secret`] and at the call site.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("\"<redacted>\"")
    }
}

#[cfg(test)]
mod tests {
    use super::Secret;

    /// A neighbouring struct's *derived* `Debug` must be enough. That is the whole claim of this
    /// module, and it is the one a hand-written `Debug` somewhere else cannot make: a wrapper
    /// somebody adds next year derives its own and inherits this.
    #[test]
    fn a_struct_that_derives_debug_cannot_print_a_secret_it_holds() {
        #[derive(Debug)]
        struct Launchish {
            name: String,
            env: Vec<(String, Secret)>,
        }
        let launch = Launchish {
            name: "opencode".to_string(),
            env: vec![(
                "ANTHROPIC_API_KEY".to_string(),
                Secret::new("sk-ant-oat01-not-a-real-key"),
            )],
        };
        assert_eq!(launch.name, "opencode");
        assert_eq!(launch.env.len(), 1);
        assert_eq!(launch.env[0].0, "ANTHROPIC_API_KEY");
        let printed = format!("{launch:?}");
        assert!(
            !printed.contains("sk-ant-oat01-not-a-real-key"),
            "a derive printed a credential: {printed}"
        );
        // The name is kept: which providers are configured is a fact about the setup, and hiding
        // it would make the line useless for the diagnostics it exists for.
        assert!(printed.contains("ANTHROPIC_API_KEY"), "{printed}");
        assert!(printed.contains("<redacted>"), "{printed}");
    }
}
