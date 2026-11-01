import { authenticatedApi } from '@web/lib/authenticated-api';
import { conditionalGet } from '@web/lib/http-conditional';
import type { TreatyData } from '@web/lib/treaty-data';

type LockinIndex = Extract<
	TreatyData<typeof authenticatedApi.lockin.get>,
	{ days: unknown[] }
>;

/** The contract itself, never a hand-written copy of it. */
export type LockinDay = LockinIndex['days'][number];

/** Every answer of a day, which is what a save sends: an omission would be ambiguous. */
export type LockinAnswers = Omit<LockinDay, 'date'>;

export type LockinWindow = Pick<LockinIndex, 'from' | 'to'>;

/** The domain refusals the router can answer a save with. */
const REFUSALS = [
	'LOCKIN_OUTSIDE_WINDOW',
	'LOCKIN_SUNDAY_IS_REST',
	'LOCKIN_PREVIOUS_DAY_INCOMPLETE',
	'LOCKIN_LATER_DAY_LOGGED',
] as const;

export type LockinRefusal = (typeof REFUSALS)[number];

const isRefusal = (value: unknown): value is LockinRefusal =>
	(REFUSALS as readonly unknown[]).includes(value);

export class LockinApiError extends Error {
	constructor(
		readonly status: number,
		readonly refusal?: LockinRefusal,
	) {
		super(`Lock-in API returned ${status}`);
	}
}

/** The index, or word that the copy already held is still current. */
export function listLockinDays(
	knownTag?: string,
): Promise<
	{ window: LockinWindow; days: LockinDay[]; tag?: string } | 'unchanged'
> {
	return conditionalGet(
		knownTag,
		(conditional) => authenticatedApi.lockin.get(conditional),
		(response) => {
			const data = response.data;
			if (response.status !== 200 || !data || !('days' in data))
				throw new LockinApiError(response.status);
			return { window: { from: data.from, to: data.to }, days: data.days };
		},
	);
}

export async function saveLockinDay(date: string, answers: LockinAnswers) {
	const response = await authenticatedApi.lockin({ date }).put(answers);
	if (response.status === 200 && response.data && 'date' in response.data)
		return response.data;

	const body = response.error?.value;
	const code =
		body && typeof body === 'object' && 'error' in body
			? body.error
			: undefined;
	throw new LockinApiError(response.status, isRefusal(code) ? code : undefined);
}
