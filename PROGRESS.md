# Progress and to-do

Native JavaScript port of Schism Tracker. No WebAssembly, no build step.
Last updated 2026-11-14. Per-file detail is in `PORTING.md`.

## Where it stands

It works as a tracker in the browser: load a module (IT, XM, S3M, MOD, 669,
MTM, STM, STX, FAR, ULT, OKT, IMF, SFX, DSM, MDL, PSM, EdLib D00, MIDI files,
Doom MUS, also when MMCMP-packed or gzipped),
play it through Web Audio, edit patterns, samples, instruments and the order
list, then save as IT, S3M or MOD (or export to WAV/AIFF, also one file per channel). Files live in a virtual
disk in the browser (IndexedDB); you import from the real disk by dropping
files on the window or using `[Import from disk]` in any file list, and every
save is also downloaded.

    ./serve.sh            # http://127.0.0.1:8600/schism/

## What works

| Area | State |
|---|---|
| Player (csndfile, effects, sndmix, mixer, filters, equalizer) | ported; bit-exact with the native C build (test/cref.mjs); 40-700x realtime on one core |
| AdLib / OPL | ported (YMF262 emulator + snd_fm); S3M AdLib instruments and D00 render bit-exact |
| MIDI macros | Zxx / SFx filter macros, MIDI output macros |
| MIDI | Web MIDI ports on the MIDI screen (Shift-F1), MIDI output config page, instruments with a MIDI channel play on MIDI out, MIDI input keyjazz and recording (Ctrl-Z / Ctrl-X start triggers), General MIDI "tracker semantics" mode |
| Audio output | AudioWorklet fed from the main thread (~40 ms latency); keeps running in a background tab |
| Loaders | IT (incl. IT2.14/2.15 compressed samples), XM, S3M, MOD/15-sample MOD, 669, MTM, STM, STX, FAR, ULT, OKT, IMF, SFX, DSM, MDL, PSM (old/new/Sinaria), D00, MID and MUS (played through the AdLib GM patch bank); MMCMP and gzip unpacking; file-browser detection for every format upstream knows |
| Savers | IT, S3M, MOD; samples as ITS/S3I/SBI/AIFF/AU/WAV/RAW (Alt-T export dialog, Alt-O ITS); instruments as ITI; song export WAV, AIFF and per-channel MWAV/MAIFF, byte-identical to the C diskwriter |
| Sample/instrument loading | ITS, WAV (smpl loops, xtra), AIFF, 8SVX/16SV, AU, W64, SBI (AdLib), S3I, SNES BRR, ITI, XI, raw; MP3/Ogg/FLAC and compressed WAV via the browser's decoder; samples and instruments can be pulled out of any module (library browsing) |
| Pages | Pattern editor, sample list, instrument list (all 4 sub-pages with envelopes), order list (pan + volume), info page, song variables, message editor, load/save/export module, load sample/instrument + libraries, help, log, about, system config, preferences, palette editor, time information, MIDI screen, MIDI output configuration, waterfall (Alt-F12) |
| UI shell | menus, dialogs, all widgets, global keys, top bar, status line, clock, oscilloscope/VU/spectrum visualiser |
| Settings | saved to localStorage ("Save all Preferences" on F12, or Save on Shift-F5 / palette changes) |

## Checks

| Command | What it checks |
|---|---|
| `CREF_BIN=... node test/cref.mjs file...` | renders with the JS player and with native Schism (`--headless --diskwrite`) and compares PCM sample by sample; see PORTING.md for building the reference |
| `python3 test/parity.py` | pixel-compares 42 screen regions (all identical) with the original C build (`../schism-web`), including whole page bodies of the pattern editor, sample list, instrument sub-pages, order list, info page, song variables, message editor, help, config and dialogs |
| `node test/roundtrip.mjs file.it ...` | load, save as IT, reload: rendered PCM must be identical |
| `node test/formats.mjs file@fmt_s3m_save_song ...` | same for S3M/MOD saving |
| `node test/render.mjs in out.wav [secs]` | renders a module with the JS player (used to compare against libopenmpt) |
| `python3 test/smoke.py outdir module keys...` | drives the page in headless Chrome and takes screenshots |
| the original `test/*.py` / `test/*.mjs` | table, pitch, slide, filter, PCM and kernel parity against compiled C |

Measured 2026-11-14: 74 modules across all supported formats render identical
to the native C build over 60 s (a handful of files have one or two samples
off by one LSB). This comparison found and fixed two mixer bugs that affected
every song (samples started 16 frames late; a loop-end chunk count that did
not wrap like C's uint32, which froze looping samples for a moment). IT, S3M
and MOD round trips were reported sample-identical for compatible fixtures.

Checkpoint verification (2026-11-14): `test/data/tute.it` matches native C
exactly over 20 s and its IT save/reload preserves 20 s of PCM exactly.
The full screen parity suite passes with no browser errors or unported calls;
browser playback/page smoke checks and player integration, song model,
fixed-point timing, mixer and effects checks also pass.
Converting that IT fixture to S3M changes the audio; converting it to MOD
reloads but renders silence. Older-format conversion is not lossless for
arbitrary IT songs. The IT resaved file also differs in bytes despite identical PCM.

## Not done

- [ ] Instrument formats PAT (GUS) and SF2; FLAC saving (no encoder in the browser)
- [ ] bzip2 / xz / zstd packed modules (gzip and MMCMP work)
- [ ] A few files differ from the C build by one LSB in one sample every few minutes (cause not found)
- [ ] Font editor (itf.c)
- [ ] Text synth (Alt-Y in the sample list), sample editor drag-selection
- [ ] System clipboard paste (copy out works, paste uses the internal clipboard) - in progress
- [ ] Digraph / Alt-numpad / Unicode text entry (charset.c)
- [ ] Info page window layout and pattern editor options are not saved between sessions
- [ ] Changing the mixing rate needs a page reload

## Limits the browser imposes

- Audio starts on the first key press or click (browser autoplay rule).
- Ctrl-W, Ctrl-N, Ctrl-T and F11 belong to the browser unless the page is
  fullscreen in Chrome or Edge.
- The page cannot quit the program or move the mouse pointer.
- Files come and go through import and download, not a real disk.

## How to work on it

    ./serve.sh                 # http://127.0.0.1:8600/schism/
    python3 test/parity.py     # compare against the original (needs ../schism-web/dist)
    python3 tools/gen-data.py  # regenerate js/gen/ from ../schismtracker

Port one C file at a time and keep the C names and coordinates, so each JS
file can be read next to its C file.
