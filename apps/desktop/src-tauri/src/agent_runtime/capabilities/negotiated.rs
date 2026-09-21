//! What one runtime incarnation has been told about one session, and the questions that can be
//! asked of it.
//!
//! **Why it is a file of its own.** It was the middle of `capabilities.rs`, which passed the
//! 600-line budget `docs/dev.md:286` puts on a business source file. The split is by *reason to
//! change*, which is the criterion that section states rather than the line count: this module
//! moves when the *session-scoped* negotiation moves — a field `session/new` starts or stops
//! returning, the published command list's shape, or one of the predicates derived from Zed's
//! `SessionCapabilities` — while `super::handshake` moves when the `initialize` reply does and
//! `super` moves when the report a window reads does. None of the three changes for another's
//! reason.
//!
//! **Nothing here is derived-and-stored.** Every predicate below reads a fact the engine sent, so
//! the answer cannot drift from what the engine said; that is why the two response readings
//! ([`SessionFacts`]) sit in the same file as the questions asked of them rather than in the report
//! that renders the answers.
//!
//! **The third state is the point.** "The handshake has not been read" and "the handshake reported
//! nothing" are different facts, so each group is optional, every predicate answers `None` before
//! its field exists, and `Some(false)` is the engine saying no. Both types keep the paths they had
//! before the split — the parent re-exports them.

use agent_client_protocol::schema::v1::{
    LoadSessionResponse, NewSessionResponse, PromptCapabilities, SessionConfigOption,
};

use super::handshake::{Handshake, SessionManagement};

/// What a session response said, as far as capabilities are concerned.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionFacts {
    /// The option ids `session/new` returned. The ids are the engine's to define (§6.3), so these
    /// are what a caller may offer and all it may offer.
    pub config_option_ids: Vec<String>,
}

impl SessionFacts {
    /// Read the session response. An engine that returned no list said it has no options: the
    /// schema makes the field optional and 「not supported」 is what absent means, which is a
    /// measurement rather than a silence.
    pub fn of(response: &NewSessionResponse) -> Self {
        Self::from_options(response.config_options.as_ref())
    }

    /// The same reading of a *load* response, which answers with the option list under the same
    /// name and the same type — a reopened session has the same options a new one does.
    pub fn of_loaded(response: &LoadSessionResponse) -> Self {
        Self::from_options(response.config_options.as_ref())
    }

    fn from_options(options: Option<&Vec<SessionConfigOption>>) -> Self {
        Self {
            config_option_ids: options
                .map(|options| options.iter().map(|option| option.id.to_string()).collect())
                .unwrap_or_default(),
        }
    }
}

/// What one runtime incarnation learned about one session, from the engine itself.
///
/// Field for field the three groups Zed's `SessionCapabilities` holds
/// (`message_editor.rs:49-53`), with the one change §3.4's row forces: each group is optional,
/// because "the handshake has not been read" and "the handshake reported nothing" are different
/// facts, and a report that conflated them would be answering about an engine it never asked.
///
/// Nothing here is derived-and-stored. Every question below reads one of these facts, so the
/// answer cannot drift from what the engine said.
#[derive(Debug, Clone, Default)]
pub struct SessionCapabilities {
    /// The `initialize` answer, once one has been read.
    handshake: Option<Handshake>,
    /// The `session/new` answer, once one has been read.
    session: Option<SessionFacts>,
    /// How many commands the engine's last published list held.
    ///
    /// `None` is "no list has been published for this session"; `Some(0)` is a published list with
    /// nothing in it. The commands themselves are not kept: their journey to the `/` menu is the
    /// event stream's (T8's), and a second copy here would be a second truth about one wire value.
    /// A count is the whole of what a capability answer needs.
    commands: Option<usize>,
}

impl SessionCapabilities {
    /// The first negotiation: the handshake.
    pub fn negotiated(&mut self, handshake: Handshake) {
        self.handshake = Some(handshake);
    }

    /// The second: the session response.
    pub fn opened(&mut self, response: &NewSessionResponse) {
        self.session = Some(SessionFacts::of(response));
    }

