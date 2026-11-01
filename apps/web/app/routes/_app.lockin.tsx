import { LockinCalendar } from '@web/components/lockin/lockin-calendar';
import {
	LockinDayDialog,
	type LockinDayTarget,
} from '@web/components/lockin/lockin-day-dialog';
import { LockinHero } from '@web/components/lockin/lockin-hero';
import { LockinKpis } from '@web/components/lockin/lockin-kpis';
import { LockinMisses } from '@web/components/lockin/lockin-misses';
import { LockinWeeks } from '@web/components/lockin/lockin-weeks';
import { Button } from '@web/components/ui/button';
import { Spinner } from '@web/components/ui/spinner';
import { useConsumeCreateParam } from '@web/lib/create-param';
import { indexUnavailable } from '@web/lib/index-store';
import {
	challengeProgress,
	dayAccess,
	formatDay,
	localDateOf,
	lockinMisses,
	nextDayToLog,
} from '@web/lib/lockin';
import type { LockinAnswers } from '@web/lib/lockin-api';
import { lockinLogOf, useLockinStore } from '@web/lib/lockin-store';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

export function meta() {
	return [{ title: 'Lock-in · Personal' }];
}

export default function Lockin() {
	const { window, days, status, error, load, save } = useLockinStore();

	// Read once per mount, like Finance: a fresh date per render could straddle
	// midnight halfway through drawing the screen.
	const today = useMemo(() => localDateOf(new Date()), []);
	const log = useMemo(() => lockinLogOf(days), [days]);

	const [target, setTarget] = useState<LockinDayTarget>();
	const [formError, setFormError] = useState<string>();
	const [busy, setBusy] = useState(false);
	// "Log day" from the palette or the sidebar can arrive before the log has.
	const [wantsNext, setWantsNext] = useState(false);

	useEffect(() => {
		void load();
	}, [load]);

	const open = useCallback((date: string) => {
		setFormError(undefined);
		setTarget({ date });
	}, []);

	useConsumeCreateParam(useCallback(() => setWantsNext(true), []));

	useEffect(() => {
		if (!wantsNext || !window) return;
		setWantsNext(false);
		const progress = challengeProgress(window, today);
		// Before the start nothing is owed yet, so it opens on the first day;
		// with everything logged through today, today is the one to correct.
		const fallback =
			progress.phase === 'upcoming'
				? window.from
				: progress.phase === 'running'
					? today
					: window.to;
		open(nextDayToLog(window, log, today) ?? fallback);
	}, [wantsNext, window, today, log, open]);

	async function submit(date: string, answers: LockinAnswers) {
		setBusy(true);
		const failure = await save(date, answers);
		setBusy(false);
		if (failure) {
			setFormError(failure);
			return;
		}
		setTarget(undefined);
		toast.success(`${formatDay(date)} saved.`);
	}

	const misses = useMemo(
		() => (window ? lockinMisses(window, log, today) : []),
		[window, log, today],
	);

	if (!window)
		return (
			<section
				aria-label="Lock-in"
				className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 sm:p-6"
			>
				{indexUnavailable(status) ? (
					<div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
						<p className="font-medium">{error}</p>
						<Button variant="outline" onClick={() => void load(true)}>
							Try again
						</Button>
					</div>
				) : (
					<div className="flex items-center justify-center gap-3 py-16 text-muted-foreground text-sm">
						<Spinner /> Loading the log…
					</div>
				)}
			</section>
		);

	return (
		<section
			aria-label="Lock-in"
			className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6"
		>
			{indexUnavailable(status) && error ? (
				<div
					role="alert"
					className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
				>
					<p>{error}</p>
					<Button size="sm" variant="outline" onClick={() => void load(true)}>
						Try again
					</Button>
				</div>
			) : null}

			<LockinHero window={window} log={log} today={today} onLog={open} />

			<LockinKpis window={window} log={log} today={today} />

			<LockinWeeks window={window} log={log} today={today} />

			<LockinCalendar
				window={window}
				log={log}
				today={today}
				onOpen={(date) => {
					if (dayAccess(date, window, log) === 'open') open(date);
				}}
			/>

			<LockinMisses misses={misses} />

			<LockinDayDialog
				target={target}
				window={window}
				log={log}
				busy={busy}
				error={formError}
				onSubmit={(date, answers) => void submit(date, answers)}
				onClose={() => setTarget(undefined)}
			/>
		</section>
	);
}
