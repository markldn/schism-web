// Port of schism/palettes.c (Schism Tracker, GPL-2.0-or-later).

import { PALETTES } from "./gen/palettes.js";
import { status, INVERTED_PALETTE, NEED_UPDATE } from "./state.js";
import { video_colors } from "./video.js";

export const palettes = PALETTES;
export const current_palette = PALETTES[2].colors.map((c) => c.slice());
export let current_palette_index = 2;

export function palette_apply() {
	// 6-bit VGA DAC values -> 8-bit
	video_colors(current_palette.map((c) => [c[0] << 2, c[1] << 2, c[2] << 2]));

	// is the "light" border color actually darker than the "dark" color?
	const sum = (c) => c[0] + c[1] + c[2];
	if (sum(current_palette[1]) > sum(current_palette[3])) status.flags |= INVERTED_PALETTE;
	else status.flags &= ~INVERTED_PALETTE;
	status.flags |= NEED_UPDATE;
}

export function palette_load_preset(index) {
	if (index < 0 || index >= palettes.length) return;
	current_palette_index = index;
	palettes[index].colors.forEach((c, i) => { current_palette[i] = c.slice(); });
	// TODO(port): cfg_save()
}
