// Port of schism/page_vars.c (Schism Tracker, GPL-2.0-or-later).
import { app, provide, optional } from './app.js';
import { status, PAGE, HELP, NEED_UPDATE, SONG_NEEDS_SAVE, DIR_MODULES_CHANGED, DIR_SAMPLES_CHANGED,
	DIR_INSTRUMENTS_CHANGED, DIALOG_YES_NO } from './state.js';
import { draw_text, draw_char, draw_box, draw_fill_chars, DEFAULT_FG, BOX_THIN, BOX_THICK, BOX_INNER, BOX_INSET } from './vgamem.js';
import { widget_create_textentry, widget_create_thumbbar, widget_create_toggle, widget_create_togglebutton,
	widget_create_button, widget_togglebutton_set } from './widget.js';
import { dialog_create } from './dialog.js';
import { pages } from './page.js';
import { current_song, song_set_initial_tempo, song_set_initial_speed, song_set_initial_global_volume,
	song_set_mixing_volume, song_set_separation, song_set_old_effects, song_set_compatible_gxx,
	song_set_instrument_mode, song_is_stereo, song_set_stereo, song_set_mono, song_set_linear_pitch_slides,
	song_has_old_effects, song_has_compatible_gxx, song_is_instrument_mode, song_has_linear_pitch_slides,
	song_init_instruments } from './song.js';
import { cfg } from './page_loadmodule.js';

const group_control = [8, 9, -1], group_playback = [10, 11, -1], group_slides = [12, 13, -1];
let w = [];
const title_ref = { get value() { return current_song.title; }, set value(v) { current_song.title = v; } };
const dir_ref = key => ({ get value() { return cfg[key]; }, set value(v) { cfg[key] = v; } });

