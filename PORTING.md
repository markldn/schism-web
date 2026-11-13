# Porting status

Hand port of Schism Tracker (C) to plain JavaScript, one C file at a time.
Tracks upstream commit `1266154c` (version 20261111).

Lines of C in scope: 86287. Fully ported or replaced: 7982. Partially ported files: 11985 lines (including csndfile.c, tables.c, effects.c, filters.c, mixutil.c, sndmix.c, mixer.c and equalizer.c; this is file scope, not completed code). Everything else is still to do.

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
| schism/audio_loadsave.c | 1172 | todo |  |
| schism/audio_playback.c | 2154 | todo |  |
| schism/charset.c | 1800 | todo |  |
| schism/charset_stdlib.c | 505 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/charset_unicode.c | 77 | todo |  |
| schism/clippy.c | 251 | todo |  |
| schism/config-parser.c | 533 | todo |  |
| schism/config.c | 553 | todo |  |
| schism/cpu.c | 170 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/dialog.c | 551 | ported | js/dialog.js |
| schism/disko.c | 1187 | todo |  |
| schism/dmoz.c | 2409 | todo |  |
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
| schism/midi-core.c | 1227 | todo |  |
| schism/midi-ip.c | 438 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/mplink.c | 846 | todo |  |
| schism/mt.c | 331 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| schism/page.c | 1870 | partial | js/page.js: frame, set_page, global keys, new-song/exit/time-jump/length dialogs, minipop sliders. Missing: _handle_ime, visualiser, clock, live top-info values |
| schism/page_about.c | 212 | todo |  |
| schism/page_blank.c | 55 | todo |  |
| schism/page_config.c | 424 | todo |  |
| schism/page_help.c | 310 | todo |  |
| schism/page_info.c | 1354 | todo |  |
| schism/page_instruments.c | 3124 | todo |  |
| schism/page_loadinst.c | 550 | todo |  |
| schism/page_loadmodule.c | 1202 | todo |  |
| schism/page_loadsample.c | 1068 | todo |  |
| schism/page_log.c | 349 | todo |  |
| schism/page_message.c | 893 | todo |  |
| schism/page_midi.c | 378 | todo |  |
| schism/page_midiout.c | 179 | todo |  |
| schism/page_orderpan.c | 1068 | todo |  |
| schism/page_palette.c | 312 | todo |  |
| schism/page_patedit.c | 4790 | todo |  |
| schism/page_preferences.c | 396 | todo |  |
| schism/page_samples.c | 2100 | todo |  |
| schism/page_timeinfo.c | 232 | todo |  |
| schism/page_vars.c | 243 | todo |  |
| schism/page_waterfall.c | 577 | todo |  |
| schism/palettes.c | 462 | partial | js/palettes.js; config load/save not ported |
| schism/pattern-view.c | 974 | todo |  |
| schism/sample-edit.c | 613 | todo |  |
| schism/slurp.c | 1378 | partial | js/slurp.js memory read/seek/getc subset; sample decoder integration tests pass. Remaining APIs pending. |
| schism/status.c | 200 | partial | flash text only; playing-status lines need the player |
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
| player/csndfile.c | 2142 | partial | js/csndfile.js: pattern allocation/emptiness, order/pattern counts, instrument initialization. Core song/sample/channel allocation, sample emptiness/count/free-slot helpers and highest-used-channel scan added. Instrument emptiness/count/free-slot helpers and playmark reset implemented. Generated voice layout, voice allocation, csf_set_current_order and csf_loop_pattern added; targeted positioning checks pass. csf_stop_sample/csf_destroy_sample added; node test/song-model.mjs checks active-reference cleanup and metadata preservation. Restart-position insertion and float32 VU aggregation added with model checks. Live sample-update propagation added with sustain/normal-loop, data-shortening and flag tests. Sample loop sanitization/padding/lookahead added with endpoint/loop tests. 7/8/16-bit PCM decode and 24/32-bit normalized PCM plus 32/64-bit IEEE input added; targeted split-delta/endian/truncation/IEEE-clipping tests pass. S3M/IT effect import/export translation added with generated mapping and surround/break/volume tests. Broad input/effect parity pending. Not wired into UI; full reset, playback and audio verification pending. |
| player/effects.c | 2453 | partial | js/effects.js: pitch conversions and frequency slide helper; 10,844 note/frequency and slide cases match compiled C via test/pitch-parity.py; transpose helpers have targeted checks only. Portamento up/down, tone portamento and IMF note-slide handlers added with targeted test/effects.mjs checks. Volume/panning slides and normal/fine vibrato parameter setup added with tick/memory/clamping checks. Tremolo/panbrello waveforms added with injected-random tests; default random sequence differs from libc. Channel/global-volume slides and pattern-loop countdown added with targeted tests. All four volume/panning slide handlers pass 10,240 compiled-C state comparisons in test/slide-parity.py. Instrument/sample panning and generated quirk indices/defaults added with precedence/surround tests. Note-cut/key-off handlers added with sustain-release/position/fade tests; MIDI/OPL hooks still unported. Retrigger handler added with countdown/volume/quirk checks; note-change/NNA providers pending. fx_special ported with targeted delay/pan/reverse/offset/envelope/background/macro tests. Row handle_effect dispatch implemented (MIDI provider pending), with generated FX constants and speed/tempo/jump tests. Volume-column dispatcher added with delayed-start/memory/porta/vibrato-speed tests. Ordered cross-column portamento memory initialization added with precedence/Compat Gxx tests. Per-channel scheduler/dispatch and pattern-break pass implemented; length-mode/SD2/loop tests pass. csf_process_note_start block implemented with remembered-note ordering/pan tests; envelope-reset/keyboard-sample helpers implemented with carry/Compat Gxx/fallback tests; instrument-change provider implemented with sample-binding/sustain-loop tests; note-change implemented with pitch/sustain/porta tests; NNA allocator/voice-copy helpers implemented with mute/quietest/history tests; duplicate/new-note actions implemented with sample-mode transfer tests; MIDI and broader instrument/NNA differential checks remain pending; audio parity pending. |
| player/equalizer.c | 280 | partial | js/equalizer.js: EQ setup/filtering and normalization; targeted test/equalizer.mjs passes. C coefficient/signal comparisons and UI wiring pending. |
| player/filters.c | 128 | partial | js/filters.js and extracted resonance LUT; 21,544 coefficient/state cases match compiled C via test/filter-parity.py; mixer integration and audio parity pending. |
| player/fmopl2.c | 2091 | todo |  |
| player/fmopl3.c | 2552 | todo |  |
| player/fmpatches.c | 179 | todo |  |
| player/mixer.c | 882 | partial | js/mixer.js begins chunk scheduling/wrap/reflection; test/mixer.mjs passes. Lookahead routing/state initialization added with address/chunk/post-wrap tests. Nearest/linear mono/stereo 8/16-bit kernels added with scaling/channel/midpoint tests; filter/ramp variants implemented but broader tests pending. Padded samples and stereo mix-loop orchestration implemented; integration renders nonzero PCM. Fake VU added with scaling/peak tests; spline/FIR kernels and extracted LUTs added with constant-signal tests; reverse/stereo/16-bit and 64 kernel variants match compiled upstream macros for nonconstant fractional-step data (samples/position/VU/ramp state). Four FIR resize helpers added with constant-signal 8/16-bit mono/stereo tests. Broader boundaries/resizer comparisons and full audio parity pending. |
| player/mixutil.c | 197 | partial | js/mixutil.js: buffer/offset/mono/PCM utilities implemented; targeted test/mixutil.mjs checks pass; 1,004 PCM buffers/65,648 samples match C bytes/extrema via test/mixutil-parity.py. Offset-decay differential and full audio parity pending. |
| player/snd_fm.c | 648 | todo |  |
| player/snd_gm.c | 706 | todo |  |
| player/sndmix.c | 1301 | partial | js/sndmix.js: order advancement and tick/row scheduling; test/sndmix.mjs passes. Playback tremor/vibrato/arpeggio helpers added with phase/octave/timing tests. Volume/pan envelope interpolation and fadeout added with targeted checks. Envelope advancement added with sustain-release/loop/end/disabled tests. Sample autovibrato added with sweep/cap/zero-speed checks, preserving 65535 table-zero rounding. Per-voice mixer setup added with pan/surround/gain/list checks; pitch/filter envelope interpolation added with routing/bypass tests; MIDI/OPL key routing and generated volume thresholds added with recorded-transport tests; csf_read_note per-tick voice setup implemented; integrated gain/increment/tick/mix-list checks pass. csf_read output buffering implemented; integration renders 1,024 16-bit frames across a tick boundary. Providers, other output/export branches, broader C comparisons and audio parity pending. |
| player/tables.c | 440 | partial | All 14 arrays extracted to js/gen/tables.js; 1,582 values match compiled C via test/player-tables.py. Playback integration/audio parity pending. |
| fmt/669.c | 345 | todo |  |
| fmt/aiff.c | 814 | todo |  |
| fmt/ams.c | 57 | todo |  |
| fmt/au.c | 247 | todo |  |
| fmt/avformat.c | 689 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| fmt/brr.c | 238 | todo |  |
| fmt/bzip2.c | 199 | todo |  |
| fmt/compression.c | 779 | todo |  |
| fmt/d00.c | 939 | todo |  |
| fmt/dsm.c | 444 | todo |  |
| fmt/edl.c | 91 | todo |  |
| fmt/f2r.c | 49 | todo |  |
| fmt/far.c | 292 | todo |  |
| fmt/flac.c | 918 | todo |  |
| fmt/generic.c | 589 | todo |  |
| fmt/gstreamer.c | 647 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| fmt/iff.c | 371 | todo |  |
| fmt/imf.c | 744 | todo |  |
| fmt/it.c | 1114 | todo |  |
| fmt/iti.c | 647 | todo |  |
| fmt/its.c | 363 | todo |  |
| fmt/liq.c | 58 | todo |  |
| fmt/macosxca.c | 315 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| fmt/mdl.c | 1191 | todo |  |
| fmt/med.c | 126 | todo |  |
| fmt/mf.c | 56 | todo |  |
| fmt/mid.c | 539 | todo |  |
| fmt/mmcmp.c | 374 | todo |  |
| fmt/mod.c | 808 | todo |  |
| fmt/mp3.c | 98 | todo |  |
| fmt/mt2.c | 55 | todo |  |
| fmt/mtm.c | 278 | todo |  |
| fmt/mus.c | 389 | todo |  |
| fmt/ntk.c | 47 | todo |  |
| fmt/ogg.c | 162 | todo |  |
| fmt/okt.c | 509 | todo |  |
| fmt/pat.c | 304 | todo |  |
| fmt/psm.c | 1421 | todo |  |
| fmt/raw.c | 64 | todo |  |
| fmt/s3i.c | 274 | todo |  |
| fmt/s3m.c | 1217 | todo |  |
| fmt/sbi.c | 106 | todo |  |
| fmt/sf2.c | 356 | todo |  |
| fmt/sfx.c | 285 | todo |  |
| fmt/stm.c | 296 | todo |  |
| fmt/stx.c | 337 | todo |  |
| fmt/ult.c | 431 | todo |  |
| fmt/w64.c | 246 | todo |  |
| fmt/wav.c | 526 | todo |  |
| fmt/win32mf.c | 1153 | n/a | platform plumbing with no browser equivalent, or a native-library wrapper |
| fmt/xi.c | 572 | todo |  |
| fmt/xm.c | 959 | todo |  |
| fmt/xz.c | 193 | todo |  |
| fmt/zlib.c | 205 | todo |  |
| fmt/zstd.c | 230 | todo |  |
