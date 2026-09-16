//! The calls this host makes over an ACP connection, and the bound each one carries.
//!
//! This is the other half of `acp_transport.rs`, split by what each half has to be true of rather
//! than by size. A connection is a *process* with a lifetime: it is spawned once, it outlives every
//! request, and its handlers must never block the SDK's dispatch loop — that is the parent's rule,
//! and it holds whether or not a single call is ever made. A call is a *request with a deadline*:
//! the SDK has no timeout anywhere in its path, so every one of these carries its own bound and
//! every failure it produces is classified before it leaves. Neither rule can be stated in the
//! other's terms.
//!
//! What the parent owns and this file borrows: [`super::EngineConnection`], whose `connection`
//! field is the SDK's handle and whose `trip` field is the bounded reader's own account of why it
//! stopped — [`trip_reason`] is the caller's half of that note, and it is why a frame that grew
//! past `MAX_FRAME_BYTES` reaches the window as a size fault rather than as a crash.
//!
//! The one call here that is not a thin wrapper is [`EngineConnection::prompt`]: its response is
//! read by `usage::ending` rather than by the SDK's own router, for the two measurements P0 §6.3
//! made of this engine — a `usage` object missing a counter the schema requires, and a `stopReason`
//! word the pinned schema does not enumerate.

use std::path::Path;
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, InitializeRequest, InitializeResponse, NewSessionRequest,
    NewSessionResponse, PromptRequest, SessionConfigValueId, SessionId,
    SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, TextContent,
};
use agent_client_protocol::{JsonRpcRequest, UntypedMessage};

use super::super::events::{TransportError, classify};
use super::super::fs_capability;
use super::super::usage::{self, PromptEnding};
use super::EngineConnection;

impl EngineConnection {
    /// Negotiates the protocol.
    ///
    /// The version is checked here as well as by the SDK's own guard: a version
    /// this host does not implement must fail as `protocol-incompatible` at the
    /// handshake, or every later call fails in a way that reads as an engine
    /// bug.
    pub async fn initialize(&self, bound: Duration) -> Result<InitializeResponse, TransportError> {
        // The capability is declared here and nowhere else. P0 §7.2 measured the
        // engine sending `fs/write_text_file` even under an empty capability
        // set; advertising it is what makes a *delegated* write one this host
        // performs, through the app's own write path. It is not exclusivity: P0
        // §7's default-configuration probe measured the same engine writing a
        // file through its own tools with zero reverse requests, so what arrives
        // here is a write the engine handed over, not a gate every write must pass.
        let initialize =
            InitializeRequest::new(ProtocolVersion::V1).client_capabilities(fs_capability::client_capabilities());
        let response = self.request("initialize", initialize, bound).await?;
        if response.protocol_version != ProtocolVersion::V1 {
            return Err(TransportError::ProtocolIncompatible {
                found: response.protocol_version.as_u16(),
            });
        }
        Ok(response)
    }

    /// Opens a session in `cwd`.
    pub async fn new_session(
        &self,
        cwd: &Path,
        bound: Duration,
    ) -> Result<NewSessionResponse, TransportError> {
        self.request("session/new", NewSessionRequest::new(cwd.to_path_buf()), bound)
            .await
    }

    /// Selects one of the engine's own options on a session.
    pub async fn set_config_option(
        &self,
        session_id: SessionId,
        config_id: String,
        value: String,
        bound: Duration,
    ) -> Result<SetSessionConfigOptionResponse, TransportError> {
        // The value is wrapped as the engine's own option id rather than as a
        // bare string, because the option may be a boolean or a group id: the
        // type is what keeps a caller from sending a shape the engine's list
        // never offered.
        let request = SetSessionConfigOptionRequest::new(
            session_id,
            config_id,
            SessionConfigValueId::new(value),
        );
        self.request("session/set_config_option", request, bound).await
    }

    /// Starts a generation. The answer arrives as updates and finally as this
    /// ending, which carries the stop reason and the usage.
    ///
    /// The request is sent untyped — `UntypedMessage` carries the SDK's own
    /// [`PromptRequest`] as its params, so the engine sees the frame it always
    /// saw — and the response is read by [`usage::ending`] rather than by the
    /// SDK's router, for two reasons that are one measurement: `PromptResponse`
    /// holds usage as `Option<Usage>`, `Usage` requires `totalTokens`,
    /// `inputTokens` and `outputTokens` as non-optional `u64`s, and P0 §6.3
    /// measured the engine omitting one of them; and its `stopReason` is the
    /// pinned schema's five variants with no arm for a sixth, which §6.3's
    /// moving protocol surface makes a frame to read rather than to refuse.
    /// Nothing else about the response changes: a frame that reader will not
    /// read fails through `classify` exactly as the SDK's router would have
    /// failed it.
    pub async fn prompt(
        &self,
        session_id: SessionId,
        text: &str,
        bound: Duration,
    ) -> Result<PromptEnding, TransportError> {
        let prompt = vec![ContentBlock::Text(TextContent::new(text))];
        let request = UntypedMessage::new("session/prompt", PromptRequest::new(session_id, prompt))
            .map_err(classify)?;
        // The method the request itself carries, so the timeout this call may
        // report names the same call the engine was sent.
        let method = request.method().to_string();
        let raw: serde_json::Value = self.request(&method, request, bound).await?;

        usage::ending(&method, &raw).map_err(classify)
    }

    /// Asks the engine to stop the generation running on a session.
    ///
    /// A notification, not a request: the engine does not answer it, and the
    /// run ends when the prompt call itself returns.
    pub fn cancel(&self, session_id: SessionId) -> Result<(), TransportError> {
        self.connection
            .send_notification(CancelNotification::new(session_id))
            .map_err(classify)
    }

    async fn request<Req>(
        &self,
        method: &str,
        request: Req,
        bound: Duration,
    ) -> Result<Req::Response, TransportError>
    where
        Req: JsonRpcRequest,
        Req::Response: Send,
    {
        let pending = self.connection.send_request(request);
        // The SDK has no timeout of its own, so the bound is applied here. A
        // cancelled `block_task` leaves the request outstanding; the SDK's
        // router discards an answer that arrives for it afterwards.
        match tokio::time::timeout(bound, pending.block_task()).await {
            Ok(Ok(response)) => Ok(response),
            // The bound reports through the closed connection, so its own
            // reason is preferred over whatever the closure looked like.
            Ok(Err(error)) => Err(self.trip_reason().unwrap_or_else(|| classify(error))),
            Err(_) => Err(TransportError::Timeout {
                method: method.to_string(),
            }),
        }
    }

    /// The bound's own account of why the connection stopped, if it was.
    ///
    /// Without this the caller sees only that the transport closed, which
    /// reads as a crash; the reader is the one component that knows a frame
    /// grew past the limit, so it leaves the reason here on its way out.
    fn trip_reason(&self) -> Option<TransportError> {
        self.trip
            .lock()
            .unwrap()
            .clone()
            .map(|message| TransportError::Engine { message })
    }
}
