/** ANSI-safe text helpers used by pure chrome layout modules. */

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");

export const plainWidth = (text: string): number => Array.from(stripAnsi(text)).length;

export const truncatePlainText = (text: string, width: number): string => {
	if (width <= 0) return "";
	const characters = Array.from(text);
	if (characters.length <= width) return text;
	if (width === 1) return "…";
	return `${characters.slice(0, width - 1).join("")}…`;
};

export const fitStyledText = (text: string, width: number): string =>
	plainWidth(text) <= width ? text : truncatePlainText(stripAnsi(text), width);

export const foreground = (hex: string, text: string): string => {
	const value = Number.parseInt(hex.replace(/^#/, ""), 16);
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
};
