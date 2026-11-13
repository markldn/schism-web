# Progress and to-do

Native JavaScript port of Schism Tracker. No WebAssembly, no build step.
Last updated 2026-11-13. Per-file detail is in `PORTING.md`.

## Where it stands

**7,982 of 86,287 lines of C are ported (about 9%).** A further 2,784 lines are
in UI files that are partly ported. `player/csndfile.c` (2,142 lines) is now
also partially implemented; none of that file is counted as fully ported.

You can open it, move through every menu, open the dialogs and switch pages.
You cannot yet load, edit, play or save a song.

## Done

| Area | From | State |
|---|---|---|
| Text-mode screen: fonts, 17 palettes, boxes, thumb bars, VU meters, overlays | vgamem.c, fonts.c, palettes.c | ported |
| Canvas output, mouse coordinates | video.c | replaced by browser code |
| Event loop, key and mouse events | main.c, events.c | replaced by browser code |
| Key translation, note entry keys, octave, note/volume strings | keyboard.c | ported |
| All 11 widget types: drawing, keys, mouse, focus order | widget.c, widget-keyhandler.c | ported |
| Dialogs: OK, OK/Cancel, Yes/No, custom, number prompts | dialog.c | ported |
| Main menu and five submenus | menu.c | ported |
| Screen frame, page titles, page switching, status line | page.c, status.c | ported |
| Global shortcuts (F-keys, Ctrl, Alt) | page.c | ported; those needing the song say "Not ported yet" |
| New Song, exit, jump-to-time, song-length prompts; top-row sliders | page.c | ported |

Checked by `test/parity.py`: 31 screen regions compared against the original
C build, all with 0 differing pixels.

## Player implementation underway

The player modules are implemented in part but are not yet wired into the UI:

- `csndfile.js`: song/voice/sample/instrument storage, pattern helpers, counts,
  seeking, looping, restart insertion, VU aggregation, live sample updates,
  padded loop lookahead, wave configuration and song-length calculation.
- `effects.js`: pitch conversions/slides, effect and volume-column dispatch,
  per-channel scheduling, note/instrument changes, envelopes, NNA/duplicate
  actions and special effects. MIDI macros/providers remain incomplete.
- `sndmix.js`: order/tick scheduling, envelope/modulation processing, per-voice
  setup, stereo mix orchestration calls, output buffering and player setup.
- `mixer.js`: loop chunks/lookahead, four interpolation modes, 8/16-bit
  mono/stereo kernels, filter/ramp variants and stereo mix orchestration.
- `mixutil.js`, `filters.js`, `equalizer.js`: PCM conversion, offset decay,
  resonant filters, EQ and normalization. Tables/layouts are generated from C.

Integration (`node test/player-integration.mjs`) exercises the real shared
registry through notes/NNA and nonzero 16-bit PCM across a tick boundary.
MIDI/OPL transport hooks are substituted. Song-length tests follow speed changes
and preserve live voice/order state. This is not full-song audio parity.

Compiled-C checks currently pass:

| Command | Coverage |
|---|---|
| `python3 test/player-tables.py` | 14 tables / 1,582 values |
| `python3 test/pitch-parity.py` | 10,844 pitch/slide cases |
| `python3 test/slide-parity.py` | 10,240 volume/pan slide states |
| `python3 test/filter-parity.py` | 21,544 filter coefficient/state cases |
| `python3 test/mixutil-parity.py` | 1,004 PCM buffers / 65,648 samples |
| `python3 test/kernel-parity.py` | 64 kernel variants, one nonconstant fractional-step fixture |

Additional targeted tests: `test/song-model.mjs`, `effects.mjs`, `sndfile.mjs`,
`sndmix.mjs`, `mixer.mjs`, `filters.mjs`, `equalizer.mjs`, and `mixutil.mjs`.

Still needed for this block: broad note/instrument/NNA/envelope/loop/EQ
comparisons, full-song audio parity, remaining sample I/O/resampling helpers,
complete reset/history/MIDI behavior, AudioWorklet output and UI wiring.
Default random sequences use Math.random rather than libc rand. Padding replaces
sample data and active references need refreshing. Ported-line totals above
remain unchanged until the required parity gates pass.

