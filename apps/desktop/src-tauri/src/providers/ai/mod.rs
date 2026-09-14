//! The AI provider layer, split by responsibility.
//!
//! Dependency direction is one-way, from `client` down to the leaves:
//!
//! ```text
//! client     orchestration: the models fetch and the streaming loop
//!   +- endpoint     <- request, gemini, openai_compatible
//!   +- refusal      <- sse
//!   +- transport    <- url_policy
//!   +- events       <- sse, state
//!   +- sse          <- limits, response, gemini, openai_compatible
//!   +- url_policy   <- request
//!   +- model_list   <- limits, request, response
//!   +- response     <- limits
//!   +- error_message (leaf: what a rejection says to the user)
//!   +- request      <- limits, config
//!   +- config       <- key_store (leaf)
//!   +- limits       (leaf)
//! ```
//!
//! `gemini` and `openai_compatible` hold the provider-specific knowledge and
//! reach shared helpers through `request`/`response`; nothing below `client`
//! imports `client`, so the graph has no cycle. `response` re-exports the two
//! items `model_list` took over AND the failure wording `error_message` did,
//! and `request` re-exports the config names it gave up to `config` - the
//! compatibility surface a split keeps, not a dependency back.

pub mod client;
pub mod config;
pub mod endpoint;
pub mod error_message;
pub mod events;
pub mod gemini;
pub mod limits;
pub mod model_list;
pub mod openai_compatible;
pub mod refusal;
pub mod request;
pub mod response;
pub mod sse;
// Private to the layer: `client` is the only module that dials a request, and
// nothing outside this module tree builds a client.
mod transport;
pub mod url_policy;
