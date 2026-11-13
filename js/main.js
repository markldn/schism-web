// Browser replacement for schism/main.c: start-up and the event loop.
// (Schism Tracker port, GPL-2.0-or-later.)

import { status, PAGE, NEED_UPDATE } from "./state.js";
import { vgamem_flip } from "./vgamem.js";
import { video_init, video_blit } from "./video.js";
import { palette_apply } from "./palettes.js";
import { key_event_from_dom, key_event_new, key_event_set_mouse, kbd_is_modifier_key,
	KEY_PRESS, KEY_RELEASE, KEY_DRAG, MOUSE_CLICK, MOUSE_DBLCLICK, MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN } from "./keyboard.js";
import { redraw_screen, set_page, handle_key, status_text_pending } from "./page.js";
import { missing_calls } from "./app.js";

const canvas = document.getElementById("screen");

video_init(canvas);
palette_apply();
set_page(PAGE.PATTERN_EDITOR); // TODO(port): PAGE.ABOUT (page_about.c) is the real start page

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

let button_down = -1, start_x = 0, start_y = 0, last_click = 0;

function mouse_event(e, state, kind) {
	const k = key_event_new();
	if (!key_event_set_mouse(k, e)) return null;
	k.state = state;
	k.mouse = kind;
	k.mouse_button = e.button === 1 ? 1 : e.button === 2 ? 2 : 0;
	k.sx = start_x;
	k.sy = start_y;
	return k;
}

canvas.addEventListener("mousedown", (e) => {
	e.preventDefault();
	const now = performance.now();
	const dbl = now - last_click < 300;
	last_click = now;
	const k = mouse_event(e, KEY_PRESS, dbl ? MOUSE_DBLCLICK : MOUSE_CLICK);
	if (!k) return;
	button_down = e.button;
	start_x = k.sx = k.x;
	start_y = k.sy = k.y;
	k.on_target = 1;
	handle_key(k);
});

window.addEventListener("mouseup", (e) => {
	if (button_down < 0) return;
	const k = mouse_event(e, KEY_RELEASE, MOUSE_CLICK);
	button_down = -1;
	if (k) handle_key(k);
});

window.addEventListener("mousemove", (e) => {
	if (button_down < 0) return;
	const k = mouse_event(e, KEY_DRAG, MOUSE_CLICK);
	if (k) handle_key(k);
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
window.schism = { status, PAGE, set_page, missing_calls };
