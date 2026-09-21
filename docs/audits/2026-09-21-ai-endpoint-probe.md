# The AI endpoint, probed from this machine

Written 2026-09-21 by the agent that took the project over, at the maintainer's request: the
gateway below was given to be tested, and what follows is what a probe found rather than what was
assumed. **The API key is deliberately not in this file** — it was supplied in the session and used
from a temporary environment variable, and a key written into a repository is a key that has to be
rotated.

## What was tested

| Probe | Result |
|---|---|
| `GET {base}/models` with the key | **200**, `object: "list"`, five ids |
| `POST {base}/chat/completions`, `model: "deepseekflash"` | **403** — `当前用户、用户组或密钥的访问控制策略不允许访问模型 deepseekflash` |
| `POST`, `model: "deepseek-v4-flash"` | **200**, `content: "pong"` (8.2 s, 16 max tokens, `reasoning_tokens: 13`) |
| `POST`, `model: "deepseek-v4.1-flash"` | **200**, `content: "pong"` (5.9 s) |
| `POST`, `model: "glm-5.2"` | **200**, empty `content` at 16 max tokens — all 16 were reasoning tokens |
| `POST`, `model: "mimo-v2.5"` | **200**, a canned notice (「Xiaomi miclaw 封测已结束」): that upstream is closed |
| `POST` with `stream: true`, `deepseek-v4-flash` | **200**, SSE `data:` frames; `delta.reasoning_content` first, then `delta.content` |
| `POST` with `stream: true`, `deepseek-v4.1-flash` | **200**, SSE `data:` frames of `delta.content`; one `delta.function_call` with empty fields |

The model ids the key may reach, in the order the gateway lists them:

```
deepseek-v4-flash
deepseek-v4.1-flash
glm-5.2
mimo-v2.5
mimo-v2.5-pro
```

**`deepseekflash` is not one of them**, and the refusal is the gateway's own policy rather than a
typo in the request: the id it names in the error is the one that was sent. `deepseek-v4-flash` is
the model to use for this key.

## What this app already knows about that shape

The interesting part is that NekoWite was written against exactly this gateway's behaviour, and the
code says so:

- `providers/ai/openai_compatible.rs`'s `extract_openai_reasoning` reads `delta.reasoning_content`
  **and** `delta.reasoning`, with a comment recording the measurement: 「measured against toneflux's
  `deepseek-flash`, 27 reasoning deltas arrived before the first content delta」. The probe above
  reproduces that ordering.
- `providers/ai/sse.rs`'s fold turns it into `StreamEvent::Reasoning` rather than into answer text,
  so the monologue drives the progress indicator and never reaches the document — which is the
  property the ghost-writer path needs.

Two consequences worth knowing when this endpoint is configured in 设置 → AI:

1. **A reasoning model needs a real `max_tokens`.** With the app's ceiling set too low, the whole
   budget can go to reasoning and the answer arrives empty — measured above with `glm-5.2`, and the
   same shape is visible in `deepseek-v4-flash`'s usage (`reasoning_tokens: 13` of 16).
2. **The first token can take seconds** (5.9–8.2 s for a 16-token answer here), because the
   reasoning phase comes first. The app's own timeout budget is the thing to check if a turn looks
   stuck; the stream starts as soon as the gateway has something to say, so nothing is buffered
   client-side.

## How to reproduce

```sh
export NWK_AI_KEY='…'                     # out of band; never committed
curl -sS -H "Authorization: Bearer $NWK_AI_KEY" https://<base>/models
curl -sS -H "Authorization: Bearer $NWK_AI_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Reply with exactly: pong"}],"max_tokens":16}' \
  https://<base>/chat/completions
```

The endpoint is OpenAI-compatible, so it needs no code change: a provider entry with this base URL,
this key and `deepseek-v4-flash` is the whole configuration.
