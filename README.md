# schism-web

Schism Tracker (an Impulse Tracker clone) rewritten in plain JavaScript: ES
modules, a canvas and Web Audio. No WebAssembly and no build step.

Live: https://markldn.github.io/schism-web/

    ./serve.sh                 # then open http://127.0.0.1:8600/schism/

![Start screen](screenshots/01-start.png)

![Pattern editor with demo/tute.it loaded](screenshots/02-pattern-editor.png)

Load modules by dropping them on the window or with F9 -> `[Import from disk]`.
IT, XM, S3M, MOD and many older tracker formats load, along with MIDI and
Doom MUS. IT, S3M and MOD save (saved files also download); WAV/AIFF audio
export includes per-channel files. AdLib playback, Web MIDI and a waterfall
visualiser are included. Use IT to preserve songs: conversion to older formats
can lose instruments, notes or effects.

Paste patterns from Schism/OpenMPT with Ctrl-V or Shift-Insert; Alt-O/P/M
provide overwrite, insert and mix modes. Text fields and song messages also
accept paste. Browser clipboard permission is needed for the Alt shortcuts;
they fall back to the internal clipboard when access is unavailable.

Open the font editor with Shift-F12. Use F9 to import/load ITF or raw FNT
fonts (8x8 and 8x16), or drop a font onto the editor. F10 then Enter saves
and downloads `font.cfg`, which becomes the default on reload. Ctrl-Q returns
to the tracker; the editor shows its drawing and transformation shortcuts.
See PROGRESS.md for what works and what doesn't, PORTING.md per C file.

    python3 test/parity.py     # pixel-compare against the original (needs ../schism-web/dist)
    python3 tools/gen-data.py  # regenerate js/gen/ from ../schismtracker

This is a derivative of Schism Tracker and carries its licence, GPL-2.0-or-later.
It is a separate project: Schism does not accept machine-generated code, so
nothing here should be sent upstream.