    /// The second one more time, for a session that already existed: a load response answers the
    /// same question `session/new` does about the options this session now offers.
    pub fn reopened(&mut self, response: &LoadSessionResponse) {
        self.session = Some(SessionFacts::of_loaded(response));
    }

    /// The command list the engine published, replacing the previous one whole
    /// (§4.1: replace, never append).
    pub fn commands_published(&mut self, count: usize) {
        self.commands = Some(count);
    }

    /// The handshake, or `None` when none has been read.
    pub fn handshake(&self) -> Option<&Handshake> {
        self.handshake.as_ref()
    }

    /// The session response, or `None` when none has been read.
    pub fn session(&self) -> Option<&SessionFacts> {
        self.session.as_ref()
    }

    /// How many commands the published list holds, or `None` before one is published.
    pub fn command_count(&self) -> Option<usize> {
        self.commands
    }

    /// Zed's `supports_images` (`message_editor.rs:75-77`), with the state its `bool` cannot carry:
    /// `None` until the handshake has been read, and the wire's own answer after that.
    pub fn supports_images(&self) -> Option<bool> {
        self.prompt(|prompt| prompt.image)
    }

    /// Zed's `supports_embedded_context` (`message_editor.rs:79-81`), same shape.
    pub fn supports_embedded_context(&self) -> Option<bool> {
        self.prompt(|prompt| prompt.embedded_context)
    }

    /// `promptCapabilities.audio`, which Zed's editors do not gate on and this host does: §3.4.6
    /// wants the specific limitation shown, and audio is the arm the pinned engine answers no to.
    pub fn supports_audio(&self) -> Option<bool> {
        self.prompt(|prompt| prompt.audio)
    }

    /// `agentCapabilities.loadSession`.
    pub fn supports_session_resume(&self) -> Option<bool> {
        self.handshake
            .as_ref()
            .map(|handshake| handshake.load_session)
    }

    /// `sessionCapabilities.list`: may a session-history surface be offered at all.
    ///
    /// `None` is *no handshake has been read* — the one state in which nothing has said either
    /// way. Once one has, this wire answers: a handshake without the sub-object is the engine
    /// saying it does not serve `session/list`, which is `Some(false)` and not a silence.
    pub fn session_capability_list(&self) -> Option<bool> {
        self.session_capability(|session| session.list)
    }

    /// `sessionCapabilities.resume`: reopening a session **without** its previous messages.
    ///
    /// Deliberately not spelled `supports_session_resume`, which is the predicate above it: that
    /// one reads `agentCapabilities.loadSession`, and `load` and `resume` are different methods
    /// the schema separates in as many words. This group is named for its wire parent
    /// (`sessionCapabilities`) for the same reason — the four here are the sub-objects of one
    /// struct, and a reader can tell at a glance which of the two handshake fields an answer came
    /// from.
    pub fn session_capability_resume(&self) -> Option<bool> {
        self.session_capability(|session| session.resume)
    }

    /// `sessionCapabilities.close`.
    pub fn session_capability_close(&self) -> Option<bool> {
        self.session_capability(|session| session.close)
    }

    /// `sessionCapabilities.fork` — **UNSTABLE** in the pinned schema.
    pub fn session_capability_fork(&self) -> Option<bool> {
        self.session_capability(|session| session.fork)
    }

    fn session_capability(&self, read: impl FnOnce(&SessionManagement) -> bool) -> Option<bool> {
        self.handshake
            .as_ref()
            .map(|handshake| read(&handshake.session))
    }

    /// Zed's `has_slash_completions` (`message_editor.rs:91-93`): completions exist when the
    /// published list is not empty. `None` is the third state its `bool` folds away — the engine
    /// has published no list at all, so there is nothing to have an opinion about.
    pub fn has_slash_completions(&self) -> Option<bool> {
        self.commands.map(|published| published > 0)
    }

    fn prompt(&self, read: impl FnOnce(&PromptCapabilities) -> bool) -> Option<bool> {
        self.handshake
            .as_ref()
            .map(|handshake| read(&handshake.prompt))
    }
}
