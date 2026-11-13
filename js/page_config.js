// Ports of schism/page_config.c and schism/page_preferences.c, plus a small
// replacement for schism/config.c that keeps settings in localStorage
// (Schism Tracker, GPL-2.0-or-later). Audio device/driver lists collapse to
// the one Web Audio output; video scaling maps to canvas smoothing.
import { app, provide, optional } from './app.js';
import { status, PAGE, HELP, NEED_UPDATE, CLASSIC_MODE, MIDI_LIKE_TRACKER } from './state.js';
import { draw_text, draw_char, draw_box, draw_fill_chars, DEFAULT_FG, BOX_THIN, BOX_THICK, BOX_INNER, BOX_INSET } from './vgamem.js';
import { kbd_sharp_flat_state, kbd_sharp_flat_toggle, KBD_SHARP_FLAT_FLATS, KBD_SHARP_FLAT_SHARPS,
	kbd_get_current_octave, kbd_set_current_octave } from './keyboard.js';
import { widget_create_thumbbar, widget_create_numentry, widget_create_menutoggle, widget_create_toggle,
	widget_create_togglebutton, widget_create_button, widget_create_listbox } from './widget.js';
import { pages } from './page.js';
import { current_song, audio_settings, song_init_modplug, audio_sample_rate } from './song.js';
import { song_init_eq } from './equalizer.js';
import { current_palette, current_palette_index, palette_apply, palette_load_preset, set_current_palette_index } from './palettes.js';
import { cfg as dirs } from './page_loadmodule.js';

const flash = t => app.status_text_flash(t);
const SAVED = 'Configuration will be saved when you press Save';

// ------------------------------------------------------------------ settings store
const video = { interpolation: 0, fullscreen: 0 };
export function cfg_save(quiet) {
	const data = {
		audio: { ...audio_settings, master: { ...audio_settings.master } },
		vis_style: status.vis_style, time_display: status.time_display,
		classic: status.flags & CLASSIC_MODE ? 1 : 0, midi_like_tracker: status.flags & MIDI_LIKE_TRACKER ? 1 : 0,
		flats: kbd_sharp_flat_state() === KBD_SHARP_FLAT_FLATS ? 1 : 0, octave: kbd_get_current_octave(),
		palette: current_palette.map(c => c.slice()), palette_index: current_palette_index, video: { ...video }, dirs: { ...dirs },
	};
	try { localStorage.setItem('schism-config', JSON.stringify(data)); if (!quiet) flash('Configuration saved'); }
	catch { flash('Could not save configuration (browser storage blocked)'); }
}
export function cfg_load() {
	let data;
	try { data = JSON.parse(localStorage.getItem('schism-config') || 'null'); } catch { data = null; }
	if (!data) return;
	if (data.audio) Object.assign(audio_settings, data.audio, { master: { ...audio_settings.master, ...(data.audio.master || {}) } });
	if (data.vis_style !== undefined) status.vis_style = data.vis_style;
	if (data.time_display !== undefined) status.time_display = data.time_display;
	if (data.classic) status.flags |= CLASSIC_MODE;
	if (data.midi_like_tracker) status.flags |= MIDI_LIKE_TRACKER;
	if (data.flats) kbd_sharp_flat_toggle(KBD_SHARP_FLAT_FLATS);
	if (data.octave !== undefined) kbd_set_current_octave(data.octave);
	if (data.palette) { data.palette.forEach((c, i) => { if (current_palette[i]) current_palette[i] = c.slice(); }); if (data.palette_index !== undefined) set_current_palette_index(data.palette_index); palette_apply(); }
	if (data.video) { Object.assign(video, data.video); apply_video_interpolation(); }
	if (data.dirs) Object.assign(dirs, data.dirs);
}
function apply_video_interpolation() {
	const c = document.getElementById('screen');
	if (c) c.style.imageRendering = video.interpolation === 0 ? 'pixelated' : 'auto';
}

