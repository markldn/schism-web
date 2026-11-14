# Porting status

Hand port of Schism Tracker (C) to plain JavaScript, one C file at a time.
Tracks upstream commit `1266154c` (version 20261111).

Lines of C in scope: 86287. See PROGRESS.md for the current overview; the table below gives per-file status.

## Verification against the C build

`test/cref.mjs` renders modules with a native build of the same Schism source
(`schismtracker --headless --diskwrite`) and with the JS player, and compares
the PCM sample by sample. Build the reference once (needs only SDL2 headers;
the SDL library is loaded at run time):

    cp -r ../schismtracker /tmp/st && cd /tmp/st && autoreconf -i
    mkdir build && cd build && ../configure --without-flac --without-jack --without-alsa \
        --without-gstreamer --without-avformat --without-sdl12 --without-sdl3 --enable-sdl2-linking \
        SDL2_CFLAGS="-I/path/to/SDL2/include" SDL2_LIBS=-lSDL2 \
        UTF8PROC_CFLAGS=-I/path/to/utf8proc UTF8PROC_LIBS=/path/to/libutf8proc.a && make
    CREF_BIN=/tmp/st/build/schismtracker node test/cref.mjs --secs 60 file.it ...

C seeds rand() from the clock, so songs with random volume/pan swing or random
waveforms differ run to run; `CREF_RAND=1073741823 CREF_RAND_SO=fixrand.so`
pins rand() on both sides (fixrand.so: `int rand(void){return 1073741823;}`
built as a shared object for LD_PRELOAD).

As of 2026-11-14, 74 modules (IT, XM, S3M with and without AdLib, MOD, 669,
MTM, STM, FAR, ULT, OKT, IMF, SFX, DSM, MDL, PSM, D00) render identically to the
C build over 60 s, apart from at most a few samples off by one LSB in some files.

## Rules

- Port, don't redesign: keep C function names, coordinates, colours and control flow so each JS file can be read next to its C file.
- A file is `ported` only when `test/parity.py` shows the screens it draws are pixel-identical to the reference build (`../schism-web`, the same C compiled with Emscripten), or, for the player, when rendered audio matches.
- Calls into files that are not ported go through `app.<name>()` (js/app.js), which flashes "Not ported yet" instead of failing silently.
- Constant tables are extracted by `tools/gen-data.py`, never retyped.

## Suggested order

1. (done) keyboard.c, widget.c, widget-keyhandler.c, dialog.c, `handle_key` in page.c
2. Song model and player: csndfile.c, tables.c, effects.c, sndmix.c, mixer.c, mixutil.c, filters.c, equalizer.c, then audio_playback.c on an AudioWorklet
3. fmt/it.c + compression.c, s3m.c, xm.c, mod.c, then audio_loadsave.c and the load/save pages (dmoz.c becomes a browser file store)
4. page_patedit.c + pattern-view.c
5. page_samples.c + sample-edit.c, page_instruments.c
6. page_orderpan.c, page_vars.c, page_message.c, page_info.c, page_help.c, page_about.c, page_log.c
7. page_config.c, page_preferences.c, page_palette.c, itf.c (font editor), page_waterfall.c, page_timeinfo.c
8. midi-core.c with a Web MIDI provider, page_midi.c, page_midiout.c, snd_gm.c
9. disko.c (WAV/AIFF export), remaining fmt/ loaders, fmopl2/3.c + snd_fm.c (AdLib)

Integration: `node test/player-integration.mjs` exercises real model/tick/effect/instrument/note/NNA providers across two rows and song-end stopping, with only MIDI hooks substituted. Missing initial playback scalar fields fixed. No sample rendering yet.

Header helpers: `js/sndfile.js` ports fixed-point sample position arithmetic and tick/sample timing from `include/player/sndfile.h`. Targeted `node test/sndfile.mjs` checks pass; C differential checks/integration pending. Header lines are outside the C-file totals.

Player initialization/configuration now connects csf_set_wave_config, csf_init_player, resampling validation and the song_init_eq wrapper; integration checks 48 kHz ramps with MIDI/OPL initialization substituted.

Song-length calculation now uses copied inline playback state and the tick engine; integration checks speed changes and preservation of live voice/order state. Full-song timing differential coverage pending.

## Files

