// Port of schism/page_loadsample.c and schism/page_loadinst.c (Schism Tracker,
// GPL-2.0-or-later), on the browser file store. Modules act as libraries: Enter
// on a module lists its samples (or instruments). The right-hand sample
// parameter widgets of the C page are shown read-only.
import { app, provide } from './app.js';
import * as C from './sndconst.js';
import { status, PAGE, HELP, NEED_UPDATE, SONG_NEEDS_SAVE, CLASSIC_MODE, DIALOG_OK_CANCEL, DIALOG_YES_NO, DIALOG_OK } from './state.js';
import { draw_text, draw_text_len, draw_char, draw_box, draw_fill_chars, vgamem_ovl_alloc, DEFAULT_FG,
	BOX_THICK, BOX_THIN, BOX_INNER, BOX_INSET } from './vgamem.js';
import { KEYSYM, KEYMOD, KEY_PRESS, KEY_RELEASE, NO_MODIFIER, MOUSE_NONE, MOUSE_CLICK, MOUSE_DBLCLICK,
	MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN, kbd_get_note } from './keyboard.js';
import { widget_create_other, MOUSE_SCROLL_LINES, str_from_num } from './widget.js';
import { dialog_create, dialog_create_custom, dialog_destroy } from './dialog.js';
import { widget_create_button } from './widget.js';
import { pages, set_page } from './page.js';
import { current_song, blank_sample, song_keydown, song_keyup, song_stop_unlocked, song_toggle_multichannel_mode,
	song_is_instrument_mode, song_get_instrument, song_copy_sample, KEYJAZZ_NOINST, KEYJAZZ_INST_FAKE, KEYJAZZ_CHAN_CURRENT } from './song.js';
import { dmoz_read_directory, dmoz_read_file, dmoz_remove, dmoz_path_normal, dmoz_path_get_basename,
	dmoz_path_get_parent, dmoz_import_files } from './dmoz.js';
import { dmoz_file_info, fmt_load_sample, fmt_decode_sample, fmt_load_instrument,
	TYPE_MODULE_MASK, TYPE_INST_MASK, TYPE_UNKNOWN, TYPE_SAMPLE_COMPR } from './fmt/info.js';
import { song_create_load } from './fmt/loaders.js';
import { cfg } from './page_loadmodule.js';
import { csf_stop_sample, csf_init_instrument } from './csndfile.js';
import { draw_sample_data } from './sample-edit.js';
import * as SE from './sample-edit.js';

const TYPE_DIRECTORY = 5, TYPE_IMPORT = -1, TYPE_LIB_ITEM = 0x30002;
const sample_image = vgamem_ovl_alloc({ x1: 52, y1: 25, x2: 76, y2: 28 });

