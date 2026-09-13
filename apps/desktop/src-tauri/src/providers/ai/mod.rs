//! The AI provider layer, split by responsibility.
//!
//! Dependency direction is one-way, from `client` down to the leaves:
//!
//! ```text
//! client     orchestration: HTTP client lifecycle, streaming loop, events
//!   +- sse          <- limits, response, gemini, openai_compatible
//!   +- url_policy   <- request
//!   +- response     <- limits, request
//!   +- request      <- limits
//!   +- limits       (leaf)
//! ```
//!
//! `gemini` and `openai_compatible` hold the provider-specific knowledge and
//! reach shared helpers through `request`/`response`; nothing below `client`
//! imports `client`, so the graph has no cycle.

pub mod client;
pub mod gemini;
pub mod limits;
pub mod openai_compatible;
pub mod request;
pub mod response;
pub mod sse;
pub mod url_policy;
