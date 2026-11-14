// Ports of schism/page_midi.c (MIDI Screen, Shift-F1) and schism/page_midiout.c
// (MIDI Output Configuration) (Schism Tracker, GPL-2.0-or-later). The port
// list shows the browser's Web MIDI devices; there are no IP MIDI ports.
import { app, optional } from './app.js';
import { status, PAGE, HELP, NEED_UPDATE, MIDI_EVENT_CHANGED } from './state.js';
import { draw_text, draw_char, draw_box, draw_fill_chars, draw_text_utf8_len, DEFAULT_FG,
	BOX_THIN, BOX_INNER, BOX_INSET } from './vgamem.js';
import { widget_create_toggle, widget_create_thumbbar, widget_create_button, widget_create_other,
	widget_create_textentry, widget_change_focus_to, active_widget, ui, MOUSE_SCROLL_LINES, WIDGET_OTHER } from './widget.js';
import { KEYSYM, KEY_PRESS, KEY_RELEASE, MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN, MOUSE_DBLCLICK, hexdigits } from './keyboard.js';
import { pages } from './page.js';
import { current_song } from './song.js';
import { midi, MIDI_TICK_QUANTIZE, MIDI_BASE_PROGRAM1, MIDI_RECORD_NOTEOFF, MIDI_RECORD_VELOCITY,
	MIDI_RECORD_AFTERTOUCH, MIDI_CUT_NOTE_OFF, MIDI_PITCHBEND, MIDI_INPUT, MIDI_OUTPUT,
	midi_engine_poll_ports, midi_engine_port, midi_engine_port_count, midi_engine_error,
	midi_port_enable, midi_port_disable } from './midi.js';
import { copy_midi_config, midi_config_defaults } from './midimacro.js';
import * as C from './sndconst.js';

// ------------------------------------------------------------------------
// page_midi.c

let top_midi_port = 0, current_port = 0, last_midi_poll = 0;
const wm = [];

