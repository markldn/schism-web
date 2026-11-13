// Browser replacement for sys/sdl2/events.c: turns DOM keyboard and mouse
// events into Schism's `struct key_event`. (Schism Tracker port, GPL-2.0-or-later.)
// The second half of the file is the port of schism/keyboard.c. Key repeat is
// left to the browser (KeyboardEvent.repeat), so kbd_*_key_repeat is not needed.

import { SCANCODE, KEYSYM, KEYMOD } from "./gen/keys.js";
import { video_translate, NATIVE_SCREEN_WIDTH, NATIVE_SCREEN_HEIGHT } from "./video.js";
import { status, NEED_UPDATE, CLASSIC_MODE, META_IS_CTRL, ALTGR_IS_ALT } from "./state.js";
import { app } from "./app.js";

export { SCANCODE, KEYSYM, KEYMOD };

export const KEY_PRESS = 0, KEY_RELEASE = 1, KEY_DRAG = 2;
export const MOUSE_NONE = 0, MOUSE_CLICK = 1, MOUSE_SCROLL_UP = 2, MOUSE_SCROLL_DOWN = 3, MOUSE_DBLCLICK = 4;
export const MOUSE_BUTTON_LEFT = 0, MOUSE_BUTTON_MIDDLE = 1, MOUSE_BUTTON_RIGHT = 2;

export const NO_MODIFIER = (mod) => (mod & (KEYMOD.CTRL | KEYMOD.ALT | KEYMOD.SHIFT)) === 0;
export const NO_CAM_MODS = (mod) => (mod & (KEYMOD.CTRL | KEYMOD.ALT)) === 0;

// KeyboardEvent.code -> [scancode name, keysym on a US layout]
const CODES = {
	Enter: ["RETURN", KEYSYM.RETURN], Escape: ["ESCAPE", KEYSYM.ESCAPE], Backspace: ["BACKSPACE", KEYSYM.BACKSPACE],
	Tab: ["TAB", KEYSYM.TAB], Space: ["SPACE", KEYSYM.SPACE], Minus: ["MINUS", 45], Equal: ["EQUALS", 61],
	BracketLeft: ["LEFTBRACKET", 91], BracketRight: ["RIGHTBRACKET", 93], Backslash: ["BACKSLASH", 92],
	Semicolon: ["SEMICOLON", 59], Quote: ["APOSTROPHE", 39], Backquote: ["GRAVE", 96], Comma: ["COMMA", 44],
	Period: ["PERIOD", 46], Slash: ["SLASH", 47], CapsLock: ["CAPSLOCK", KEYSYM.CAPSLOCK],
	PrintScreen: ["PRINTSCREEN", KEYSYM.PRINTSCREEN], ScrollLock: ["SCROLLLOCK", KEYSYM.SCROLLLOCK],
	Pause: ["PAUSE", KEYSYM.PAUSE], Insert: ["INSERT", KEYSYM.INSERT], Home: ["HOME", KEYSYM.HOME],
	PageUp: ["PAGEUP", KEYSYM.PAGEUP], Delete: ["DELETE", KEYSYM.DELETE], End: ["END", KEYSYM.END],
	PageDown: ["PAGEDOWN", KEYSYM.PAGEDOWN], ArrowRight: ["RIGHT", KEYSYM.RIGHT], ArrowLeft: ["LEFT", KEYSYM.LEFT],
	ArrowDown: ["DOWN", KEYSYM.DOWN], ArrowUp: ["UP", KEYSYM.UP], NumLock: ["NUMLOCKCLEAR", KEYSYM.NUMLOCKCLEAR],
	NumpadDivide: ["KP_DIVIDE", KEYSYM.KP_DIVIDE], NumpadMultiply: ["KP_MULTIPLY", KEYSYM.KP_MULTIPLY],
	NumpadSubtract: ["KP_MINUS", KEYSYM.KP_MINUS], NumpadAdd: ["KP_PLUS", KEYSYM.KP_PLUS],
	NumpadEnter: ["KP_ENTER", KEYSYM.KP_ENTER], NumpadDecimal: ["KP_PERIOD", KEYSYM.KP_PERIOD],
	NumpadEqual: ["KP_EQUALS", KEYSYM.KP_EQUALS], IntlBackslash: ["NONUSBACKSLASH", 92],
	ContextMenu: ["APPLICATION", KEYSYM.APPLICATION],
	ControlLeft: ["LCTRL", KEYSYM.LCTRL], ShiftLeft: ["LSHIFT", KEYSYM.LSHIFT], AltLeft: ["LALT", KEYSYM.LALT],
	MetaLeft: ["LGUI", KEYSYM.LGUI], ControlRight: ["RCTRL", KEYSYM.RCTRL], ShiftRight: ["RSHIFT", KEYSYM.RSHIFT],
	AltRight: ["RALT", KEYSYM.RALT], MetaRight: ["RGUI", KEYSYM.RGUI],
};
for (let i = 0; i < 26; i++) {
	const up = String.fromCharCode(65 + i);
	CODES["Key" + up] = [up, 97 + i];
}
for (let i = 0; i < 10; i++) {
	CODES["Digit" + i] = [String(i), 48 + i];
	CODES["Numpad" + i] = ["KP_" + i, KEYSYM["KP_" + i]];
}
for (let i = 1; i <= 24; i++) CODES["F" + i] = ["F" + i, KEYSYM["F" + i]];

