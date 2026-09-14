//! The AI provider layer, split by responsibility.
//!
//! Dependency direction is one-way, from `client` down to the leaves:
//!
//! ```text
//! client     orchestration: HTTP client lifecycle, streaming loop
//!   +- events       <- sse, state
//!   +- sse          <- limits, response, gemini, openai_compatible
//!   +- url_policy   <- request
//!   +- model_list   <- limits, request, response
//!   +- response     <- limits
//!   +- request      <- limits
//!   +- limits       (leaf)
//! ```
//!
//! `gemini` and `openai_compatible` hold the provider-specific knowledge and
//! reach shared helpers through `request`/`response`; nothing below `client`
//! imports `client`, so the graph has no cycle. `response` re-exports the two
//! items `model_list` took over, which is the compatibility surface a split
//! keeps, not a dependency back.

pub mod client;
pub mod events;
pub mod gemini;
pub mod limits;
pub mod model_list;
pub mod openai_compatible;
pub mod request;
pub mod response;
pub mod sse;
pub mod url_policy;