Four public FIR sample-resizing helpers are implemented for 8/16-bit mono/
stereo buffers, reusing the verified FIR kernel and native-width clipping.
Constant-signal resize tests pass and all 64 kernel comparisons still pass.
Nonconstant resizer comparisons and sample-editor wiring remain pending.

Memory-backed slurp read/seek helpers and initial PCM sample decoding are
implemented. Decoder supports signed/unsigned/delta 8/16-bit mono, split or
interleaved stereo, both endiannesses, plus signed 7-bit mono. Tests cover
split-stereo delta, big-endian 16-bit and truncated-input rejection. Higher
widths/compression and full upstream failure-path parity remain pending.

Higher-resolution sample input now supports normalized signed/unsigned
24/32-bit mono/interleaved PCM and 32/64-bit IEEE mono/interleaved/split input.
Tests cover IEEE clipping and normalized 32-bit PCM signs. The upstream
short-integer-sample branch is preserved (<=8 frames remain zero, input does
not advance). Broad C normalization/IEEE comparisons remain pending.

S3M/IT effect import/export translation is implemented using a generated
26-command mapping. Tests cover surround conversion, decimal pattern breaks
and global-volume scaling. Full effect-byte differential comparisons and
module-loader integration remain pending.

## Known gaps in what is done

- [ ] Text fields accept ASCII only (needs charset.c)
- [ ] Digraph, Ctrl-Shift Unicode and Alt-numpad character entry
- [ ] Top info area shows placeholder order/pattern/row/speed/tempo
- [ ] Clock and the visualiser box (top right) are empty
- [ ] Jump-to-time OK button does nothing until the song model exists
- [ ] Software mouse cursor (the browser's pointer is used)
- [ ] Loading custom font files; saving palette and settings
- [ ] Mouse use of widgets and the top-row sliders is ported but untested
- [ ] Starts on the pattern editor, not the About screen

## To do, in order

Line counts are the C still to port for each block.

1. [ ] **Song model and player** (10,823): csndfile, tables, effects, sndmix,
   mixer, mixutil, filters, equalizer, then audio output on an AudioWorklet.
   Makes sound possible. Verify by comparing rendered audio with the original.
2. [ ] **Loading and saving** (11,038): IT (with sample compression), S3M, XM,
   MOD; the load/save pages; a browser file store in place of the disk.
3. [ ] **Pattern editor** (5,764): page_patedit.c and pattern-view.c. The
   largest single screen, and the one that needs every shortcut right.
4. [ ] **Samples and instruments** (8,991): sample list and sample editing,
   instrument list with envelopes, sample/instrument loading, WAV/ITS/ITI.
5. [ ] **Remaining pages** (4,484): order list and panning, song variables,
   message editor, info page, help, about, log.
6. [ ] **Settings** (4,148): system configuration, preferences, palette
   editor, font editor, waterfall, time information, saved config.
7. [ ] **MIDI** (2,490): midi-core with a Web MIDI provider, the two MIDI
   pages, General MIDI output.
8. [ ] **Export and AdLib** (6,657): WAV/AIFF export, OPL2/OPL3 emulation.
9. [ ] **Text and clipboard** (2,128): character sets, system clipboard.
10. [ ] **Other formats and utilities** (18,998): the remaining 43 module and
    sample loaders (669, AMS, FAR, IMF, MDL, MED, MT2, MTM, OKT, PSM, STM,
    ULT, AIFF, AU, FLAC, MP3, Ogg, SF2 and others) plus small helpers.

## Not planned

16 files (6,412 lines) have no meaning in a browser and are skipped: threads,
atomics, dynamic library loading, CPU detection, native codec wrappers
(libav, GStreamer, Media Foundation, CoreAudio) and IP MIDI.

## Limits the browser imposes

- Ctrl-W, Ctrl-N, Ctrl-T and F11 belong to the browser unless the page is
  fullscreen in Chrome or Edge.
- The page cannot move the mouse pointer or quit the program.
- Files come and go through import and download, not a real disk.
- Web MIDI is missing in Safari.

## How to work on it

    ./serve.sh                 # http://127.0.0.1:8778
    python3 test/parity.py     # compare against the original (needs ../schism-web/dist)
    python3 tools/gen-data.py  # regenerate js/gen/ from ../schismtracker

Port one C file at a time, keep the C names and coordinates, and mark a file
ported only when parity (or audio comparison) passes. Update this file and
`PORTING.md` after each block.