function mods_from(e) {
	let m = 0;
	if (e.ctrlKey) m |= KEYMOD.LCTRL;
	if (e.shiftKey) m |= KEYMOD.LSHIFT;
	if (e.altKey) m |= (e.getModifierState && e.getModifierState("AltGraph")) ? KEYMOD.RALT : KEYMOD.LALT;
	if (e.metaKey) m |= KEYMOD.LGUI;
	if (e.getModifierState) {
		if (e.getModifierState("NumLock")) m |= KEYMOD.NUM;
		if (e.getModifierState("CapsLock")) m |= KEYMOD.CAPS;
	}
	return m;
}

export function key_event_new() {
	return {
		sym: 0, orig_sym: 0, scancode: 0, mod: 0, text: null,
		state: KEY_PRESS, mouse: MOUSE_NONE, mouse_button: MOUSE_BUTTON_LEFT,
		midi_note: -1, midi_channel: 0, midi_volume: -1, midi_bend: 0,
		sx: 0, sy: 0, x: 0, hx: 0, fx: 0, y: 0, fy: 0,
		rx: NATIVE_SCREEN_WIDTH / 80, ry: NATIVE_SCREEN_HEIGHT / 50,
		is_repeat: 0, on_target: 0, is_synthetic: 0,
	};
}

/* DOM KeyboardEvent -> key_event (or null for keys Schism has no symbol for) */
export function key_event_from_dom(e, state) {
	const k = key_event_new();
	const known = CODES[e.code];

	k.state = state;
	k.mod = mods_from(e);
	k.is_repeat = e.repeat ? 1 : 0;

	if (known) {
		k.scancode = SCANCODE[known[0]] || 0;
		k.sym = known[1];
		// SDL reports the layout's unshifted character for printable keys
		if (k.sym >= 32 && k.sym < 127 && e.key.length === 1 && !e.shiftKey && !e.ctrlKey && !e.altKey)
			k.sym = e.key.toLowerCase().codePointAt(0);
	} else if (e.key.length === 1) {
		k.sym = e.key.toLowerCase().codePointAt(0);
	} else {
		return null;
	}

	if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !(e.altKey && !(k.mod & KEYMOD.RALT)))
		k.text = e.key;

	kbd_key_translate(k);
	if (state !== KEY_PRESS) k.text = null;

	return k;
}

/* fills in the mouse position fields of `k` from a DOM mouse event */
export function key_event_set_mouse(k, e) {
	const p = video_translate(e.clientX, e.clientY);
	if (!p) return false;
	k.fx = p.x;
	k.fy = p.y;
	k.x = Math.floor(p.x / k.rx);
	k.y = Math.floor(p.y / k.ry);
	k.hx = Math.floor(p.x / (k.rx / 2)); // half-character column
	k.mod = mods_from(e);
	return true;
}

