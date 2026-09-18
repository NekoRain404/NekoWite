#!/usr/bin/env python3
"""Every event channel the Rust side emits must have a listener on the page that receives it.

The command sweep answered "is this invoke reachable". This is the other half of the same seam: a
channel where the backend talks and the frontend never listens. Nothing fails — the emit returns
`Ok(())`, the send succeeds, and the feature is silent. It is the same shape as a component mounted
nowhere, one layer down, and it is invisible to every test that drives the store directly.

The check is deliberately coarse: a channel counts as wired if its *name string* appears anywhere in
a frontend file. That over-counts — a name in a comment counts — and over-counting is the right
error direction here, because the finding this is looking for is a whole channel nobody named.
A hit is then verified by hand before anything is reported as broken.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUST = ROOT / 'apps/desktop/src-tauri/src'
FRONT = ROOT / 'apps/desktop/src'

# Every string constant, not only the ones spelled `…CHANNEL`. `OPEN_FILE_EVENT` is a channel and
# does not carry that word in its name; the first version of this pattern required it, so the open
# -file event read as "never emitted" — a control that failed on a channel that has worked for weeks.
CONST = re.compile(r'const\s+([A-Z][A-Z0-9_]*)\s*:\s*&(?:static\s+)?str\s*=\s*"([^"]+)"')
EMIT = re.compile(r'emit(?:_to|_filter)?\s*\([^;]{0,400}')
# `emit_to(app, LABEL, CHANNEL, payload)` — the first argument after the app is a **window label**,
# not a channel. `MAIN_WINDOW` sits there and resolved to "main", which no page names, so it read as
# a silent channel. It is the address, not the message.
NOT_A_CHANNEL = re.compile(r'WINDOW|LABEL$')


def main() -> int:
    rs = list(RUST.rglob('*.rs'))
    front = [p for p in FRONT.rglob('*.ts') if '.test.' not in p.name]
    front += list(FRONT.rglob('*.vue'))

    consts: dict[str, str] = {}
    rs_text = {}
    for p in rs:
        t = p.read_text(encoding='utf-8', errors='replace')
        rs_text[p] = t
        for m in CONST.finditer(t):
            consts[m.group(1)] = m.group(2)

    front_text = [p.read_text(encoding='utf-8', errors='replace') for p in front]
    joined = '\n'.join(front_text)

    emitted: dict[str, set[str]] = {}
    for p, t in rs_text.items():
        if p.name.endswith('_test.rs') or '/tests/' in str(p):
            continue
        # A module's own `#[cfg(test)] mod tests` block has emit calls too, and they carry fixture
        # channel names like "ses-1". The first run of this script reported two of those as channels
        # nobody listens to. Cut the file at its trailing test module: by convention it is last, and
        # an emit inside it is a test helper that ships nowhere.
        cut = re.search(r'#\[cfg\(test\)\]\s*\nmod\s', t)
        if cut:
            t = t[:cut.start()]
        for m in EMIT.finditer(t):
            seg = m.group(0)
            for c in re.findall(r"\b([A-Z][A-Z0-9_]{3,})\b", seg):
                if c not in consts or NOT_A_CHANNEL.search(c):
                    continue  # an unresolved name, or a window label standing where a channel goes
                emitted.setdefault(consts[c], set()).add(str(p.relative_to(ROOT)))
            for s in re.findall(r'"([A-Za-z][A-Za-z0-9_-]+)"', seg):
                emitted.setdefault(s, set()).add(str(p.relative_to(ROOT)))

    print('=== controls ===')
    for name in ('pet-task', 'ai-done', 'open-file-request'):
        print(f'  {name:20} emitted: {name in emitted}   named in a page: {name in joined}')
    print(f'  channels emitted by Rust: {len(emitted)}')
    print()

    print('=== emitted by Rust, named nowhere in the frontend ===')
    silent = sorted(k for k in emitted if k not in joined)
    for k in silent:
        where = sorted(emitted[k])[0]
        print(f'  {k:40} {where}')
    print(f'  ({len(silent)} of {len(emitted)} channels)')
    print()

    # --- the reverse direction -------------------------------------------------------------------
    # A `listen('x')` for an event nothing emits is a handler that can never run: no error, no
    # warning, no failing test — just a subscription that waits forever. Tauri's `listen` takes the
    # name as a string literal at the call site, so this is exact rather than a name search.
    # The channel arrives as a constant far more often than as a literal — `listen(OPEN_FILE_EVENT)`,
    # not `listen('open-file-request')`. Matching only literals made this side report "0 of 0
    # listened channels", which reads as a clean sweep and is in fact no sweep at all. Constants are
    # resolved from the frontend's own `const NAME = 'value'` declarations first.
    ts_const = {}
    for t in front_text:
        for m in re.finditer(r"""const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]([^'"]+)['"]""", t):
            ts_const[m.group(1)] = m.group(2)

    # Only the Tauri `listen` counts. `use-pet-page-appearance.ts` declares a local helper of the
    # same name — `function listen(wanted: boolean)` — and matching every call spelled `listen(`
    # reported its two call sites as channels nothing emits. The import is the discriminator.
    tauri_listen = re.compile(r"""import\s*\{[^}]*\blisten\b[^}]*\}\s*from\s*['"]@tauri-apps/api/event['"]""")

    listened: dict[str, set[str]] = {}
    for p, t in zip(front, front_text):
        if not tauri_listen.search(t):
            continue
        for m in re.finditer(r"""listen(?:<[^>]*>)?\s*\(\s*([A-Za-z_][A-Za-z0-9_]*|['"][^'"]+['"])""", t):
            arg = m.group(1).strip('\'"')
            listened.setdefault(ts_const.get(arg, arg), set()).add(str(p.relative_to(ROOT)))

    rust_joined = '\n'.join(rs_text.values())
    print('=== listened for, but no Rust side emits it ===')
    dead = []
    for k in sorted(listened):
        if k in emitted:
            continue
        # The window-label form: a listener on a channel the backend emits only to another window
        # still needs the name to exist as a string somewhere on the Rust side.
        if f'"{k}"' not in rust_joined and k not in consts.values():
            dead.append(k)
    for k in dead:
        print(f'  {k:40} {sorted(listened[k])[0]}')
    print(f'  ({len(dead)} of {len(listened)} listened channels)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