function make_browser(kind) {
	const st = { top_file: 0, current_file: 0, flist: [], search_pos: -1, search: '', lib: null, fake: null };
	const dir_key = kind === 'sample' ? 'dir_samples' : 'dir_instruments';

	function read_directory() {
		st.flist = [];
		if (st.lib) {
			st.flist.push({ base: '..', title: '........Library........', type: TYPE_DIRECTORY, path: null });
			const song = st.lib.song;
			if (kind === 'sample') {
				for (let n = 1; n < song.samples.length - 1; n++) {
					const s = song.samples[n];
					if (!s.data && !s.name) continue;
					st.flist.push({ base: `${st.lib.base}:${n}`, title: s.name, type: TYPE_LIB_ITEM, lib_index: n, smp: s,
						description: 'Library sample', size: s.length * (s.flags & C.CHN_16BIT ? 2 : 1) * (s.flags & C.CHN_STEREO ? 2 : 1), mtime: st.lib.mtime });
				}
			} else {
				const insmode = song.flags & C.SONG_INSTRUMENTMODE;
				const n_max = insmode ? song.instruments.length : song.samples.length - 1;
				for (let n = 1; n < n_max; n++) {
					const ins = insmode ? song.instruments[n] : null;
					const s = song.samples[n];
					if (insmode ? !ins : (!s || (!s.data && !s.name))) continue;
					st.flist.push({ base: `${st.lib.base}:${n}`, title: insmode ? ins.name : s.name, type: TYPE_LIB_ITEM, lib_index: n,
						description: 'Library instrument', size: 0, mtime: st.lib.mtime });
				}
			}
			return;
		}
		const listing = dmoz_read_directory(cfg[dir_key]);
		for (const d of listing.dirs) st.flist.push({ base: d.base, title: '........Directory........', type: TYPE_DIRECTORY, path: d.path });
		st.flist.push({ base: '', title: '[Import from disk]', type: TYPE_IMPORT, path: null });
		for (const f of listing.files) {
			const info = dmoz_file_info(f.base, f.data);
			let title = info.title || f.base;
			if (info.type & TYPE_MODULE_MASK) title = '.........Library.........';
			st.flist.push({ ...f, ...info, title });
		}
		st.current_file = Math.min(st.current_file, st.flist.length - 1);
	}
	function reposition() {
		if (st.current_file < st.top_file) st.top_file = st.current_file;
		else if (st.current_file > st.top_file + 34) st.top_file = st.current_file - 34;
		status.flags |= NEED_UPDATE;
	}
	function type_color(f) {
		if (f.type === TYPE_DIRECTORY) return 5;
		if (f.type === TYPE_IMPORT) return 2;
		if (f.type & TYPE_MODULE_MASK) return 6;
		if (f.type === TYPE_UNKNOWN) return 2;
		return 3;
	}
	function file_list_draw() {
		const sel = app.active_page().selected_widget === 0;
		let pos = 13;
		if (st.top_file < 0) st.top_file = 0;
		for (let n = st.top_file; n < st.flist.length && pos < 48; n++, pos++) {
			const f = st.flist[n];
			const [fg, bg] = n === st.current_file && sel ? [0, 3] : [type_color(f), 0];
			draw_text(str_from_num(3, n + 1), 2, pos, 0, 2);
			draw_text_len(f.title || '', 25, 6, pos, fg, bg);
			draw_char(168, 31, pos, 2, bg);
			draw_text_len(f.base || '', 18, 32, pos, fg, bg);
			if (st.search_pos > -1 && f.base && f.base.toLowerCase().startsWith(st.search.toLowerCase()) && st.search.length)
				draw_text_len(f.base, Math.min(st.search.length, 18), 32, pos, 3, 1);
		}
		while (pos < 48) draw_char(168, 31, pos++, 2, 0);
	}
	function preview_sample() {
		const f = st.flist[st.current_file];
		if (!f) return null;
		if (st.fake && st.fake.file === f) return st.fake.smp;
		let smp = null;
		if (f.type === TYPE_LIB_ITEM && kind === 'sample') smp = f.smp;
		else if (f.data && !(f.type & TYPE_MODULE_MASK) && !(f.type & TYPE_INST_MASK) && f.type !== TYPE_SAMPLE_COMPR) {
			smp = blank_sample({});
			if (!fmt_load_sample(f.base, f.data, smp)) smp = null;
		}
		st.fake = { file: f, smp };
		return smp;
	}
	function draw_const() {
		draw_box(5, 12, 50, 48, BOX_THICK | BOX_INNER | BOX_INSET);
		draw_fill_chars(6, 13, 49, 47, DEFAULT_FG, 0);
		draw_fill_chars(64, 13, 77, 22, DEFAULT_FG, 0);
		draw_box(62, 32, 72, 35, BOX_THICK | BOX_INNER | BOX_INSET);
		draw_box(62, 36, 72, 40, BOX_THICK | BOX_INNER | BOX_INSET);
		draw_box(63, 12, 77, 23, BOX_THICK | BOX_INNER | BOX_INSET);
		draw_box(51, 24, 77, 29, BOX_THICK | BOX_INNER | BOX_INSET);
		draw_fill_chars(52, 25, 76, 28, DEFAULT_FG, 0);
		draw_box(51, 30, 77, 42, BOX_THIN | BOX_INNER | BOX_INSET);
		draw_fill_chars(59, 44, 76, 47, DEFAULT_FG, 0);
		draw_box(58, 43, 77, 48, BOX_THICK | BOX_INNER | BOX_INSET);
		draw_fill_chars(63, 33, 71, 34, DEFAULT_FG, 0);
		draw_fill_chars(63, 37, 71, 39, DEFAULT_FG, 0);
		const f = st.flist[st.current_file];
		if (f) {
			const s = kind === 'sample' ? preview_sample() : null;
			if (s) {
				draw_text_len(s.filename || '', 13, 64, 13, 2, 0);
				draw_text_len(String(s.c5speed).padStart(7, '0'), 13, 64, 14, 2, 0);
				draw_text_len(s.flags & C.CHN_LOOP ? (s.flags & C.CHN_PINGPONGLOOP ? 'On Ping Pong' : 'On Forwards') : 'Off', 13, 64, 15, 2, 0);
				draw_text_len(String(s.loop_start).padStart(7, '0'), 13, 64, 16, 2, 0);
				draw_text_len(String(s.loop_end).padStart(7, '0'), 13, 64, 17, 2, 0);
				draw_text_len(s.flags & C.CHN_SUSTAINLOOP ? (s.flags & C.CHN_PINGPONGSUSTAIN ? 'On Ping Pong' : 'On Forwards') : 'Off', 13, 64, 18, 2, 0);
				draw_text_len(String(s.sustain_start).padStart(7, '0'), 13, 64, 19, 2, 0);
				draw_text_len(String(s.sustain_end).padStart(7, '0'), 13, 64, 20, 2, 0);
				draw_text_len(s.data ? `${s.flags & C.CHN_16BIT ? 16 : 8} bit${s.flags & C.CHN_STEREO ? ' Stereo' : ''}` : 'No sample', 13, 64, 21, 2, 0);
				draw_text_len(String(s.length).padStart(7, '0'), 13, 64, 22, 2, 0);
				draw_text(String(s.volume >> 2).padStart(3, '0'), 63, 33, 2, 0);
				draw_text(String(s.global_volume).padStart(3, '0'), 63, 34, 2, 0);
				draw_text(String(s.vib_speed).padStart(3, '0'), 63, 37, 2, 0);
				draw_text(String(s.vib_depth).padStart(3, '0'), 63, 38, 2, 0);
				draw_text(String(s.vib_rate).padStart(3, '0'), 63, 39, 2, 0);
				draw_sample_data(sample_image, s);
			} else if (f.type === TYPE_SAMPLE_COMPR) {
				draw_text_len('Press Enter', 13, 64, 21, 2, 0);
				draw_text_len('to decode', 13, 64, 22, 2, 0);
			}
			draw_text_len(f.description || (f.type === TYPE_DIRECTORY ? 'Directory' : f.type === TYPE_IMPORT ? 'Browser file picker' : 'Unknown format'), 18, 59, 44, 5, 0);
			if (f.size !== undefined && f.type !== TYPE_DIRECTORY) draw_text(String(f.size).padStart(7, '0'), 59, 45, 5, 0);
			if (f.mtime) {
				const d = new Date(f.mtime);
				draw_text_len(d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }), 18, 59, 46, 5, 0);
				draw_text_len(d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), 18, 59, 47, 5, 0);
			}
		}
		draw_text('Filename', 55, 13, 0, 2);
		draw_text('Speed', 58, 14, 0, 2);
		draw_text('Loop', 59, 15, 0, 2);
		draw_text('LoopBeg', 56, 16, 0, 2);
		draw_text('LoopEnd', 56, 17, 0, 2);
		draw_text('SusLoop', 56, 18, 0, 2);
		draw_text('SusLBeg', 56, 19, 0, 2);
		draw_text('SusLEnd', 56, 20, 0, 2);
		draw_text('Quality', 56, 21, 0, 2);
		draw_text('Length', 57, 22, 0, 2);
		draw_text('Def. Vol.', 53, 33, 0, 2);
		draw_text('Glb. Vol.', 53, 34, 0, 2);
		draw_text('Vib.Speed', 53, 37, 0, 2);
		draw_text('Vib.Depth', 53, 38, 0, 2);
		draw_text('Vib. Rate', 53, 39, 0, 2);
		draw_text('Format', 52, 44, 0, 2);
		draw_text('Size', 54, 45, 0, 2);
		draw_text('Date', 54, 46, 0, 2);
		draw_text('Time', 54, 47, 0, 2);
	}

	function finish_sample_load(cur) {
		status.flags |= SONG_NEEDS_SAVE;
		const smp = current_song.samples[cur];
		if ((smp.flags & C.CHN_STEREO) && kind === 'sample') {
			const done = fn => () => { if (fn) fn(current_song.samples[cur]); dialog_destroy(); sample_host_dialog(PAGE.SAMPLE_LIST); };
			const w = [
				widget_create_button(27, 30, 6, 0, 0, 2, 1, 1, done(SE.sample_mono_left), 'Left', 2),
				widget_create_button(37, 30, 6, 1, 1, 0, 2, 2, done(null), 'Both', 2),
				widget_create_button(47, 30, 6, 2, 2, 1, 0, 0, done(SE.sample_mono_right), 'Right', 1),
			];
			dialog_create_custom(24, 25, 33, 8, w, 3, 1, () => {
				draw_text('Loading Stereo Sample', 30, 27, 0, 2);
			}, null);
			return;
		}
		sample_host_dialog(PAGE.SAMPLE_LIST);
	}
	async function load_into_slot(f) {
		const cur = app.sample_get_current() || 1;
		const dst = current_song.samples[cur];
		csf_stop_sample(current_song, dst);
		if (f.type === TYPE_LIB_ITEM) {
			song_copy_sample(cur, { ...f.smp });
		} else {
			const smp = blank_sample({});
			let ok = fmt_load_sample(f.base, f.data, smp);
			if (!ok) ok = await fmt_decode_sample(f.base, f.data, smp);
			if (!ok) { dialog_create(DIALOG_OK, 'Could not load sample', null, null, 0, null); return; }
			if (!smp.filename) smp.filename = f.base.slice(0, 12);
			song_copy_sample(cur, smp);
		}
		status.flags |= NEED_UPDATE;
		finish_sample_load(cur);
	}
	function load_instrument_into_slot(f) {
		const target = app.instrument_get_current() || 1;
		let res;
		const free_slots = [];
		const new_sample = () => blank_sample({});
		if (f.type === TYPE_LIB_ITEM) {
			const song = st.lib.song, n = f.lib_index;
			if (song.flags & C.SONG_INSTRUMENTMODE) {
				const src = song.instruments[n];
				const ins = { ...src, vol_env: clone_env(src.vol_env), pan_env: clone_env(src.pan_env), pitch_env: clone_env(src.pitch_env),
					sample_map: new Uint8Array(src.sample_map), note_map: new Uint8Array(src.note_map) };
				const used = [...new Set([...ins.sample_map].filter(x => x))];
				const samples = used.map(u => ({ ...song.samples[u] }));
				for (let i = 0; i < 128; i++) ins.sample_map[i] = ins.sample_map[i] ? used.indexOf(ins.sample_map[i]) + 1 : 0;
				res = { ins, samples };
			} else {
				const ins = { sample_map: new Uint8Array(128).fill(1) };
				csf_init_instrument(ins, 1);
				ins.name = song.samples[n].name;
				res = { ins, samples: [{ ...song.samples[n] }] };
			}
		} else res = fmt_load_instrument(f.base, f.data, new_sample);
		if (!res) { dialog_create(DIALOG_OK, 'Could not load instrument', null, null, 0, null); return; }
		// put the samples into free sample slots
		for (let n = 1; n < 236 && free_slots.length < res.samples.length; n++)
			if (!current_song.samples[n].data && !current_song.samples[n].name) free_slots.push(n);
		if (free_slots.length < res.samples.length) { dialog_create(DIALOG_OK, 'Not enough free sample slots', null, null, 0, null); return; }
		res.samples.forEach((s, i) => song_copy_sample(free_slots[i], s));
		for (let i = 0; i < 128; i++) res.ins.sample_map[i] = res.ins.sample_map[i] ? free_slots[res.ins.sample_map[i] - 1] : 0;
		if (!res.ins.filename) res.ins.filename = (f.base || '').slice(0, 12);
		current_song.instruments[target] = res.ins;
		status.flags |= SONG_NEEDS_SAVE | NEED_UPDATE;
		if (!song_is_instrument_mode()) {
			dialog_create(DIALOG_YES_NO, 'Enable instrument mode?', () => { app.song_set_instrument_mode(1); set_page(app.instrument_list_page()); },
				() => set_page(app.instrument_list_page()), 0, null);
		} else set_page(app.instrument_list_page());
	}
	function handle_enter_key() {
		const f = st.flist[st.current_file];
		if (!f) return;
		if (f.type === TYPE_IMPORT) {
			dmoz_import_files(cfg[dir_key], () => { read_directory(); status.flags |= NEED_UPDATE; });
			return;
		}
		if (f.type === TYPE_DIRECTORY) {
			if (st.lib && f.base === '..') st.lib = null;
			else cfg[dir_key] = dmoz_path_normal(f.path);
			st.current_file = st.top_file = 0;
			read_directory();
			reposition();
			return;
		}
		if (f.type & TYPE_MODULE_MASK) {
			const song = song_create_load(f.data);
			if (!song) { dialog_create(DIALOG_OK, 'Could not open library', null, null, 0, null); return; }
			st.lib = { song, base: f.base, mtime: f.mtime };
			st.current_file = st.top_file = 0;
			read_directory();
			if (st.flist.length > 1) st.current_file = 1;
			reposition();
			return;
		}
		if (kind === 'sample') load_into_slot(f);
		else load_instrument_into_slot(f);
	}
	function file_list_handle_key(k) {
		let new_file = st.current_file;
		if (!(status.flags & CLASSIC_MODE) && k.sym === KEYSYM.n && (k.mod & KEYMOD.ALT)) {
			if (k.state === KEY_RELEASE) song_toggle_multichannel_mode();
			return 1;
		}
		if (k.mouse) {
			if (k.x >= 6 && k.x <= 49 && k.y >= 13 && k.y <= 47) {
				st.search_pos = -1;
				if (k.mouse === MOUSE_SCROLL_UP) new_file -= MOUSE_SCROLL_LINES;
				else if (k.mouse === MOUSE_SCROLL_DOWN) new_file += MOUSE_SCROLL_LINES;
				else new_file = st.top_file + k.y - 13;
			}
		}
		switch (k.sym) {
		case KEYSYM.UP: new_file--; st.search_pos = -1; break;
		case KEYSYM.DOWN: new_file++; st.search_pos = -1; break;
		case KEYSYM.PAGEUP: new_file -= 35; st.search_pos = -1; break;
		case KEYSYM.PAGEDOWN: new_file += 35; st.search_pos = -1; break;
		case KEYSYM.HOME: new_file = 0; st.search_pos = -1; break;
		case KEYSYM.END: new_file = st.flist.length - 1; st.search_pos = -1; break;
		case KEYSYM.ESCAPE:
			if (st.search_pos < 0) {
				if (k.state === KEY_RELEASE && NO_MODIFIER(k.mod)) set_page(kind === 'sample' ? PAGE.SAMPLE_LIST : app.instrument_list_page());
				return 1;
			}
			// fallthrough
		// eslint-disable-next-line no-fallthrough
		case KEYSYM.RETURN:
			if (st.search_pos < 0) {
				if (k.state === KEY_PRESS) return 0;
				handle_enter_key();
			} else {
				if (k.state === KEY_PRESS) return 1;
				st.search_pos = -1;
				status.flags |= NEED_UPDATE;
			}
			return 1;
		case KEYSYM.DELETE: {
			if (k.state === KEY_RELEASE) return 1;
			st.search_pos = -1;
			const f = st.flist[st.current_file];
			if (f && f.path && f.type !== TYPE_DIRECTORY && !st.lib)
				dialog_create(DIALOG_OK_CANCEL, 'Delete file?', () => { dmoz_remove(f.path); read_directory(); reposition(); }, null, 1, null);
			return 1;
		}
		case KEYSYM.BACKSPACE:
			if (st.search_pos > -1) {
				if (k.state === KEY_RELEASE) return 1;
				st.search = st.search.slice(0, -1);
				st.search_pos--;
				status.flags |= NEED_UPDATE;
				return 1;
			}
			// fallthrough
		// eslint-disable-next-line no-fallthrough
		case KEYSYM.SLASH:
			if (st.search_pos < 0) {
				if (k.state === KEY_PRESS) return 0;
				st.search_pos = 0; st.search = '';
				status.flags |= NEED_UPDATE;
				return 1;
			}
			// fallthrough
		// eslint-disable-next-line no-fallthrough
		default:
			if (st.search_pos > -1 && k.text && k.state === KEY_PRESS) {
				st.search += k.text; st.search_pos = st.search.length;
				const n = st.flist.findIndex(f => f.base && f.base.toLowerCase().startsWith(st.search.toLowerCase()));
				if (n >= 0) { st.current_file = n; reposition(); }
				status.flags |= NEED_UPDATE;
				return 1;
			}
			if (!k.mouse) return 0;
		}
		if (k.mouse === MOUSE_CLICK) { if (k.state !== KEY_PRESS) return 0; }
		else if (k.mouse === MOUSE_DBLCLICK) { handle_enter_key(); return 1; }
		else if (k.state === KEY_RELEASE) return 1;
		new_file = Math.max(0, Math.min(new_file, st.flist.length - 1));
		if (new_file !== st.current_file) {
			song_keyup(KEYJAZZ_NOINST, KEYJAZZ_NOINST, last_note);
			st.search_pos = -1;
			st.current_file = new_file;
			reposition();
		}
		return 1;
	}
	let last_note = 61;
	function page_handle_key(k) {
		// keyjazz the highlighted sample through the hidden slot 0
		if (kind !== 'sample' || (k.mod & (KEYMOD.ALT | KEYMOD.CTRL))) return;
		let n, v = -1;
		if (k.midi_note > -1) { n = k.midi_note; if (k.midi_volume > -1) v = k.midi_volume >> 1; }
		else { n = kbd_get_note(k); if (n <= 0 || n > 120) return; }
		const s = preview_sample();
		if (!s || !s.data) return;
		const slot = current_song.samples[0];
		if (k.state === KEY_RELEASE) { song_keyup(KEYJAZZ_INST_FAKE, KEYJAZZ_NOINST, n); return; }
		if (k.is_repeat) return;
		if (slot.data !== s.data) Object.assign(slot, s);
		song_keydown(KEYJAZZ_INST_FAKE, KEYJAZZ_NOINST, n, v, KEYJAZZ_CHAN_CURRENT);
		last_note = n;
	}
	function set_page_cb() {
		st.lib = null;
		read_directory();
		reposition();
	}
	return { st, read_directory, file_list_draw, file_list_handle_key, draw_const, set_page_cb, page_handle_key };
}

