# Progress and to-do

Native JavaScript port of Schism Tracker. No WebAssembly, no build step.
Last updated 2026-11-13. Per-file detail is in `PORTING.md`.

## Where it stands

It works as a tracker in the browser: load a module (IT, XM, S3M, MOD),
play it through Web Audio, edit patterns, samples, instruments and the order
list, then save as IT, S3M or MOD (or render to WAV). Files live in a virtual
disk in the browser (IndexedDB); you import from the real disk by dropping
files on the window or using `[Import from disk]` in any file list, and every
save is also downloaded.

    ./serve.sh            # http://127.0.0.1:8778

## What works

| Area | State |
|---|---|
| Player (csndfile, effects, sndmix, mixer, filters, equalizer) | ported; renders 40-700x realtime on one core |
| Audio output | AudioWorklet fed from the main thread (~40 ms latency); keeps running in a background tab |
| Loaders | IT (incl. IT2.14/2.15 compressed samples), XM, S3M, MOD/15-sample MOD |
| Savers | IT, S3M, MOD; samples as ITS/WAV/RAW; instruments as ITI; song export to WAV |
| Sample/instrument loading | ITS, WAV, ITI, XI, raw; MP3/Ogg/FLAC/AIFF via the browser's decoder; samples and instruments can be pulled out of any module (library browsing) |
| Pages | Pattern editor, sample list, instrument list (all 4 sub-pages with envelopes), order list (pan + volume), info page, song variables, message editor, load/save/export module, load sample/instrument + libraries, help, log, about, system config, preferences, palette editor, time information |
| UI shell | menus, dialogs, all widgets, global keys, top bar, status line, clock, oscilloscope/VU visualiser |
| Settings | saved to localStorage ("Save all Preferences" on F12, or Save on Shift-F5 / palette changes) |

## Checks

| Command | What it checks |
|---|---|
| `python3 test/parity.py` | pixel-compares 42 screen regions (all identical) with the original C build (`../schism-web`), including whole page bodies of the pattern editor, sample list, instrument sub-pages, order list, info page, song variables, message editor, help, config and dialogs |
| `node test/roundtrip.mjs file.it ...` | load, save as IT, reload: rendered PCM must be identical |
| `node test/formats.mjs file@fmt_s3m_save_song ...` | same for S3M/MOD saving |
| `node test/render.mjs in out.wav [secs]` | renders a module with the JS player (used to compare against libopenmpt) |
| `python3 test/smoke.py outdir module keys...` | drives the page in headless Chrome and takes screenshots |
| the original `test/*.py` / `test/*.mjs` | table, pitch, slide, filter, PCM and kernel parity against compiled C |

Measured: IT/S3M/MOD/XM files render with the same loudness curve as
libopenmpt (per-second RMS within a constant gain factor; the gains differ
because the two players use different default mixing levels). IT, S3M and
MOD round trips are sample-identical; XM saved as IT differs only by the IT
format's coarser sample panning, as in real Schism.

## Not done

- [ ] MIDI (Web MIDI input/output, the two MIDI pages, General MIDI) - menu entries say "not ported"
- [ ] AdLib/OPL instruments (fmopl2/3 + snd_fm) - S3M AdLib channels are silent
- [ ] Other loaders: 669, MTM, FAR, ULT, STM, MDL, MED, OKT, PSM, AMF, IMF, PTM, MT2, MID ...
- [ ] Waterfall page, font editor, the FFT visualiser (shows the scope instead)
- [ ] Text synth (Alt-Y in the sample list), sample editor drag-selection
- [ ] System clipboard paste into the pattern editor (copy out works, paste uses the internal clipboard)
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

    ./serve.sh                 # http://127.0.0.1:8778
    python3 test/parity.py     # compare against the original (needs ../schism-web/dist)
    python3 tools/gen-data.py  # regenerate js/gen/ from ../schismtracker

Port one C file at a time and keep the C names and coordinates, so each JS
file can be read next to its C file.
