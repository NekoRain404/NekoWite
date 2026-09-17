#!/usr/bin/env python3
"""Sample the rate of provider TLS failures, without spending a single prompt.

The live tests are the only thing that measures the real turn end to end, and each one
costs roughly 9-14k tokens of input (P0 §3) — so "how often does the engine reject a
certificate the system store accepts?" is a question they are far too expensive to answer.
This is the cheap instrument for that one question, and it measures the part of the live
run the failure actually lives in.

Why it costs nothing: the engine is driven at the real provider with a deliberately
**invalid** key. Every request that reaches the provider is rejected with an auth error, so
no completion is ever generated and nothing is billed -- but the TLS handshake to the
provider happens for real, in the engine's own runtime (Bun), over the same network path,
through the same ACP code path the live tests use: `initialize`, `session/new`, the model
pinned with `session/set_config_option`, and the concurrent title + build streams a single
prompt starts.

The model must be pinned, and the run aborts if the engine ever selects another provider.
An ACP session with no model set silently falls back to an opencode-hosted free model,
which bills real tokens and measures an endpoint this script is not about.

It also prints, alongside each engine verdict, what an independent TLS client says about the
chain the provider is serving at that moment. That pairing is the point: the failure being
investigated is the engine rejecting a chain the system store accepts, so a sample that
records only one of the two cannot show the divergence.

Usage:
    python3 scripts/probe-provider-tls.py [ROUNDS] [CONCURRENT]

Each round issues CONCURRENT prompts and then one `control` sample, and prints one line per
prompt plus one line per chain sample. `ROUNDS x CONCURRENT` prompts at about
1.3s each is the cost; 60 x 4 is roughly five minutes.
"""

import json
import os
import queue
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.environ.get(
    "ENGINE",
    os.path.join(REPO, "apps/desktop/src-tauri/binaries/opencode-x86_64-unknown-linux-gnu"),
)
# The bundle the app injects, and the one the system store resolves to (process.rs,
# `SYSTEM_CA_BUNDLE`). Overridable so a distribution that keeps its store elsewhere can run
# this too -- which is also true of the app.
CA = os.environ.get("CA", "/etc/ssl/certs/ca-certificates.crt")
MODEL = os.environ.get("MODEL", "iapp/deepseek-v4-flash")
PROVIDER = os.environ.get("PROVIDER", "iapp")
HOST = os.environ.get("HOST", "ai.iapp.dpdns.org")
SCRATCH = os.environ.get("SCRATCH", os.path.join(REPO, ".tmp-tls-probe"))

ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 20
CONC = int(sys.argv[2]) if len(sys.argv) > 2 else 4
VAULT = os.path.join(SCRATCH, "vault")
LOG = os.path.join(SCRATCH, "data/opencode/log/opencode.log")

# The provider block the live tests use, with the key read from the environment as an
# `{env:...}` reference -- so the value exists in no file this script writes.
PROFILE = """{
  "provider": {
    "%s": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "iApp Gateway (probe)",
      "options": {
        "baseURL": "https://%s/v1",
        "apiKey": "{env:NWK_PROBE_KEY}"
      },
      "models": {
        "deepseek-v4-flash": { "name": "DeepSeek V4 Flash" }
      }
    }
  }
}
""" % (PROVIDER, HOST)


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def prepare():
    """A scratch profile inside the repository, the way the live tests build one (plan §3.2).

    The developer's own `~/.config/opencode` and `~/.local/share/opencode` are never
    reached: HOME and the four XDG roots all point inside `SCRATCH`.
    """
    config = os.path.join(SCRATCH, "profile/XDG_CONFIG_HOME/opencode")
    os.makedirs(config, exist_ok=True)
    os.makedirs(VAULT, exist_ok=True)
    for sub in ("data", "cache", "state"):
        os.makedirs(os.path.join(SCRATCH, sub), exist_ok=True)
    with open(os.path.join(config, "opencode.json"), "w") as handle:
        handle.write(PROFILE)


def child_env():
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": os.path.join(SCRATCH, "profile"),
        "XDG_CONFIG_HOME": os.path.join(SCRATCH, "profile/XDG_CONFIG_HOME"),
        "XDG_DATA_HOME": os.path.join(SCRATCH, "data"),
        "XDG_CACHE_HOME": os.path.join(SCRATCH, "cache"),
        "XDG_STATE_HOME": os.path.join(SCRATCH, "state"),
        # Deliberately not a real credential. A valid key would generate completions and
        # bill tokens; the handshake this measures happens either way.
        "NWK_PROBE_KEY": "sk-probe-invalid-key",
    }
    if CA:
        env["NODE_EXTRA_CA_CERTS"] = CA
    return env


def classify(text):
    # The engine's error payload escapes non-ASCII, so decode before matching.
    try:
        plain = json.loads('"%s"' % text.replace('"', '\\"'))
    except Exception:
        plain = text
    lowered = plain.lower()
    if "certificate" in lowered:
        return "cert"
    if "401" in lowered or "unauthorized" in lowered or "key" in lowered or "密钥" in plain:
        return "ok-auth"
    return "other"


