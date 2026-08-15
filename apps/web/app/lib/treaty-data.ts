/**
 * The payload of an Eden Treaty endpoint, unwrapped from its `{ data }`
 * envelope. Every system that derives its types from the API contract needs
 * this same unwrapping, so it lives once here instead of a copy per system.
 */
export type TreatyData<T> = T extends (...args: infer _Args) => infer Result
	? Awaited<Result> extends { data: infer Data }
		? NonNullable<Data>
		: never
	: never;