function update_ip_ports() {
	if (wm[12].d.value > 0) {
		app.status_text_flash('Networking is disabled');
		wm[12].d.value = 0;
	}
	last_midi_poll = 0;
	status.flags |= NEED_UPDATE;
}
function update_midi_values() {
	midi.flags = (midi.flags & ~0xffff)
		| (wm[1].d.state ? MIDI_TICK_QUANTIZE : 0)
		| (wm[2].d.state ? MIDI_BASE_PROGRAM1 : 0)
		| (wm[3].d.state ? MIDI_RECORD_NOTEOFF : 0)
		| (wm[4].d.state ? MIDI_RECORD_VELOCITY : 0)
		| (wm[5].d.state ? MIDI_RECORD_AFTERTOUCH : 0)
		| (wm[6].d.state ? MIDI_CUT_NOTE_OFF : 0)
		| (wm[9].d.state ? MIDI_PITCHBEND : 0);
	if (wm[11].d.state) current_song.flags |= C.SONG_EMBEDMIDICFG;
	else current_song.flags &= ~C.SONG_EMBEDMIDICFG;
	midi.amplification = wm[7].d.value;
	midi.c5note = wm[8].d.value;
	midi.pitch_depth = wm[10].d.value;
}
function get_midi_config() {
	wm[1].d.state = !!(midi.flags & MIDI_TICK_QUANTIZE);
	wm[2].d.state = !!(midi.flags & MIDI_BASE_PROGRAM1);
	wm[3].d.state = !!(midi.flags & MIDI_RECORD_NOTEOFF);
	wm[4].d.state = !!(midi.flags & MIDI_RECORD_VELOCITY);
	wm[5].d.state = !!(midi.flags & MIDI_RECORD_AFTERTOUCH);
	wm[6].d.state = !!(midi.flags & MIDI_CUT_NOTE_OFF);
	wm[9].d.state = !!(midi.flags & MIDI_PITCHBEND);
	wm[11].d.state = !!(current_song.flags & C.SONG_EMBEDMIDICFG);
	wm[7].d.value = midi.amplification;
	wm[8].d.value = midi.c5note;
	wm[10].d.value = midi.pitch_depth;
	wm[12].d.value = 0;
	midi_engine_poll_ports(); // the first visit asks the browser for MIDI access
}
function toggle_port() {
	const p = midi_engine_port(current_port);
	if (!p) return;
	status.flags |= NEED_UPDATE;
	midi_port_disable(p);
	switch (p.io) {
	case 0:
		if (p.iocap & MIDI_INPUT) p.io = MIDI_INPUT;
		else if (p.iocap & MIDI_OUTPUT) p.io = MIDI_OUTPUT;
		break;
	case MIDI_INPUT:
		p.io = (p.iocap & MIDI_OUTPUT) ? MIDI_OUTPUT : 0;
		break;
	case MIDI_OUTPUT:
		if (p.iocap & MIDI_INPUT) p.io |= MIDI_INPUT; else p.io = 0;
		break;
	case MIDI_INPUT | MIDI_OUTPUT:
		p.io = 0;
		break;
	}
	midi_port_enable(p);
}
function midi_page_handle_key(k) {
	const ct = midi_engine_port_count();
	let new_port = current_port;
	if (k.mouse === MOUSE_SCROLL_UP) new_port -= MOUSE_SCROLL_LINES;
	else if (k.mouse === MOUSE_SCROLL_DOWN) new_port += MOUSE_SCROLL_LINES;
	else if (k.mouse) {
		if (k.x >= 3 && k.x <= 11 && k.y >= 15 && k.y <= 27) {
			if (k.mouse === MOUSE_DBLCLICK) {
				if (k.state === KEY_PRESS) return 0;
				toggle_port();
				return 1;
			}
			new_port = top_midi_port + (k.y - 15);
		} else return 0;
	}
	switch (k.sym) {
	case KEYSYM.SPACE:
		if (k.state === KEY_PRESS) return 1;
		toggle_port();
		return 1;
	case KEYSYM.PAGEUP: new_port -= 13; break;
	case KEYSYM.PAGEDOWN: new_port += 13; break;
	case KEYSYM.HOME: new_port = 0; break;
	case KEYSYM.END: new_port = ct - 1; break;
	case KEYSYM.UP: new_port--; break;
	case KEYSYM.DOWN: new_port++; break;
	case KEYSYM.TAB:
		if (k.state === KEY_RELEASE) return 1;
		widget_change_focus_to(1);
		status.flags |= NEED_UPDATE;
		return 1;
	default:
		if (!k.mouse) return 0;
		break;
	}
	if (k.state === KEY_RELEASE) return 0;
	if (new_port !== current_port) {
		new_port = Math.max(0, Math.min(ct - 1, new_port));
		current_port = new_port;
		if (current_port < top_midi_port) top_midi_port = current_port;
		if (current_port - top_midi_port > 12) top_midi_port = current_port - 12;
		if (top_midi_port < 0) top_midi_port = 0;
		status.flags |= NEED_UPDATE;
	}
	return 1;
}
function midi_page_redraw() {
	draw_text('Tick quantize', 6, 30, 0, 2);
	draw_text('Base Program 1', 5, 31, 0, 2);
	draw_text('Record Note-Off', 4, 32, 0, 2);
	draw_text('Record Velocity', 4, 33, 0, 2);
	draw_text('Record Aftertouch', 2, 34, 0, 2);
	draw_text('Cut note off', 7, 35, 0, 2);
	draw_fill_chars(23, 30, 24, 35, DEFAULT_FG, 0);
	draw_box(19, 29, 25, 36, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(52, 29, 73, 32, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_fill_chars(56, 34, 72, 34, DEFAULT_FG, 0);
	draw_box(52, 33, 73, 36, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_fill_chars(56, 38, 72, 38, DEFAULT_FG, 0);
	draw_box(52, 37, 73, 39, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_text('Amplification', 39, 30, 0, 2);
	draw_text('C-5 Note-value', 38, 31, 0, 2);
	draw_text('Output MIDI pitch', 35, 34, 0, 2);
	draw_text('Pitch wheel depth', 35, 35, 0, 2);
	draw_text('Embed MIDI data', 37, 38, 0, 2);
	draw_text('IP MIDI ports', 39, 41, 0, 2);
	draw_box(52, 40, 73, 42, BOX_THIN | BOX_INNER | BOX_INSET);
}
function midi_page_draw_portlist() {
	const now = Date.now();
	draw_fill_chars(3, 15, 76, 28, DEFAULT_FG, 0);
	draw_text('MIDI ports:', 2, 13, 0, 2);
	draw_box(2, 14, 77, 28, BOX_THIN | BOX_INNER | BOX_INSET);
	for (let i = 0; i < 13; i++) draw_char(168, 12, i + 15, 2, 0);
	if (now - last_midi_poll > 10000) { last_midi_poll = now; midi_engine_poll_ports(); }
	const ct = midi_engine_port_count();
	if (ct > 13 && top_midi_port + 13 >= ct) top_midi_port = ct - 13;
	current_port = Math.max(0, Math.min(current_port, ct - 1));
	if (!ct) {
		const err = midi_engine_error();
		draw_text_utf8_len(err || 'No MIDI devices found', 64, 13, 15, 5, 0);
		return;
	}
	for (let i = 0; i < 13; i++) {
		const p = midi_engine_port(top_midi_port + i);
		if (!p) break;
		const w = active_widget();
		const hl = current_port === top_midi_port + i && w && w.type === WIDGET_OTHER;
		const fg = hl ? 0 : 5, bg = hl ? 3 : 0;
		draw_text_utf8_len(p.name, 64, 13, 15 + i, 5, 0);
		if ((status.flags & MIDI_EVENT_CHANGED) && (now - status.last_midi_tick) < 3000
			&& ((!status.last_midi_port && (p.io & MIDI_OUTPUT)) || p === status.last_midi_port)) {
			let buffer = '';
			for (let j = 0; j < 21 && j < status.last_midi_len; j++)
				buffer += hexdigits[status.last_midi_event[j] >> 4] + hexdigits[status.last_midi_event[j] & 15] + ' ';
			draw_text(buffer, 77 - buffer.length, 15 + i, status.last_midi_port ? 4 : 10, 0);
		}
		const state = ['Disabled ', '   Input ', '  Output ', '  Duplex '][p.io] || ' Enabled?';
		draw_text(state, 3, 15 + i, fg, bg);
	}
}

wm[0] = widget_create_other(0, midi_page_handle_key, null, midi_page_draw_portlist);
Object.assign(wm[0], { x: 2, y: 14, width: 75, height: 15 });
wm[1] = widget_create_toggle(20, 30, 0, 2, 7, 7, 7, update_midi_values);
wm[2] = widget_create_toggle(20, 31, 1, 3, 8, 8, 8, update_midi_values);
wm[3] = widget_create_toggle(20, 32, 2, 4, 8, 8, 8, update_midi_values);
wm[4] = widget_create_toggle(20, 33, 3, 5, 9, 9, 9, update_midi_values);
wm[5] = widget_create_toggle(20, 34, 4, 6, 9, 9, 9, update_midi_values);
wm[6] = widget_create_toggle(20, 35, 5, 13, 10, 10, 10, update_midi_values);
wm[7] = widget_create_thumbbar(53, 30, 20, 0, 8, 1, update_midi_values, 0, 200);
wm[8] = widget_create_thumbbar(53, 31, 20, 7, 9, 2, update_midi_values, 0, 127);
wm[9] = widget_create_toggle(53, 34, 8, 10, 5, 5, 5, update_midi_values);
wm[10] = widget_create_thumbbar(53, 35, 20, 9, 11, 6, update_midi_values, 0, 48);
wm[11] = widget_create_toggle(53, 38, 10, 12, 13, 13, 13, update_midi_values);
wm[12] = widget_create_thumbbar(53, 41, 20, 11, 12, 13, update_ip_ports, 0, 128);
wm[13] = widget_create_button(2, 41, 27, 6, 14, 12, 12, 12, () => app.set_page(PAGE.MIDI_OUTPUT), 'MIDI Output Configuration', 2);
wm[14] = widget_create_button(2, 44, 27, 13, 14, 12, 12, 12, () => optional('cfg_save'), 'Save Output Configuration', 2);

Object.assign(pages[PAGE.MIDI], { title: 'MIDI Screen (Shift-F1)', draw_const: midi_page_redraw, set_page: get_midi_config,
	total_widgets: 15, widgets: wm, help_index: HELP.GLOBAL, ported: true });

// ------------------------------------------------------------------------
// page_midiout.c

const wo = [];
let zxx_top = 0;
let editcfg = copy_midi_config(midi_config_defaults);
const TOP_KEYS = ['start', 'stop', 'tick', 'note_on', 'note_off', 'set_volume', 'set_panning', 'set_bank', 'set_program'];

function midiout_draw_const() {
	draw_text('MIDI Start', 6, 13, 0, 2);
	draw_text('MIDI Stop', 7, 14, 0, 2);
	draw_text('MIDI Tick', 7, 15, 0, 2);
	draw_text('Note On', 9, 16, 0, 2);
	draw_text('Note Off', 8, 17, 0, 2);
	draw_text('Change Volume', 3, 18, 0, 2);
	draw_text('Change Pan', 6, 19, 0, 2);
	draw_text('Bank Select', 5, 20, 0, 2);
	draw_text('Program Change', 2, 21, 0, 2);
	draw_text('Macro   SF0', 5, 24, 0, 2);
	draw_text('Setup   SF1', 5, 25, 0, 2);
	for (let i = 2; i < 16; i++) draw_text('SF' + hexdigits[i], 13, i + 24, 0, 2);
	draw_box(16, 12, 60, 22, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(16, 23, 60, 40, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(16, 41, 60, 49, BOX_THIN | BOX_INNER | BOX_INSET);
	for (let i = 0; i < 7; i++) draw_text('Z' + (i + zxx_top + 0x80).toString(16).toUpperCase(), 13, i + 42, 0, 2);
}
function copy_out() { current_song.midi_config = copy_midi_config(editcfg); }
function copy_in() { editcfg = copy_midi_config(current_song.midi_config || midi_config_defaults); }
function zxx_setpos(pos) {
	pos = Math.max(0, Math.min(128 - 7, pos));
	if (zxx_top === pos) return;
	zxx_top = pos;
	for (let i = 0; i < 7; i++) { const w = wo[25 + i]; w.d.cursor_pos = Math.min(w.d.cursor_pos, w.d.text.value.length); }
	status.flags |= NEED_UPDATE;
}
function pre_handle_key(k) {
	const sel = ui.holder.selected_widget;
	if (sel === 25 && k.sym === KEYSYM.UP) {
		if (k.state === KEY_RELEASE) return 1;
		if (zxx_top === 0) return 0;
		zxx_setpos(zxx_top - 1);
		return 1;
	}
	if (sel === 31 && k.sym === KEYSYM.DOWN) {
		if (k.state === KEY_RELEASE) return 1;
		zxx_setpos(zxx_top + 1);
		return 1;
	}
	if (sel >= 25) {
		if (k.sym === KEYSYM.PAGEUP) { if (k.state !== KEY_RELEASE) zxx_setpos(zxx_top - 7); return 1; }
		if (k.sym === KEYSYM.PAGEDOWN) { if (k.state !== KEY_RELEASE) zxx_setpos(zxx_top + 7); return 1; }
	}
	return 0;
}
const ref = get => ({ get value() { return get().o[get().k]; }, set value(v) { const r = get(); r.o[r.k] = v; } });
for (let i = 0; i < 9; i++)
	wo.push(widget_create_textentry(17, 13 + i, 43, i === 0 ? 0 : i - 1, i + 1, 9, copy_out, ref(() => ({ o: editcfg, k: TOP_KEYS[i] })), 31));
for (let i = 0; i < 16; i++)
	wo.push(widget_create_textentry(17, 24 + i, 43, 9 + i - 1, 9 + i + 1, 25, copy_out, ref(() => ({ o: editcfg.sfx, k: i })), 31));
for (let i = 0; i < 7; i++)
	wo.push(widget_create_textentry(17, 42 + i, 43, 25 + i - 1, 25 + (i === 6 ? 6 : i + 1), 0, copy_out, ref(() => ({ o: editcfg.zxx, k: zxx_top + i })), 31));

Object.assign(pages[PAGE.MIDI_OUTPUT], { title: 'MIDI Output Configuration', draw_const: midiout_draw_const,
	set_page: copy_in, pre_handle_key, total_widgets: 32, widgets: wo, help_index: HELP.MIDI_OUTPUT, ported: true });

void KEY_PRESS;