class Engine:
    """Just enough ACP client to drive one session."""

    def __init__(self):
        self.process = subprocess.Popen(
            [ENGINE, "acp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=child_env(),
            cwd=VAULT,
            text=True,
            bufsize=1,
        )
        self.lock = threading.Lock()
        self.next_id = 1
        self.responses = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _send(self, message):
        with self.lock:
            self.process.stdin.write(json.dumps(message) + "\n")
            self.process.stdin.flush()

    def call(self, method, params, timeout=180):
        with self.lock:
            rid = self.next_id
            self.next_id += 1
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        return self.responses.get(timeout=timeout)

    def _read(self):
        for line in self.process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if "method" in message and "id" in message:
                # A request from the engine (permission, fs). The profile asks for nothing,
                # so this is a path that should not be reached; answering `cancelled` keeps
                # the run moving rather than deadlocking if it is.
                self._send(
                    {
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "result": {"outcome": {"outcome": "cancelled"}},
                    }
                )
            elif "id" in message:
                self.responses.put(message)


def chain_sample():
    """What the system store says about the chain the provider is serving right now.

    Deliberately a second, independent TLS client and not the engine: the question this
    answers is the control half of the measurement -- whether anything is wrong with the
    chain at all. Python's `ssl` is OpenSSL, which reads the same system store `curl` and
    `openssl s_client` do, so a sample where this says `ok` and the engine says `cert` is
    the divergence this whole instrument exists to catch.
    """
    try:
        context = ssl.create_default_context(cafile=CA if CA else None)
        with socket.create_connection((HOST, 443), timeout=20) as raw:
            with context.wrap_socket(raw, server_hostname=HOST) as tls:
                der = tls.getpeercert(binary_form=True)
        import hashlib

        return "ok", hashlib.sha256(der).hexdigest()[:16]
    except Exception as error:  # noqa: BLE001 - the failure text is the measurement
        return "fail", "%s: %s" % (type(error).__name__, error)


def main():
    if not os.path.isfile(ENGINE):
        print("FAIL: no engine at %s" % ENGINE, file=sys.stderr)
        print("  The artifact is gitignored; fetch it with scripts/fetch-opencode-linux.sh.", file=sys.stderr)
        return 1

    prepare()
    log_start = os.path.getsize(LOG) if os.path.exists(LOG) else 0
    engine = Engine()

    if "error" in engine.call("initialize", {"protocolVersion": 1, "clientCapabilities": {}}):
        print("FATAL: initialize failed", file=sys.stderr)
        return 1
    session = engine.call("session/new", {"cwd": VAULT, "mcpServers": []})
    if "error" in session:
        print("FATAL: session/new failed: %s" % session["error"], file=sys.stderr)
        return 1
    session_id = session["result"]["sessionId"]
    pinned = engine.call(
        "session/set_config_option",
        {"sessionId": session_id, "configId": "model", "value": MODEL},
    )
    if "error" in pinned:
        print("FATAL: could not pin the model: %s" % pinned["error"], file=sys.stderr)
        return 1
    print("# session %s pinned to %s; %d rounds x %d prompts" % (session_id, MODEL, ROUNDS, CONC))

    tally = {}
    for _ in range(ROUNDS):
        with engine.lock:
            ids = []
            for _ in range(CONC):
                ids.append(engine.next_id)
                engine.next_id += 1
        for rid in ids:
            engine._send(
                {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "method": "session/prompt",
                    "params": {
                        "sessionId": session_id,
                        "prompt": [{"type": "text", "text": "Reply with the single word: hi"}],
                    },
                }
            )
        for _ in ids:
            try:
                response = engine.responses.get(timeout=180)
            except queue.Empty:
                outcome, detail = "timeout", "no response in 180s"
            else:
                if "error" in response:
                    text = json.dumps(response["error"])
                    outcome, detail = classify(text), text[:200]
                else:
                    outcome, detail = "ok-auth", "stopReason=%s" % response.get("result", {}).get("stopReason")
            tally[outcome] = tally.get(outcome, 0) + 1
            print("%s\tengine\t%s\t%s" % (stamp(), outcome, detail))
        status, detail = chain_sample()
        print("%s\tcontrol\t%s\t%s" % (stamp(), status, detail))
        tally["control-" + status] = tally.get("control-" + status, 0) + 1

    engine.process.stdin.close()
    print("# tally: %s" % tally)

    # Ground truth for "no tokens were billed": the engine's own log, the same place the
    # failing live run recorded its error.
    if os.path.exists(LOG):
        with open(LOG, "r", errors="replace") as handle:
            handle.seek(log_start)
            produced = handle.read()
        providers = {}
        for token in produced.split():
            if token.startswith("llm.provider="):
                name = token.split("=", 1)[1]
                providers[name] = providers.get(name, 0) + 1
        billed = 0
        for line in produced.splitlines():
            if "tokens.output=" in line and "tokens.output=0" not in line:
                billed += 1
        print("# providers selected: %s" % providers)
        print("# log lines reporting non-zero output tokens: %d" % billed)
        if set(providers) - {PROVIDER}:
            print("# WARNING: a provider other than %s was used; those prompts were not free" % PROVIDER)
    return 0


if __name__ == "__main__":
    if "--clean" in sys.argv:
        shutil.rmtree(SCRATCH, ignore_errors=True)
        print("# removed %s" % SCRATCH)
    sys.exit(main())