// ------------------------------------------------------------------ config page (Ctrl-F1)
const time_displays = ['Off', 'Play / Elapsed', 'Play / Clock', 'Play / Off', 'Elapsed', 'Clock', 'Absolute'];
const vis_styles = ['Off', 'Memory Stats', 'Oscilloscope', 'VU Meter', 'Monoscope', 'Spectrum'];
const sharp_flat = ['Sharps (#)', 'Flats (b)'];
const output_channels = ['Mono', 'Stereo'];
const bit_rates = ['8 Bit', '16 Bit', '32 Bit'];
const midi_modes = ['IT semantics', 'Tracker semantics'];
const wc = [];
function change_mixer_limits() {
	audio_settings.channel_limit = wc[0].d.value;
	audio_settings.sample_rate = wc[1].d.value;
	audio_settings.bits = [8, 16, 32][wc[2].d.state] || 16;
	audio_settings.channels = wc[3].d.state + 1;
	song_init_modplug();
	flash(audio_settings.sample_rate !== audio_sample_rate() ? 'Mixing rate applies after a reload; ' + SAVED : SAVED);
}
function change_ui_settings() {
	status.vis_style = wc[4].d.state;
	status.time_display = wc[7].d.state;
	if (wc[5].d.state) status.flags |= CLASSIC_MODE; else status.flags &= ~CLASSIC_MODE;
	kbd_sharp_flat_toggle(wc[6].d.state ? KBD_SHARP_FLAT_FLATS : KBD_SHARP_FLAT_SHARPS);
	if (wc[8].d.state) status.flags |= MIDI_LIKE_TRACKER; else status.flags &= ~MIDI_LIKE_TRACKER;
	status.flags |= NEED_UPDATE;
	flash(SAVED);
}
function change_video_settings() {
	video.interpolation = wc[11].d.state ? 0 : wc[12].d.state ? 1 : 2;
	apply_video_interpolation();
	const want_fs = wc[9].d.state ? 1 : 0;
	if (want_fs !== (document.fullscreenElement ? 1 : 0)) app.toggle_display_fullscreen();
	palette_apply();
	status.flags |= NEED_UPDATE;
}
function config_draw_const() {
	draw_text('Channel Limit', 4, 15, 0, 2);
	draw_text('Mixing Rate', 6, 16, 0, 2);
	draw_text('Sample Size', 6, 17, 0, 2);
	draw_text('Output Channels', 2, 18, 0, 2);
	draw_text('Visualization', 4, 20, 0, 2);
	draw_text('Classic Mode', 5, 21, 0, 2);
	draw_text('Accidentals', 6, 22, 0, 2);
	draw_text('Time Display', 5, 23, 0, 2);
	draw_text('MIDI mode', 8, 25, 0, 2);
	draw_text('Video Scaling:', 2, 28, 0, 2);
	draw_text('Video Rendering:', 2, 40, 0, 2);
	draw_text('Full Screen:', 38, 28, 0, 2);
	draw_fill_chars(18, 15, 34, 25, DEFAULT_FG, 0);
	draw_box(17, 14, 35, 26, BOX_THIN | BOX_INNER | BOX_INSET);
	for (let n = 18; n < 35; n++) { draw_char(154, n, 19, 3, 0); draw_char(154, n, 24, 3, 0); }
}
function config_set_page() {
	wc[0].d.value = audio_settings.channel_limit;
	wc[1].d.value = audio_settings.sample_rate;
	wc[2].d.state = audio_settings.bits === 8 ? 0 : audio_settings.bits === 32 ? 2 : 1;
	wc[3].d.state = audio_settings.channels - 1;
	wc[4].d.state = status.vis_style;
	wc[5].d.state = status.flags & CLASSIC_MODE ? 1 : 0;
	wc[6].d.state = kbd_sharp_flat_state() === KBD_SHARP_FLAT_FLATS ? 1 : 0;
	wc[7].d.state = status.time_display;
	wc[8].d.state = status.flags & MIDI_LIKE_TRACKER ? 1 : 0;
	const fs = document.fullscreenElement ? 1 : 0;
	wc[9].d.state = fs; wc[10].d.state = !fs ? 1 : 0;
	wc[11].d.state = video.interpolation === 0 ? 1 : 0;
	wc[12].d.state = video.interpolation === 1 ? 1 : 0;
	wc[13].d.state = video.interpolation === 2 ? 1 : 0;
	wc[14].d.state = 1; wc[15].d.state = 0;
}
{
	const fsg = [9, 10, -1], vg = [11, 12, 13, -1], rg = [14, 15, -1];
	wc.push(
		widget_create_thumbbar(18, 15, 17, 0, 1, 1, change_mixer_limits, 4, 256),
		widget_create_numentry(18, 16, 7, 0, 2, 2, change_mixer_limits, 4000, 192000, { value: 0 }),
		widget_create_menutoggle(18, 17, 1, 3, 2, 2, 3, change_mixer_limits, bit_rates),
		widget_create_menutoggle(18, 18, 2, 4, 3, 3, 4, change_mixer_limits, output_channels),
		widget_create_menutoggle(18, 20, 3, 5, 4, 4, 5, change_ui_settings, vis_styles),
		widget_create_toggle(18, 21, 4, 6, 5, 5, 6, change_ui_settings),
		widget_create_menutoggle(18, 22, 5, 7, 6, 6, 7, change_ui_settings, sharp_flat),
		widget_create_menutoggle(18, 23, 6, 8, 7, 7, 8, change_ui_settings, time_displays),
		widget_create_menutoggle(18, 25, 7, 11, 8, 8, 11, change_ui_settings, midi_modes),
		widget_create_togglebutton(44, 30, 5, 8, 9, 11, 10, 10, change_video_settings, 'Yes', 2, fsg),
		widget_create_togglebutton(54, 30, 5, 10, 10, 9, 10, 0, change_video_settings, 'No', 2, fsg),
		widget_create_togglebutton(6, 30, 26, 8, 12, 11, 9, 12, change_video_settings, 'Nearest', 2, vg),
		widget_create_togglebutton(6, 33, 26, 11, 13, 12, 9, 13, change_video_settings, 'Linear', 2, vg),
		widget_create_togglebutton(6, 36, 26, 12, 14, 13, 9, 14, change_video_settings, 'Best', 2, vg),
		widget_create_togglebutton(6, 42, 26, 13, 15, 14, 9, 15, change_video_settings, 'Hardware', 2, rg),
		widget_create_togglebutton(6, 45, 26, 14, 15, 15, 9, 16, change_video_settings, 'Software', 2, rg),
	);
	Object.assign(pages[PAGE.CONFIG], { title: 'System Configuration (Ctrl-F1)', draw_const: config_draw_const,
		set_page: config_set_page, total_widgets: 16, widgets: wc, help_index: HELP.GLOBAL, ported: true });
}

