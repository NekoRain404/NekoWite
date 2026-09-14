//! When a finished completion is a result the user can use, and when the only
//! honest answer is an explanation.
//!
//! Extracted from [`super::client`] as one vertical slice - the terminal verdict
//! on a run - so `client` keeps the loop that produces the state it reads. It
//! has no socket, no Tauri handle and no loop of its own, which is what makes
//! the policy it enforces testable on its own (see `tests/ai_completion_result_test.rs`).
//! The split's compatibility re-exports in `client` mean that test still
//! imports [`completion_refusal`] from where it always did.
//!
//! Dependencies: [`super::sse`] for the folded completion being judged. Nothing
//! here imports `client`, so the graph keeps its one-way direction.

use super::sse::CompletionStream;

/// Why a finished completion must be reported as a FAILURE, and what to tell
/// the user. `None` means the run is an ordinary success; every case here is a
/// completion with nothing (or nothing whole) to put in the document, which is
/// why none of them may end in an `ai-done`.
pub fn completion_refusal(completion: &CompletionStream) -> Option<&'static str> {
    // `length` means the provider ran out of output budget mid-answer, and an
    // answer truncated to NOTHING is the same statement at its extreme: the
    // empty case used to be carved out here, so it reached `ai-done` with
    // `full: ""` — a silent no-op where the intent is an explanation. The
    // `!saw_reasoning` leaves an answer-less reasoning turn to the more
    // specific message below.
    if completion.finish_reason() == Some("length")
        && (!completion.answer().is_empty() || !completion.saw_reasoning())
    {
        return Some(
            "回答因达到最大输出 Tokens 被截断（finish_reason: length）。\n                  内容并不完整，请在设置里调大“最大输出 Tokens”后重试。",
        );
    }
    if completion.finish_reason() == Some("content_filter") {
        return Some("服务端的内容过滤中断了这次回答（finish_reason: content_filter）。");
    }
    if completion.answer().is_empty() && completion.saw_reasoning() {
        return Some(
            "模型把本次最大输出 Tokens 全部用于推理，没有产出正文。                       请在设置里把“最大输出 Tokens”调大（推理模型建议 ≥ 1024）后重试。",
        );
    }
    None
}
