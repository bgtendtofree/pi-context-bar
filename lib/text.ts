/** ANSI-safe text helpers used by pure chrome layout modules. */

import { visibleWidth } from "@earendil-works/pi-tui";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");

export const plainWidth = (text: string): number => visibleWidth(text);

export const foreground = (hex: string, text: string): string => {
	const value = Number.parseInt(hex.replace(/^#/, ""), 16);
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
};
