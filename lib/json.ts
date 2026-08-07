/** Shared JSON guards for provider payload parsing. */

export type JsonObject = Readonly<Record<string, unknown>>;

export const isObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Absent/null stays undefined; everything else coerces, non-finite drops out. */
export const toNumber = (value: unknown): number | undefined => {
	if (value === null || value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
};