| C file | lines | status | notes |
|---|---:|---|---|
| schism/atomic.c | 508 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/audio_loadsave.c | 1172 | partial | js/song.js, js/page_loadmodule.js: load/save/export, sample+instrument load/save |
| schism/audio_playback.c | 2154 | ported | js/song.js: transport, keyjazz, mute/solo, AudioWorklet output, MIDI/OPL hooks |
| schism/charset.c | 1800 | todo |  |
| schism/charset_stdlib.c | 505 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/charset_unicode.c | 77 | todo |  |
| schism/clippy.c | 251 | todo |  |
| schism/config-parser.c | 533 | todo |  |
| schism/config.c | 553 | replaced | js/page_config.js: localStorage |
| schism/cpu.c | 170 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/dialog.c | 551 | ported | js/dialog.js |
| schism/disko.c | 1187 | replaced | js/fmt/savers.js: WAV/AIFF and per-channel browser export |
| schism/dmoz.c | 2409 | replaced | js/dmoz.js: IndexedDB virtual disk, import/download |
| schism/events.c | 214 | replaced | DOM events in js/main.js + js/keyboard.js |
| schism/fakemem.c | 139 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/fonts.c | 252 | partial | font reset in js/vgamem.js; loading .itf files from disk not ported |
| schism/ieee-float.c | 763 | todo |  |
| schism/isysev.c | 1375 | todo |  |
| schism/itf.c | 1121 | todo |  |
| schism/keyboard.c | 685 | ported | js/keyboard.js; key repeat left to the browser |
| schism/loadso.c | 302 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/main.c | 1444 | replaced | js/main.js (event loop) |
| schism/mem.c | 65 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/menu.c | 537 | ported | js/menu.js |
| schism/midi-core.c | 1227 | ported | js/midi.js: Web MIDI provider (ports = browser MIDI devices), send with audio-latency timestamps, input -> key events; no IP MIDI |
| schism/midi-ip.c | 438 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/mplink.c | 846 | ported | js/song.js |
| schism/mt.c | 331 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/page.c | 1870 | ported | js/page.js; spectrum via js/page_waterfall.js; no IME |
| schism/page_about.c | 212 | ported | js/page_misc.js |
| schism/page_blank.c | 55 | todo |  |
| schism/page_config.c | 424 | ported | js/page_config.js |
| schism/page_help.c | 310 | ported | js/page_misc.js |
| schism/page_info.c | 1354 | ported | js/page_info.js (layout not saved) |
| schism/page_instruments.c | 3124 | ported | js/page_instruments.js |
| schism/page_loadinst.c | 550 | ported | js/page_loadsample.js |
| schism/page_loadmodule.c | 1202 | ported | js/page_loadmodule.js |
| schism/page_loadsample.c | 1068 | partial | js/page_loadsample.js: preview widgets read-only |
| schism/page_log.c | 349 | ported | js/page_misc.js |
| schism/page_message.c | 893 | ported | js/page_message.js (no drag selection) |
| schism/page_midi.c | 378 | ported | js/page_midi.js |
| schism/page_midiout.c | 179 | ported | js/page_midi.js |
| schism/page_orderpan.c | 1068 | ported | js/page_orderpan.js |
| schism/page_palette.c | 312 | ported | js/page_palette.js |
| schism/page_patedit.c | 4790 | ported | js/page_patedit.js (MIDI recording; no pattern-to-sample) |
| schism/page_preferences.c | 396 | ported | js/page_config.js (one Web Audio device) |
| schism/page_samples.c | 2100 | ported | js/page_samples.js (no AdLib dialogs, no text synth) |
| schism/page_timeinfo.c | 232 | ported | js/page_timeinfo.js |
| schism/page_vars.c | 243 | ported | js/page_vars.js |
| schism/page_waterfall.c | 577 | ported | js/page_waterfall.js: waterfall and FFT spectrum |
| schism/palettes.c | 462 | partial | js/palettes.js; config load/save not ported |
| schism/pattern-view.c | 974 | ported | js/pattern-view.js |
| schism/sample-edit.c | 613 | ported | js/sample-edit.js |
| schism/slurp.c | 1378 | partial | js/slurp.js memory read/seek/getc subset; sample decoder integration tests pass. Remaining APIs pending. |
| schism/status.c | 200 | ported | js/page.js |
| schism/str.c | 586 | todo |  |
| schism/timer.c | 317 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/tree.c | 221 | todo |  |
| schism/util-altivec.c | 68 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/util.c | 514 | todo |  |
| schism/version.c | 448 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/vgamem.c | 997 | ported | js/vgamem.js; Unicode path lacks cp437/cp866/hiragana tables; draw_sample_data wrapper waits for song |
| schism/video.c | 1754 | replaced | js/video.js (canvas); software mouse cursor not ported |
| schism/widget-keyhandler.c | 1055 | ported | js/widget.js |
| schism/widget.c | 745 | ported | js/widget.js; typed text limited to ASCII until charset.c lands |
| schism/xpmdata.c | 317 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| player/csndfile.c | 2142 | ported | js/csndfile.js; renders bit-exact with the native build (test/cref.mjs) |
| player/effects.c | 2453 | ported | js/effects.js + js/midimacro.js (Zxx/SFx macros, filters) + js/midi.js (csf_midi_out_note); bit-exact renders |
| player/equalizer.c | 280 | ported | js/equalizer.js (EQ is off by default, so not covered by the render comparison) |
| player/filters.c | 128 | ported | js/filters.js; bit-exact renders incl. OpenMPT filter test modules |
| player/fmopl2.c | 2091 | n/a | the native build is configured for OPL3 (OPLSOURCE 3); fmopl3.js is used instead |
| player/fmopl3.c | 2552 | ported | js/fmopl3.js (YMF262, the chip the native build uses) |
| player/fmpatches.c | 179 | ported | js/gen/fmpatches.js: extracted General MIDI AdLib patch bank |
| player/mixer.c | 882 | ported | js/mixer.js; bit-exact renders (fixed 2026-11-14: sample start was 16 frames late, loop-end chunk count did not wrap like the C uint32) |
| player/mixutil.c | 197 | ported | js/mixutil.js; bit-exact renders |
| player/snd_fm.c | 648 | ported | js/snd_fm.js; bit-exact with the native build (test/cref.mjs) |
| player/snd_gm.c | 706 | ported | js/midi.js |
| player/sndmix.c | 1301 | ported | js/sndmix.js; bit-exact renders |
| player/tables.c | 440 | ported | js/gen/tables.js (extracted) |
| fmt/669.c | 345 | ported | js/fmt/loaders2.js |
| fmt/aiff.c | 814 | partial | native sample loading in js/fmt/samples.js; sample/song saving in savers.js |
| fmt/ams.c | 57 | ported | file info only, js/fmt/info.js |
| fmt/au.c | 247 | ported | js/fmt/samples.js + savers.js |
| fmt/avformat.c | 689 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| fmt/brr.c | 238 | ported | sample loading in js/fmt/samples.js |
| fmt/bzip2.c | 199 | todo |  |
| fmt/compression.c | 779 | partial | IT 2.14/2.15 decompression in js/fmt/loaders.js; MDL/DMF not ported |
| fmt/d00.c | 939 | ported | js/fmt/loaders2.js (guards the C endless loop on truncated pattern data) |
| fmt/dsm.c | 444 | ported | js/fmt/loaders2.js |
| fmt/edl.c | 91 | todo |  |
| fmt/f2r.c | 49 | ported | file info only, js/fmt/info.js |
| fmt/far.c | 292 | ported | js/fmt/loaders2.js |
| fmt/flac.c | 918 | todo |  |
| fmt/generic.c | 589 | partial | js/fmt/loaders.js |
| fmt/gstreamer.c | 647 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| fmt/iff.c | 371 | partial | chunk reading in js/fmt/loaders2.js |
| fmt/imf.c | 744 | ported | js/fmt/loaders2.js |
| fmt/it.c | 1114 | ported | js/fmt/loaders.js + savers.js |
| fmt/iti.c | 647 | ported | js/fmt/loaders.js + savers.js |
| fmt/its.c | 363 | ported | js/fmt/loaders.js + savers.js |
| fmt/liq.c | 58 | ported | file info only, js/fmt/info.js |
| fmt/macosxca.c | 315 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| fmt/mdl.c | 1191 | ported | js/fmt/loaders2.js (+ MDL sample decompression) |
| fmt/med.c | 126 | ported | file info only, js/fmt/info.js |
| fmt/mf.c | 56 | ported | file info only, js/fmt/info.js |
| fmt/mid.c | 539 | ported | js/fmt/loaders2.js |
| fmt/mmcmp.c | 374 | ported | js/fmt/mmcmp.js; gzip via the browser DecompressionStream |
| fmt/mod.c | 808 | ported | js/fmt/loaders.js + savers.js |
| fmt/mp3.c | 98 | todo |  |
| fmt/mt2.c | 55 | ported | file info only (as upstream), js/fmt/info.js |
| fmt/mtm.c | 278 | ported | js/fmt/loaders2.js |
| fmt/mus.c | 389 | ported | js/fmt/loaders2.js |
| fmt/ntk.c | 47 | ported | file info only, js/fmt/info.js |
| fmt/ogg.c | 162 | todo |  |
| fmt/okt.c | 509 | ported | js/fmt/loaders2.js |
| fmt/pat.c | 304 | todo |  |
| fmt/psm.c | 1421 | ported | js/fmt/loaders2.js (new PSM, Sinaria, PSM16) |
| fmt/raw.c | 64 | ported | js/fmt/info.js + savers.js |
| fmt/s3i.c | 274 | ported | js/fmt/samples.js + savers.js |
| fmt/s3m.c | 1217 | ported | js/fmt/loaders.js + savers.js |
| fmt/sbi.c | 106 | ported | js/fmt/samples.js + savers.js |
| fmt/sf2.c | 356 | todo |  |
| fmt/sfx.c | 285 | ported | js/fmt/loaders2.js |
| fmt/stm.c | 296 | ported | js/fmt/loaders2.js |
| fmt/stx.c | 337 | ported | js/fmt/loaders2.js (no test file found) |
| fmt/ult.c | 431 | ported | js/fmt/loaders2.js |
| fmt/w64.c | 246 | ported | sample loading in js/fmt/samples.js |
| fmt/wav.c | 526 | ported | js/fmt/info.js + savers.js |
| fmt/win32mf.c | 1153 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| fmt/xi.c | 572 | partial | loader in js/fmt/info.js |
| fmt/xm.c | 959 | ported | loader in js/fmt/loaders.js |
| fmt/xz.c | 193 | todo |  |
| fmt/zlib.c | 205 | todo |  |
| fmt/zstd.c | 230 | todo |  |