// ===========================================================================
// schism/keyboard.c

export const NOTE_FADE = 246, NOTE_CUT = 254, NOTE_OFF = 255;
const VOLFX_NONE = 0, VOLFX_VOLUME = 1, VOLFX_PANNING = 2;

const note_names_up = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
const note_names_short_up = "cCdDefFgGaAb";
const note_names_down = ["C-", "Db", "D-", "Eb", "E-", "F-", "Gb", "G-", "Ab", "A-", "Bb", "B-"];
const note_names_short_down = "CdDeEFgGaAbB";

let note_names = note_names_up;
let note_names_short = note_names_short_up;
let current_octave = 4;

export const hexdigits = "0123456789ABCDEF";

/* extra non-IT effects: '!' = volume, '$' = keyoff, '&' = setenvposition,
 * '('/')' = noteslide up/down (IMF) */
const effects = ".JFEGHLKRXODB!CQATI?SMNVW$UY?P&Z()?";
const ptm_effects = ".0123456789ABCDRFFT????GHK?YXPLZ()?";

export const KBD_SHARP_FLAT_TOGGLE = -1, KBD_SHARP_FLAT_SHARPS = 0, KBD_SHARP_FLAT_FLATS = 1;

export function kbd_sharp_flat_state() {
	return note_names === note_names_up ? KBD_SHARP_FLAT_SHARPS : KBD_SHARP_FLAT_FLATS;
}

export function kbd_sharp_flat_toggle(e) {
	if (e === KBD_SHARP_FLAT_TOGGLE)
		e = note_names === note_names_up ? KBD_SHARP_FLAT_FLATS : KBD_SHARP_FLAT_SHARPS;
	if (e === KBD_SHARP_FLAT_FLATS) {
		app.status_text_flash("Displaying accidentals as flats (b)");
		note_names = note_names_down;
		note_names_short = note_names_short_down;
	} else {
		app.status_text_flash("Displaying accidentals as sharps (#)");
		note_names = note_names_up;
		note_names_short = note_names_short_up;
	}
}

export function get_effect_char(effect) {
	if (effect < 0 || effect >= effects.length) return "?";
	return effects[effect];
}

const upper = (c) => (c >= 97 && c <= 122 ? c - 32 : c);

/* `effect` is a character code */
export function get_ptm_effect_number(effect) {
	return ptm_effects.indexOf(String.fromCharCode(upper(effect)));
}

export function get_effect_number(effect) {
	if (effect >= 97 && effect <= 122) {
		effect -= 32;
	} else if (!((effect >= 48 && effect <= 57) || (effect >= 65 && effect <= 90) || effect === 46)) {
		/* don't accept pseudo-effects */
		if (status.flags & CLASSIC_MODE) return -1;
	}
	return effects.indexOf(String.fromCharCode(effect));
}

export function kbd_get_effect_number(k) {
	if (!NO_CAM_MODS(k.mod)) return -1;

	if (k.sym >= 97 && k.sym <= 122) return get_effect_number(k.sym);

	switch (k.sym) {
	case KEYSYM.PERIOD: case KEYSYM.KP_PERIOD:
		return get_effect_number(46);
	case KEYSYM["1"]:
		if (!(k.mod & KEYMOD.SHIFT)) return -1;
		/* fall through */
	case KEYSYM.EXCLAIM:
		return get_effect_number(33);
	case KEYSYM["4"]:
		if (!(k.mod & KEYMOD.SHIFT)) return -1;
		/* fall through */
	case KEYSYM.DOLLAR:
		return get_effect_number(36);
	case KEYSYM["7"]:
		if (!(k.mod & KEYMOD.SHIFT)) return -1;
		/* fall through */
	case KEYSYM.AMPERSAND:
		return get_effect_number(38);
	default:
		return -1;
	}
}

