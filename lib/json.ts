/** Shared JSON guards for provider payload parsing. */

export type JsonObject = Readonly<Record<string, unknown>>;

export const isObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Numbers and non-empty numeric strings only; booleans, arrays, objects, and blanks drop out. */
export const toNumber = (value: unknown): number | undefined => {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
};
