# schism-html

Schism Tracker rewritten in plain JavaScript: ES modules, a canvas, no
WebAssembly and no build step. Work in progress; see PORTING.md for exactly
which parts of the original exist so far.

    ./serve.sh                 # http://127.0.0.1:8778
    python3 test/parity.py     # pixel-compare against the original (needs ../schism-web/dist)
    python3 tools/gen-data.py  # regenerate js/gen/ from ../schismtracker

This is a derivative of Schism Tracker and carries its licence, GPL-2.0-or-later.
It is a separate project: Schism does not accept machine-generated code, so
nothing here should be sent upstream.