const KP_NUM = {
	KP_0: "0", KP_1: "1", KP_2: "2", KP_3: "3", KP_4: "4", KP_5: "5", KP_6: "6", KP_7: "7", KP_8: "8", KP_9: "9",
	KP_PERIOD: "PERIOD", KP_DIVIDE: "SLASH", KP_MULTIPLY: "ASTERISK", KP_MINUS: "MINUS", KP_PLUS: "PLUS",
	KP_ENTER: "RETURN", KP_EQUALS: "EQUALS",
};
const KP_NONUM = {
	KP_0: "INSERT", KP_4: "LEFT", KP_6: "RIGHT", KP_2: "DOWN", KP_8: "UP", KP_9: "PAGEUP", KP_3: "PAGEDOWN",
	KP_7: "HOME", KP_1: "END", KP_PERIOD: "DELETE", KP_DIVIDE: "SLASH", KP_MULTIPLY: "ASTERISK",
	KP_MINUS: "MINUS", KP_PLUS: "PLUS", KP_ENTER: "RETURN", KP_EQUALS: "EQUALS",
};
const kp_map = (table) => new Map(Object.entries(table).map(([from, to]) => [KEYSYM[from], KEYSYM[to]]));
const KP_NUM_MAP = kp_map(KP_NUM), KP_NONUM_MAP = kp_map(KP_NONUM);
const TEXT_SYMS = { "<": "LESS", ">": "GREATER", "$": "DOLLAR", "+": "PLUS", ":": "COLON", "*": "ASTERISK", "/": "SLASH", "\\": "BACKSLASH" };

export function kbd_key_translate(k) {
	k.orig_sym = k.sym;

	if (k.text && TEXT_SYMS[k.text[0]]) k.sym = KEYSYM[TEXT_SYMS[k.text[0]]];

	if (k.mod & KEYMOD.GUI)
		k.mod = (k.mod & ~KEYMOD.GUI) | ((status.flags & META_IS_CTRL) ? KEYMOD.CTRL : KEYMOD.ALT);

	if ((k.mod & KEYMOD.MODE) && (status.flags & ALTGR_IS_ALT))
		k.mod = (k.mod & ~KEYMOD.MODE) | KEYMOD.ALT;

	if (k.mod & KEYMOD.NUM) {
		if (KP_NUM_MAP.has(k.sym)) {
			k.sym = KP_NUM_MAP.get(k.sym);
			k.mod &= ~KEYMOD.NUM;
		}
	} else if (KP_NONUM_MAP.has(k.sym)) {
		k.sym = KP_NONUM_MAP.get(k.sym);
	}
}

export function kbd_is_modifier_key(k) {
	switch (k.sym) {
	case KEYSYM.LCTRL: case KEYSYM.LSHIFT: case KEYSYM.LALT: case KEYSYM.LGUI:
	case KEYSYM.RCTRL: case KEYSYM.RSHIFT: case KEYSYM.RALT: case KEYSYM.RGUI:
		return 1;
	default:
		return 0;
	}
}

export function numeric_key_event(k, kponly) {
	if (kponly) {
		for (let i = 0; i < 10; i++) if (k.orig_sym === KEYSYM["KP_" + i]) return i;
		return -1;
	}
	if (k.sym >= 48 && k.sym <= 57) return k.sym - 48;
	for (let i = 0; i < 10; i++) if (k.sym === KEYSYM["KP_" + i]) return i;
	return -1;
}

export function get_volume_string(volume, volume_effect) {
	const cmd_table = "...CDAB$H<>GFE";
	if (volume_effect < 0 || volume_effect > 13) return "??";
	/* '$'=vibratospeed, '<'=panslideleft, '>'=panslideright */
	switch (volume_effect) {
	case VOLFX_NONE: return "\xAD\xAD";
	case VOLFX_VOLUME:
	case VOLFX_PANNING: return String(volume >>> 0).padStart(2, "0").slice(0, 2);
	default: return cmd_table[volume_effect] + hexdigits[volume & 15];
	}
}

