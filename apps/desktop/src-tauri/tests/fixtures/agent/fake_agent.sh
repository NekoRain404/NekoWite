#!/bin/sh
# A fake ACP engine for tests/agent_runtime_test.rs.
#
# It answers the measured subset of the protocol (P0 §2) and can be told to
# misbehave in exactly one way, chosen by the first argument, so that every
# framing and failure path the transport claims to survive has a process that
# produces it on demand. It is a fixture, not an implementation: it matches
# method names in the raw request line instead of parsing JSON.
#
# stdout carries protocol frames only, newline-delimited, and diagnostics go to
# stderr — the same division the real engine keeps, and the reason the transport
# is allowed to treat a non-JSON stdout line as a protocol violation.

BEHAVIOUR=${1:-good}
SESSION=ses_fake_1
PROMPT_ID=

# The handshake is P0 §2.1's measured answer, verbatim apart from the agent's
# own name: it is the one response in this fixture whose exact shape is known
# from a real engine, and the SDK deserializes it into typed structs, so a
# shape invented here would fail for reasons that say nothing about our code.
INIT='{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":true},"promptCapabilities":{"embeddedContext":true,"image":true},"sessionCapabilities":{"close":{},"fork":{},"list":{},"resume":{}}},"authMethods":[{"id":"fake-login","name":"Fake login"}],"agentInfo":{"name":"FakeAgent","version":"0.0.1"}}'
# The session response and the command list below carry every field the pinned schema
# requires — `SessionConfigOption.name` and `AvailableCommand.description` are *not*
# optional on the wire (`agent-client-protocol-schema` 1.7.0), and the SDK's
# `skip-invalid-items` reader drops an item that omits one. A fixture that left them out
# would answer `configOptions: []` and `availableCommands: []` to every test, which is a
# session with no model catalog and a `/` menu with nothing in it — the exact shape a
# capability report is asked about, arrived at by accident.
NEW='{"sessionId":"ses_fake_1","configOptions":[{"id":"model","name":"Model","type":"select","currentValue":"fake/model-a","options":[{"value":"fake/model-a","name":"Model A"}]}]}'
SET='{"configOptions":[{"id":"model","name":"Model","type":"select","currentValue":"fake/model-b","options":[{"value":"fake/model-a","name":"Model A"},{"value":"fake/model-b","name":"Model B"}]}]}'
# The same new state again, this time as the notification ACP lets an engine send
# (`config_option_update`). Both producers exist here on purpose: the reply alone is enough for
# Zed and for this host's command answer, while the notification is the only route by which a
# change the host did NOT ask for reaches the window — a host that read only one of them would
# be wrong against the other.
CFG='{"sessionId":"ses_fake_1","update":{"sessionUpdate":"config_option_update","configOptions":[{"id":"model","name":"Model","type":"select","currentValue":"fake/model-b","options":[{"value":"fake/model-a","name":"Model A"},{"value":"fake/model-b","name":"Model B"}]}]}}'
DONE='{"stopReason":"end_turn","usage":{"inputTokens":11,"outputTokens":2,"totalTokens":13,"thoughtTokens":1}}'
CMDS='{"sessionId":"ses_fake_1","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"init","description":"Start a session"},{"name":"review","description":"Review the working tree"}]}}'

