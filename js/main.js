// Browser replacement for schism/main.c: start-up and the event loop.
// (Schism Tracker port, GPL-2.0-or-later.)

import { status, PAGE, NEED_UPDATE, DIALOG_NONE } from "./state.js";
import { vgamem_flip } from "./vgamem.js";
import { video_init, video_blit } from "./video.js";
import { palette_apply } from "./palettes.js";
import { key_event_from_dom, key_event_new, key_event_set_mouse, kbd_is_modifier_key,
	KEY_PRESS, KEY_RELEASE, KEY_DRAG, MOUSE_CLICK, MOUSE_DBLCLICK, MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN,
	MOUSE_BUTTON_LEFT, MOUSE_BUTTON_MIDDLE, MOUSE_BUTTON_RIGHT } from "./keyboard.js";
import { ui, widget_change_focus_to_xy, widget_find_xy } from "./widget.js";
import { redraw_screen, set_page, handle_key, status_text_pending } from "./page.js";
import { app, provide, missing_calls, optional } from "./app.js";
import { song_initialise, song_load_data, audio_init, current_song } from "./song.js";
import "./page_patedit.js";
import "./page_orderpan.js";
import "./pages.js";

const canvas = document.getElementById("screen");

video_init(canvas);
palette_apply();
song_initialise();
app.main_song_changed_cb();
set_page(optional("startup_page") ?? PAGE.PATTERN_EDITOR);

// Browsers only allow audio after a user gesture.
const start_audio = () => { audio_init(); };
window.addEventListener("keydown", start_audio, { once: true, capture: true });
window.addEventListener("pointerdown", start_audio, { once: true, capture: true });

// Files: drag and drop anywhere loads a module (or a sample/instrument on those pages).
export async function load_file_object(file) {
	const data = new Uint8Array(await file.arrayBuffer());
	optional("store_add_file", file.name, data);
	if (app.handle_dropped_file && app.handle_dropped_file(file.name, data)) return;
	if (song_load_data(file.name, data)) set_page(PAGE.PATTERN_EDITOR);
	else app.status_text_flash("Could not load " + file.name);
	status.flags |= NEED_UPDATE;
}
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
	e.preventDefault();
	audio_init();
	for (const f of e.dataTransfer.files) load_file_object(f);
});
provide({ load_file_object });

// ---------------------------------------------------------------------------
// keyboard

function on_key(e, state) {
	const k = key_event_from_dom(e, state);
	if (!k) return;

	// Everything belongs to the tracker; the browser keeps only what it
	// refuses to give up (Ctrl-W/N/T outside fullscreen keyboard lock).
	e.preventDefault();

	status.keymod = k.mod;
	handle_key(k);

	if (state === KEY_PRESS && !kbd_is_modifier_key(k)) {
		status.last_keysym = k.sym;
		status.last_orig_keysym = k.orig_sym;
		status.last_keymod = k.mod;
	}
}

window.addEventListener("keydown", (e) => on_key(e, KEY_PRESS));
window.addEventListener("keyup", (e) => on_key(e, KEY_RELEASE));

// ---------------------------------------------------------------------------
// mouse (mirrors the mouse part of main.c's event loop)

let button_down = -1, start_x = 0, start_y = 0, last_mouse_down = 0, lx = -1, ly = -1;

function mouse_event(e, state, kind) {
	const k = key_event_new();
	if (!key_event_set_mouse(k, e)) return null;
	k.state = state;
	k.mouse = kind;
	k.mouse_button = e.button === 1 ? MOUSE_BUTTON_MIDDLE : e.button === 2 ? MOUSE_BUTTON_RIGHT : MOUSE_BUTTON_LEFT;
	k.sx = start_x;
	k.sy = start_y;
	return k;
}

// the mouse part of main.c's event loop
function mouse_dispatch(k) {
	if (k.state === KEY_RELEASE) {
		const now = performance.now();
		if (lx === k.x && ly === k.y && now - last_mouse_down < 300) { last_mouse_down = 0; k.mouse = MOUSE_DBLCLICK; }
		else { last_mouse_down = now; k.mouse = MOUSE_CLICK; }
		lx = k.x; ly = k.y;
	} else k.mouse = MOUSE_CLICK;
	if (status.dialog_type === DIALOG_NONE && k.y <= 9 && status.current_page !== PAGE.FONT_EDIT
		&& k.state === KEY_RELEASE && k.mouse_button === MOUSE_BUTTON_RIGHT) {
		app.menu_show();
		return;
	}
	if (k.state === KEY_PRESS) k.on_target = widget_change_focus_to_xy(k.x, k.y) ? 1 : 0;
	else if (k.state === KEY_DRAG) k.on_target = widget_find_xy(k.x, k.y) === ui.holder.selected_widget ? 1 : 0;
	handle_key(k);
}

canvas.addEventListener("mousedown", (e) => {
	e.preventDefault();
	canvas.focus();
	const k = mouse_event(e, KEY_PRESS, MOUSE_CLICK);
	if (!k) return;
	button_down = e.button;
	start_x = k.sx = k.x;
	start_y = k.sy = k.y;
	mouse_dispatch(k);
});

window.addEventListener("mouseup", (e) => {
	if (button_down < 0) return;
	const k = mouse_event(e, KEY_RELEASE, MOUSE_CLICK);
	button_down = -1;
	if (k) mouse_dispatch(k);
});

window.addEventListener("mousemove", (e) => {
	if (button_down < 0) return;
	const k = mouse_event(e, KEY_DRAG, MOUSE_CLICK);
	if (k) mouse_dispatch(k);
});

canvas.addEventListener("wheel", (e) => {
	e.preventDefault();
	const k = mouse_event(e, KEY_PRESS, e.deltaY < 0 ? MOUSE_SCROLL_UP : MOUSE_SCROLL_DOWN);
	if (k) handle_key(k);
}, { passive: false });

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// main loop (check_update in main.c)

function frame() {
	if (status_text_pending()) status.flags |= NEED_UPDATE; // lets a flashed message expire

	if (status.flags & NEED_UPDATE) {
		redraw_screen();
		vgamem_flip();
		video_blit();
		status.flags &= ~NEED_UPDATE;
	}
	requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// for tests and debugging from the console
window.schism = { status, PAGE, set_page, missing_calls, app, song: () => current_song, song_load_data };