function song_vars_draw_const() {
	draw_box(16, 15, 43, 17, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(16, 18, 50, 21, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(16, 22, 34, 28, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(12, 41, 78, 45, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_fill_chars(20, 26, 33, 27, DEFAULT_FG, 0);
	draw_text('Song Variables', 33, 13, 3, 2);
	draw_text('Song Name', 7, 16, 0, 2);
	draw_text('Initial Tempo', 3, 19, 0, 2);
	draw_text('Initial Speed', 3, 20, 0, 2);
	draw_text('Global Volume', 3, 23, 0, 2);
	draw_text('Mixing Volume', 3, 24, 0, 2);
	draw_text('Separation', 6, 25, 0, 2);
	draw_text('Old Effects', 5, 26, 0, 2);
	draw_text('Compatible Gxx', 2, 27, 0, 2);
	draw_text('Control', 9, 30, 0, 2);
	draw_text('Playback', 8, 33, 0, 2);
	draw_text('Pitch Slides', 4, 36, 0, 2);
	draw_text('Directories', 34, 40, 3, 2);
	draw_text('Module', 6, 42, 0, 2);
	draw_text('Sample', 6, 43, 0, 2);
	draw_text('Instrument', 2, 44, 0, 2);
	for (let n = 1; n < 79; n++) draw_char(129, n, 39, 1, 2);
}
export function song_vars_sync_stereo() { widget_togglebutton_set(w, song_is_stereo() ? 10 : 11, 0); }
function update_values_in_song() {
	song_set_initial_tempo(w[1].d.value);
	song_set_initial_speed(w[2].d.value);
	song_set_initial_global_volume(w[3].d.value);
	song_set_mixing_volume(w[4].d.value);
	song_set_separation(w[5].d.value);
	song_set_old_effects(w[6].d.state);
	song_set_compatible_gxx(w[7].d.state);
	song_set_instrument_mode(w[8].d.state);
	if (w[10].d.state) { if (!song_is_stereo()) song_set_stereo(); }
	else if (song_is_stereo()) song_set_mono();
	song_set_linear_pitch_slides(w[12].d.state);
	status.flags |= SONG_NEEDS_SAVE;
}
function maybe_init_instruments() {
	song_set_instrument_mode(1);
	dialog_create(DIALOG_YES_NO, 'Initialise instruments?', () => song_init_instruments(-1), null, 0, null);
	status.flags |= SONG_NEEDS_SAVE;
}
function song_changed_cb() {
	w[0].d.cursor_pos = current_song.title.length;
	w[1].d.value = current_song.initial_tempo;
	w[2].d.value = current_song.initial_speed;
	w[3].d.value = current_song.initial_global_volume;
	w[4].d.value = current_song.mixing_volume;
	w[5].d.value = current_song.pan_separation;
	w[6].d.state = song_has_old_effects();
	w[7].d.state = song_has_compatible_gxx();
	widget_togglebutton_set(w, song_is_instrument_mode() ? 8 : 9, 0);
	widget_togglebutton_set(w, song_is_stereo() ? 10 : 11, 0);
	widget_togglebutton_set(w, song_has_linear_pitch_slides() ? 12 : 13, 0);
}

w = [
	widget_create_textentry(17, 16, 26, 0, 1, 1, () => { status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE; }, title_ref, 25),
	widget_create_thumbbar(17, 19, 33, 0, 2, 2, update_values_in_song, 31, 255),
	widget_create_thumbbar(17, 20, 33, 1, 3, 3, update_values_in_song, 1, 255),
	widget_create_thumbbar(17, 23, 17, 2, 4, 4, update_values_in_song, 0, 128),
	widget_create_thumbbar(17, 24, 17, 3, 5, 5, update_values_in_song, 0, 128),
	widget_create_thumbbar(17, 25, 17, 4, 6, 6, update_values_in_song, 0, 128),
	widget_create_toggle(17, 26, 5, 7, 5, 7, 7, update_values_in_song),
	widget_create_toggle(17, 27, 6, 8, 6, 8, 8, update_values_in_song),
	widget_create_togglebutton(17, 30, 11, 7, 10, 9, 9, 9, maybe_init_instruments, 'Instruments', 1, group_control),
	widget_create_togglebutton(32, 30, 11, 7, 11, 8, 8, 8, update_values_in_song, 'Samples', 1, group_control),
	widget_create_togglebutton(17, 33, 11, 8, 12, 11, 11, 11, update_values_in_song, 'Stereo', 1, group_playback),
	widget_create_togglebutton(32, 33, 11, 9, 13, 10, 10, 10, update_values_in_song, 'Mono', 1, group_playback),
	widget_create_togglebutton(17, 36, 11, 10, 14, 13, 13, 13, update_values_in_song, 'Linear', 1, group_slides),
	widget_create_togglebutton(32, 36, 11, 11, 14, 12, 12, 12, update_values_in_song, 'Amiga', 1, group_slides),
	widget_create_textentry(13, 42, 65, 12, 15, 15, () => { status.flags |= DIR_MODULES_CHANGED; }, dir_ref('dir_modules'), 255),
	widget_create_textentry(13, 43, 65, 14, 16, 16, () => { status.flags |= DIR_SAMPLES_CHANGED; }, dir_ref('dir_samples'), 255),
	widget_create_textentry(13, 44, 65, 15, 17, 17, () => { status.flags |= DIR_INSTRUMENTS_CHANGED; }, dir_ref('dir_instruments'), 255),
	widget_create_button(28, 47, 22, 16, 17, 17, 17, 17, () => optional('cfg_save'), 'Save all Preferences', 2),
];
w[8].next.backtab = 9;
w[17].next.backtab = 17;
Object.assign(pages[PAGE.SONG_VARIABLES], { title: 'Song Variables & Directory Configuration (F12)', draw_const: song_vars_draw_const,
	song_changed_cb, total_widgets: 18, widgets: w, help_index: HELP.GLOBAL, ported: true });

provide({ song_vars_sync_stereo });
void app;