export function get_note_string(note) {
	if ((note < 0 || note > 120) && !(note === NOTE_CUT || note === NOTE_OFF || note === NOTE_FADE)) return "???";
	switch (note) {
	case 0: return "\xAD\xAD\xAD";
	case NOTE_CUT: return "\x5E\x5E\x5E";
	case NOTE_OFF: return "\xCD\xCD\xCD";
	case NOTE_FADE: return "\x7E\x7E\x7E";
	default:
		note--;
		return note_names[note % 12] + String.fromCharCode(Math.trunc(note / 12) + 48);
	}
}

export function get_note_string_short(note) {
	if ((note < 0 || note > 120) && !(note === NOTE_CUT || note === NOTE_OFF || note === NOTE_FADE)) return "??";
	switch (note) {
	case 0: return "\xAD\xAD";
	case NOTE_CUT: return "\x5E\x5E";
	case NOTE_OFF: return "\xCD\xCD";
	case NOTE_FADE: return "\x7E\x7E";
	default:
		note--;
		return note_names_short[note % 12] + String.fromCharCode(Math.trunc(note / 12) + 48);
	}
}

export function kbd_get_current_octave() { return current_octave; }

export function kbd_set_current_octave(new_octave) {
	current_octave = Math.min(Math.max(new_octave, 0), 8);
	status.flags |= NEED_UPDATE;
}

export function kbd_char_to_hex(k) {
	if (!NO_CAM_MODS(k.mod)) return -1;
	if (k.sym >= 48 && k.sym <= 57) return k.sym - 48;
	if (k.sym >= 97 && k.sym <= 102) return k.sym - 97 + 10;
	return -1;
}

export function kbd_char_to_99(k) {
	if (!NO_CAM_MODS(k.mod)) return -1;
	let c = k.sym;
	if (c >= 65 && c <= 90) c += 32;
	if (c >= 104 && c <= 122) return 10 + c - 104;
	return kbd_char_to_hex(k);
}

const NOTE_SCANCODES = new Map([
	"Z", "S", "X", "D", "C", "V", "G", "B", "H", "N", "J", "M",
	"Q", "2", "W", "3", "E", "R", "5", "T", "6", "Y", "7", "U", "I", "9", "O", "0", "P",
].map((name, i) => [SCANCODE[name], i + 1]));

/* return values: < 0 = invalid note, 0 = clear field, 1-120 = note,
 * NOTE_CUT / NOTE_OFF / NOTE_FADE */
export function kbd_get_note(k) {
	if (k.mod & (KEYMOD.ALT | KEYMOD.CTRL)) return -1;

	if (k.mod & KEYMOD.SHIFT)
		return k.scancode === SCANCODE.GRAVE ? NOTE_FADE : -1;

	switch (k.scancode) {
	case SCANCODE.GRAVE:
	case SCANCODE.NONUSHASH: /* for delt */
	case SCANCODE.KP_HASH:
		return NOTE_OFF;
	case SCANCODE["1"]:
		return NOTE_CUT;
	case SCANCODE.PERIOD:
		return 0; /* clear */
	}

	const base = NOTE_SCANCODES.get(k.scancode);
	if (base === undefined) return -1;
	return Math.min(Math.max(base + 12 * current_octave, 1), 120);
}

const SHIFTED = { "[": "{", "]": "}", ";": ":", "=": "+", "-": "_", "`": "~", ",": "<", ".": ">", "/": "?", "\\": "|", "'": '"' };

/* returns a character code, or 0 */
export function kbd_get_alnum(k) {
	if (k.sym >= 127) return 0;
	if (k.mod & KEYMOD.SHIFT) {
		const o = k.orig_sym;
		if (o >= 97 && o <= 122) return upper(k.sym);
		if (o >= 48 && o <= 57) return ")!@#$%^&*(".charCodeAt(k.sym - 48);
		const s = SHIFTED[String.fromCharCode(o)];
		return s ? s.charCodeAt(0) : k.sym;
	}
	return k.sym;
}