# `id_of` reads the JSON-RPC id out of a request and keeps it as it arrived,
# quotes and all: the SDK numbers its requests with UUID strings, and a reply
# carrying a bare number for a string id is one the client cannot match — which
# looks exactly like an engine that never answered. Our client writes `"id"`
# once per request, so the last match is the only match.
id_of() { printf '%s' "$1" | sed -n 's/.*"id":\("[^"]*"\|[0-9][0-9]*\).*/\1/p'; }
reply() { printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$1" "$2"; }
fail() { printf '{"jsonrpc":"2.0","id":%s,"error":%s}\n' "$1" "$2"; }
notify() { printf '{"jsonrpc":"2.0","method":"session/update","params":%s}\n' "$1"; }
chunk() { notify "{\"sessionId\":\"$SESSION\",\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"$1\"}}}"; }

# A process cannot read its parent's spawn environment back, so the test has to
# be told: the capture file is where this process reports what it was started
# with, plus the pids the group-kill test must find gone afterwards.
capture() {
    [ -n "$NWK_FAKE_CAPTURE" ] || return 0
    printf '%s\n' "$*" >> "$NWK_FAKE_CAPTURE"
}

capture "pid=$$"
capture "ca=${NODE_EXTRA_CA_CERTS:-<unset>}"
# What this process was *given*, reported by the process itself: the only evidence that an injected
# value reached the child rather than merely being described by the launch that built it. Both are
# `<unset>` unless a test asks for them, and neither exists in a developer's environment.
capture "home=${HOME:-<unset>}"
capture "cred=${NWK_TEST_API_KEY:-<unset>}"

# The group-kill test needs a grandchild that inherited the group, and needs it
# before any request is sent: this behaviour never answers, so it cannot wait
# for one. A sleeping shell is a stand-in for the tool subprocess the engine
# forks and leaves behind.
if [ "$BEHAVIOUR" = tree ]; then
    sh -c 'sleep 300' &
    capture "child=$!"
    sleep 300
fi

# On stdin EOF the read loop ends. Under this behaviour the process then takes
# its time before exiting, which is what a real engine finishing a write looks
# like — and the record it leaves is the evidence that it was given that time
# rather than killed the moment the connection closed.
on_stdin_closed() {
    if [ "$BEHAVIOUR" = slow-exit ]; then
        capture "eof-seen=yes"
        sleep 0.3
        capture "exited-cleanly=yes"
        exit 0
    fi
}

while IFS= read -r line; do
    id=$(id_of "$line")
    case "$line" in
        *'"method":"initialize"'*)
            case "$BEHAVIOUR" in
                split-utf8)
                    # One character, cut in half by a write boundary: \344\270
                    # then \255 is 中. The frame is not complete until the last
                    # byte arrives, so both halves have to be held and joined.
                    printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentInfo":{"name":"\344\270' "$id"
                    sleep 0.2
                    printf '\255","version":"0.0.1"}}}\n'
                    ;;
                unknown-id)
                    # A response for an id nobody is waiting on. It must be
                    # discarded without disturbing the answer that follows it.
                    printf '{"jsonrpc":"2.0","id":"nobody-asked","result":{"unexpected":true}}\n'
                    reply "$id" "$INIT"
                    ;;
                mid-request-exit)
                    # Dies without answering. rust-sdk #250/#223: an in-flight
                    # future can be left parked forever, which turns a crash
                    # into a hang — the worse failure of the two.
                    exit 0
                    ;;
                malformed)
                    printf 'this stdout line is not json\n'
                    reply "$id" "$INIT"
                    ;;
                oversized)
                    # Nine megabytes with no newline: the frame never ends, so
                    # only the size bound can stop it.
                    head -c 9437184 /dev/zero | tr '\0' 'a'
                    sleep 30
                    ;;
                cert-fail)
                    fail "$id" '{"code":-32603,"message":"Internal error: unknown certificate verification error","data":{"service":"session","errorName":"UnknownError"}}'
                    ;;
                modest-handshake)
                    # A handshake that reports none of the prompt capabilities the pinned engine
                    # advertises. An installation's declaration describes the pinned version and is
                    # only a start-time hint (plan §3.4), so this is the process that produces the
                    # disagreement a capability report has to *show* rather than blur: what it
                    # declares and what it negotiated are two different facts.
                    reply "$id" '{"protocolVersion":1,"agentCapabilities":{"promptCapabilities":{}},"agentInfo":{"name":"FakeAgent","version":"0.0.1"}}'
                    ;;
                *)
                    reply "$id" "$INIT"
                    ;;
            esac
            ;;
        # The reply to a reverse request this fixture sent. Captured rather
        # than parsed, so a test can assert on the exact frame the engine would
        # have received — which for a refusal is the whole point.
        *'"id":"fs-1"'*)
            capture "fs-reply=$line"
            ;;
        *'"method":"session/new"'*)
            if [ "$BEHAVIOUR" = two-in-one ]; then
                # Response and notification in a single write: a reader that
                # treats one read as one message loses the second frame.
                printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n{"jsonrpc":"2.0","method":"session/update","params":%s}\n' "$id" "$NEW" "$CMDS"
            else
                reply "$id" "$NEW"
                # Measured (P0 §2.2): the command list follows as a
                # notification, not in the response, and it arrives with no run
                # open.
                notify "$CMDS"
            fi
            # The engine's own file request, sent verbatim from the environment
            # so the test decides what is asked for. This is the one reverse
            # request whose subject is a real path on this machine, so building
            # it here would mean teaching the fixture about vaults.
            if [ -n "$NWK_FAKE_FS_REQUEST" ]; then
                printf '%s\n' "$NWK_FAKE_FS_REQUEST"
            fi
            ;;
        *'"method":"session/set_config_option"'*)
            reply "$id" "$SET"
            if [ "$BEHAVIOUR" = config-update ]; then
                notify "$CFG"
            fi
            ;;
        *'"method":"session/prompt"'*)
            PROMPT_ID=$id
            chunk "first"
            # A thought chunk is part of the measured stream (P0 §2.3) and has
            # no host kind; the test asserts it does not reach the host.
            notify "{\"sessionId\":\"$SESSION\",\"update\":{\"sessionUpdate\":\"agent_thought_chunk\",\"content\":{\"type\":\"text\",\"text\":\"thinking\"}}}"
            if [ "$BEHAVIOUR" = config-mid-run ]; then
                # A config change the host did not ask for, while a turn is in flight: the run
                # is still open when this frame arrives, which is the case the host has to
                # decide about (a session fact must not be stamped with a run, and must not be
                # able to fail one). The pause is what makes that ordering the deterministic
                # one rather than a race with the reply below.
                notify "$CFG"
                sleep 0.3
            fi
            if [ "$BEHAVIOUR" = stream ]; then
                # Wait for the cancel and then keep talking: the text that
                # arrives after a cancelled run is exactly what must not
                # revive it.
                sleep 0.3
                while IFS= read -r later; do
                    case "$later" in
                        *'"method":"session/cancel"'*)
                            chunk "late"
                            reply "$PROMPT_ID" "$DONE"
                            break
                            ;;
                    esac
                done
            else
                reply "$id" "$DONE"
            fi
            ;;
        *'"method":"session/cancel"'*)
            # Nothing is running under the `good` behaviour; the runtime still
            # has to accept a cancel for an idle session, which is the case
            # `cancelling_an_idle_session_is_not_an_error` covers.
            ;;
    esac
done

on_stdin_closed
