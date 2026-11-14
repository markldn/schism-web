// Browser replacement for schism/video.c + sys/sdl2/video.c: owns the canvas,
// the 16-colour palette, and turns vgamem into pixels.
// (Schism Tracker port, GPL-2.0-or-later.)

import { vgamem_scan_all } from "./vgamem.js";

export const NATIVE_SCREEN_WIDTH = 640;
export const NATIVE_SCREEN_HEIGHT = 400;

let canvas = null, ctx = null, image = null, pixels = null;

// palette index -> packed pixel. 256 entries because overlay bytes index it
// directly: 0-15 are the palette, 128-255 the waterfall gradient.
const tc = new Uint32Array(256);
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export function video_init(target) {
	canvas = target;
	canvas.width = NATIVE_SCREEN_WIDTH;
	canvas.height = NATIVE_SCREEN_HEIGHT;
	ctx = canvas.getContext("2d", { alpha: false });
	image = ctx.createImageData(NATIVE_SCREEN_WIDTH, NATIVE_SCREEN_HEIGHT);
	pixels = new Uint32Array(image.data.buffer);
}

/* colors: 16 x [r, g, b], 0-255 */
export function video_colors(colors) {
	for (let i = 0; i < 16; i++) {
		const [r, g, b] = colors[i];
		tc[i] = LITTLE_ENDIAN
			? ((0xFF << 24) | (b << 16) | (g << 8) | r) >>> 0
			: ((r << 24) | (g << 16) | (b << 8) | 0xFF) >>> 0;
	}
	// overlay bytes above 15 only occur OR-ed with the mouse cursor (|15)
	for (let i = 16; i < 128; i++) tc[i] = tc[i & 15];
	// the "gradient" space, used only by the waterfall page (video_colors_iterate)
	const lastmap = [0, 1, 2, 3, 5];
	for (let i = 0; i < 128; i++) {
		const p = lastmap[i >> 5];
		const [r, g, b] = [0, 1, 2].map(j => colors[p][j] + Math.trunc((colors[p + 1][j] - colors[p][j]) * (i & 0x1f) / 0x20));
		tc[128 + i] = LITTLE_ENDIAN
			? ((0xFF << 24) | (b << 16) | (g << 8) | r) >>> 0
			: ((r << 24) | (g << 16) | (b << 8) | 0xFF) >>> 0;
	}
}

export function video_blit() {
	// The browser's own pointer is used, so no software cursor is merged in.
	vgamem_scan_all(pixels, tc, null);
	ctx.putImageData(image, 0, 0);
}

/* window (CSS) coordinates -> native 640x400 pixel coordinates, or null */
export function video_translate(clientX, clientY) {
	const r = canvas.getBoundingClientRect();
	if (!r.width || !r.height) return null;
	const x = Math.floor((clientX - r.left) * NATIVE_SCREEN_WIDTH / r.width);
	const y = Math.floor((clientY - r.top) * NATIVE_SCREEN_HEIGHT / r.height);
	return {
		x: Math.min(Math.max(x, 0), NATIVE_SCREEN_WIDTH - 1),
		y: Math.min(Math.max(y, 0), NATIVE_SCREEN_HEIGHT - 1),
	};
}

export function video_is_wm_available() { return true; }
export function video_get_pixels() { return pixels; }