// ------------------------------------------------------------------ preferences (Shift-F5)
const interpolation_modes = ['Non-Interpolated', 'Linear', 'Cubic Spline', '8-Tap FIR Filter'];
const I = interpolation_modes.length;
const wp = [];
function preferences_draw_const() {
	draw_text('Master Volume Left', 2, 14, 0, 2);
	draw_text('Master Volume Right', 2, 15, 0, 2);
	draw_box(21, 13, 27, 16, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_text('Mixing Mode', 2, 18, 0, 2);
	draw_text('Available Audio Devices', 37, 14, 0, 2);
	draw_box(36, 15, 78, 22, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_text('Available Audio Drivers', 37, 23, 0, 2);
	draw_box(36, 24, 78, 31, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_text('Output Equalizer', 2, 21 + I * 3, 0, 2);
	draw_text('Low Frequency Band', 7, 23 + I * 3, 0, 2);
	draw_text('Med Low Frequency Band', 3, 24 + I * 3, 0, 2);
	draw_text('Med High Frequency Band', 2, 25 + I * 3, 0, 2);
	draw_text('High Frequency Band', 6, 26 + I * 3, 0, 2);
	draw_text('Ramp volume at start of sample', 2, 29 + I * 3, 0, 2);
	draw_box(25, 22 + I * 3, 47, 27 + I * 3, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(52, 22 + I * 3, 74, 27 + I * 3, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_text(`Playback Frequency: ${audio_sample_rate()}Hz`, 2, 48, 0, 2);
	const url = 'https://schismtracker.org/';
	draw_text(url, 78 - url.length, 48, 1, 2);
}
function preferences_set_page() {
	wp[0].d.value = audio_settings.master.left;
	wp[1].d.value = audio_settings.master.right;
	for (let i = 0; i < I; i++) wp[i + 2].d.state = i === audio_settings.interpolation_mode ? 1 : 0;
	for (let j = 0; j < 4; j++) { wp[I + 2 + j * 2].d.value = audio_settings.eq_freq[j]; wp[I + 3 + j * 2].d.value = audio_settings.eq_gain[j]; }
	wp[I + 10].d.state = audio_settings.no_ramping ? 0 : 1;
	wp[I + 11].d.state = audio_settings.no_ramping ? 1 : 0;
}
function change_volume() { audio_settings.master.left = wp[0].d.value; audio_settings.master.right = wp[1].d.value; }
function change_eq() {
	for (let j = 0; j < 4; j++) { audio_settings.eq_freq[j] = wp[I + 2 + j * 2].d.value; audio_settings.eq_gain[j] = wp[I + 3 + j * 2].d.value; }
	song_init_eq(1, current_song.mix_frequency);
}
function change_mixer() {
	for (let i = 0; i < I; i++) if (wp[2 + i].d.state) audio_settings.interpolation_mode = i;
	audio_settings.no_ramping = wp[I + 11].d.state;
	song_init_modplug();
	flash(SAVED);
}
{
	wp.push(widget_create_thumbbar(22, 14, 5, 0, 1, 1, change_volume, 0, 31), widget_create_thumbbar(22, 15, 5, 0, 2, 2, change_volume, 0, 31));
	for (const w of [wp[0], wp[1]]) w.next.left = w.next.right = w.next.tab = w.next.backtab = I + 13;
	const ig = [2, 3, 4, 5, -1];
	interpolation_modes.forEach((m, i) => {
		const w = widget_create_togglebutton(6, 20 + i * 3, 26, i + 1, i + 3, i + 2, I + 11, i + 3, change_mixer, `16 Bit, ${m}`, 2, ig);
		w.next.left = w.next.right = i < 1 ? I + 13 : I + 14;
		wp.push(w);
	});
	for (let j = 0; j < 4; j++) {
		wp[I + 2 + j * 2] = widget_create_thumbbar(26, 23 + I * 3 + j, 21, j === 0 ? I + 1 : I + j * 2, I + j * 2 + 4, I + j * 2 + 3, change_eq, 0, 127);
		wp[I + 3 + j * 2] = widget_create_thumbbar(53, 23 + I * 3 + j, 21, I + j * 2 + 1, j === 3 ? I + j * 2 + 4 : I + j * 2 + 5, I + j * 2 + 4, change_eq, 0, 127);
	}
	const rg = [I + 10, I + 11, -1];
	wp[I + 10] = widget_create_togglebutton(33, 29 + I * 3, 9, I + 9, I + 12, I + 10, I + 11, I + 11, change_mixer, 'Enabled', 2, rg);
	wp[I + 11] = widget_create_togglebutton(46, 29 + I * 3, 9, I + 9, I + 12, I + 10, I + 13, I + 13, change_mixer, 'Disabled', 1, rg);
	wp[I + 12] = widget_create_button(2, 44, 27, I + 10, I + 12, I + 12, I + 13, I + 13, cfg_save, 'Save Output Configuration', 2);
	const devs = () => 1, dname = () => 'default (Web Audio output)', dtog = () => 1;
	wp[I + 13] = widget_create_listbox(devs, dtog, dname, null, () => optional('audio_init'), null, [1, 1, 2, 2, 2, 3], [1, 1, 2, 2, 2, 3], 0, I + 14);
	Object.assign(wp[I + 13], { x: 37, y: 16, width: 41, height: 6 });
	wp[I + 14] = widget_create_listbox(devs, dtog, () => 'webaudio', null, () => optional('audio_init'), null, [4, 4, 4, 5, 5, 5], [4, 4, 4, 5, 5, 5], I + 13, I + 3);
	Object.assign(wp[I + 14], { x: 37, y: 25, width: 41, height: 6 });
	Object.assign(pages[PAGE.PREFERENCES], { title: 'Preferences (Shift-F5)', draw_const: preferences_draw_const,
		set_page: preferences_set_page, widgets: wp, total_widgets: 15 + I, help_index: HELP.GLOBAL, ported: true });
}

cfg_load();
provide({ cfg_save, cfg_load });
void palette_load_preset; void BOX_THICK;