const clone_env = e => ({ ...e, ticks: new Int32Array(e.ticks), values: new Uint8Array(e.values) });

// sample_host_dialog: offer to create an instrument for a freshly loaded sample
export function sample_host_dialog(newpage) {
	const cur = app.sample_get_current();
	if (song_is_instrument_mode() && !app.sample_is_used_by_instrument(cur)) {
		dialog_create(DIALOG_YES_NO, 'Create host instrument?', () => {
			app.song_create_host_instrument(cur);
			if (newpage >= 0) set_page(app.instrument_list_page());
		}, () => { if (newpage >= 0) set_page(newpage); }, 0, null);
	} else if (newpage >= 0) set_page(newpage);
}
export function song_create_host_instrument(smp) {
	let ins = app.instrument_get_current();
	for (let n = 1; n < 236; n++) if (!current_song.instruments[n]) { ins = n; break; }
	const i = song_get_instrument(ins);
	csf_init_instrument(i, smp);
	i.name = current_song.samples[smp].name;
	app.instrument_set(ins);
}

function setup(page_id, kind, title, help) {
	const b = make_browser(kind);
	const w = widget_create_other(0, b.file_list_handle_key, null, b.file_list_draw);
	Object.assign(w, { x: 6, y: 13, width: 44, height: 35 });
	Object.assign(pages[page_id], { title, draw_const: b.draw_const, set_page: b.set_page_cb, handle_key: b.page_handle_key,
		widgets: [w], total_widgets: 1, help_index: help, ported: true });
	return b;
}
setup(PAGE.LOAD_SAMPLE, 'sample', 'Load Sample', HELP.SAMPLE_LIST);
setup(PAGE.LIBRARY_SAMPLE, 'sample', 'Sample Library (Ctrl-F3)', HELP.SAMPLE_LIST);
setup(PAGE.LOAD_INSTRUMENT, 'instrument', 'Load Instrument', HELP.INSTRUMENT_LIST);
setup(PAGE.LIBRARY_INSTRUMENT, 'instrument', 'Instrument Library (Ctrl-F4)', HELP.INSTRUMENT_LIST);

provide({ sample_host_dialog, song_create_host_instrument });
void song_stop_unlocked; void DIALOG_OK_CANCEL; void dmoz_read_file; void dmoz_path_get_basename; void dmoz_path_get_parent; void TYPE_INST_MASK;
