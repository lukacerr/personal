import { KPI_TARGET_TEXT } from '@web/components/lockin/lockin-verdict';
import { Button } from '@web/components/ui/button';
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Spinner } from '@web/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@web/components/ui/toggle-group';
import {
	challengeProgress,
	formatDay,
	formatSleep,
	isSunday,
	type LockinLog,
	mustStayComplete,
	parseCount,
	parseSleep,
	parseWeight,
	shiftDate,
} from '@web/lib/lockin';
import type {
	LockinAnswers,
	LockinDay,
	LockinWindow,
} from '@web/lib/lockin-api';
import { BedIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

/** Built fresh on every open, so reopening the same day still resets the form. */
export type LockinDayTarget = { date: string };

type Session = NonNullable<LockinDay['gym']>;

const SESSIONS: Array<{ value: Session; label: string }> = [
	{ value: 'push', label: 'Push' },
	{ value: 'pull', label: 'Pull' },
	{ value: 'legs-core', label: 'Legs-core' },
	{ value: 'cardio', label: 'Cardio' },
	{ value: 'skipped', label: "Didn't go" },
];

const SESSION_VALUES = new Set<string>(SESSIONS.map(({ value }) => value));
const isSession = (value: unknown): value is Session =>
	typeof value === 'string' && SESSION_VALUES.has(value);

const PRESSED = 'aria-pressed:bg-foreground aria-pressed:text-background';

const text = (value: number | null) => (value === null ? '' : String(value));

/** The counts' upper bounds, the same the API refuses past. */
const COUNT_LIMITS = { calories: 20_000, proteinGrams: 1_000, steps: 200_000 };

/** Unreadable, or past what the API would take. Empty is fine. */
const outOfBounds = (value: number | null | undefined, limit: number) =>
	value === undefined || (value !== null && value > limit);

function YesNo({
	labelId,
	value,
	onChange,
}: {
	labelId: string;
	value: boolean | null;
	onChange: (value: boolean | null) => void;
}) {
	return (
		<ToggleGroup
			aria-labelledby={labelId}
			variant="outline"
			value={value === null ? [] : [value ? 'yes' : 'no']}
			onValueChange={([next]) =>
				onChange(next === undefined ? null : next === 'yes')
			}
		>
			<ToggleGroupItem value="yes" className={PRESSED}>
				Yes
			</ToggleGroupItem>
			<ToggleGroupItem value="no" className={PRESSED}>
				No
			</ToggleGroupItem>
		</ToggleGroup>
	);
}

/**
 * Logging one day, or correcting it.
 *
 * Every field may stay empty while the day fills in — the weight in the
 * morning, the totals at night — and an empty field is "not answered", never
 * zero. The one exception is the rule the API enforces too: once the next day
 * is logged, this one can be corrected but not emptied again.
 */
export function LockinDayDialog({
	target,
	window,
	log,
	busy,
	error,
	onSubmit,
	onClose,
}: {
	target: LockinDayTarget | undefined;
	window: LockinWindow;
	log: LockinLog;
	busy: boolean;
	/** Stays inside the dialog: a rejected save is a condition, not a notice. */
	error: string | undefined;
	onSubmit: (date: string, answers: LockinAnswers) => void;
	onClose: () => void;
}) {
	const weightId = useId();
	const sleepId = useId();
	const caloriesId = useId();
	const proteinId = useId();
	const stepsId = useId();
	const gymId = useId();
	const mateId = useId();
	const cleanId = useId();

	const [weight, setWeight] = useState('');
	const [sleep, setSleep] = useState('');
	const [calories, setCalories] = useState('');
	const [protein, setProtein] = useState('');
	const [steps, setSteps] = useState('');
	const [gym, setGym] = useState<Session | null>(null);
	const [mate, setMate] = useState<boolean | null>(null);
	const [masturbated, setMasturbated] = useState<boolean | null>(null);
	const [invalid, setInvalid] = useState<string>();

	const date = target?.date;
	const sunday = date ? isSunday(date) : false;

	// Keyed on the target's identity: the parent builds a fresh one per open.
	// biome-ignore lint/correctness/useExhaustiveDependencies(log.get): seeded once per open; a refresh landing mid-edit must not wipe what is being typed
	useEffect(() => {
		const day = target ? log.get(target.date) : undefined;
		setWeight(day?.weightKg === null || !day ? '' : String(day.weightKg));
		setSleep(
			day?.sleepMinutes === null || !day ? '' : formatSleep(day.sleepMinutes),
		);
		setCalories(text(day?.calories ?? null));
		setProtein(text(day?.proteinGrams ?? null));
		setSteps(text(day?.steps ?? null));
		setGym(day?.gym ?? null);
		setMate(day?.mateAndSupplements ?? null);
		setMasturbated(day?.masturbated ?? null);
		setInvalid(undefined);
	}, [target]);

	function submit(event: React.FormEvent) {
		event.preventDefault();
		if (!date) return;

		const weightKg = parseWeight(weight);
		if (weightKg === undefined) {
			setInvalid('Enter the weight in kilograms, like 82,4.');
			return;
		}
		const sleepMinutes = parseSleep(sleep);
		if (sleep.trim() && sleepMinutes === undefined) {
			setInvalid('Enter the sleep as hours and minutes, like 7:30.');
			return;
		}

		const kcal = parseCount(calories);
		if (outOfBounds(kcal, COUNT_LIMITS.calories)) {
			setInvalid('Enter the calories as a whole number of kcal.');
			return;
		}
		const grams = parseCount(protein);
		if (outOfBounds(grams, COUNT_LIMITS.proteinGrams)) {
			setInvalid('Enter the protein as a whole number of grams.');
			return;
		}
		const walked = parseCount(steps);
		if (outOfBounds(walked, COUNT_LIMITS.steps)) {
			setInvalid('Enter the steps as a whole number.');
			return;
		}

		const answers: LockinAnswers = {
			calories: kcal ?? null,
			proteinGrams: grams ?? null,
			steps: walked ?? null,
			weightKg,
			sleepMinutes: sleepMinutes ?? null,
			gym: sunday ? null : gym,
			mateAndSupplements: mate,
			masturbated,
		};

		// The same rule the API holds, from this entry point too.
		const empty = Object.entries(answers).some(
			([field, value]) => value === null && !(field === 'gym' && sunday),
		);
		if (empty && mustStayComplete(date, log)) {
			setInvalid(
				`${formatDay(shiftDate(date, 1))} is already logged, so every answer here has to stay filled.`,
			);
			return;
		}

		setInvalid(undefined);
		onSubmit(date, answers);
	}

	const progress = date ? challengeProgress(window, date) : undefined;

	return (
		<Dialog
			open={target !== undefined}
			onOpenChange={(open) => !open && onClose()}
		>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
				<form onSubmit={submit} className="flex flex-col gap-5">
					<DialogHeader>
						<DialogTitle>{date ? formatDay(date) : 'Log day'}</DialogTitle>
						<DialogDescription>
							{progress ? `Day ${progress.day} of ${progress.total}. ` : ''}
							Leave anything you don't know yet empty.
						</DialogDescription>
					</DialogHeader>

					<div className="grid grid-cols-2 gap-4">
						<div className="flex flex-col gap-1.5 text-sm">
							<label htmlFor={weightId}>Weight in · kg</label>
							{/* Text with a decimal keypad: `82,4` and `82.4` both have to work. */}
							<Input
								id={weightId}
								value={weight}
								inputMode="decimal"
								placeholder="82,4"
								onChange={(event) => setWeight(event.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5 text-sm">
							<label htmlFor={sleepId} className="flex justify-between gap-2">
								Sleep · h:mm
								<span className="font-mono text-muted-foreground text-xs">
									{KPI_TARGET_TEXT.sleep}
								</span>
							</label>
							<Input
								id={sleepId}
								value={sleep}
								placeholder="7:30"
								onChange={(event) => setSleep(event.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5 text-sm">
							<label
								htmlFor={caloriesId}
								className="flex justify-between gap-2"
							>
								Calories
								<span className="font-mono text-muted-foreground text-xs">
									{KPI_TARGET_TEXT.calories}
								</span>
							</label>
							<Input
								id={caloriesId}
								value={calories}
								inputMode="numeric"
								placeholder="2400"
								onChange={(event) => setCalories(event.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5 text-sm">
							<label htmlFor={proteinId} className="flex justify-between gap-2">
								Protein · g
								<span className="font-mono text-muted-foreground text-xs">
									{KPI_TARGET_TEXT.protein}
								</span>
							</label>
							<Input
								id={proteinId}
								value={protein}
								inputMode="numeric"
								placeholder="180"
								onChange={(event) => setProtein(event.target.value)}
							/>
						</div>
						<div className="col-span-2 flex flex-col gap-1.5 text-sm">
							<label htmlFor={stepsId} className="flex justify-between gap-2">
								Steps
								<span className="font-mono text-muted-foreground text-xs">
									{KPI_TARGET_TEXT.steps}
								</span>
							</label>
							<Input
								id={stepsId}
								value={steps}
								inputMode="numeric"
								placeholder="14000"
								onChange={(event) => setSteps(event.target.value)}
							/>
						</div>
					</div>

					<div className="flex flex-col gap-1.5 text-sm">
						<span id={gymId}>Gym</span>
						{sunday ? (
							<p className="flex items-center gap-2 text-muted-foreground">
								<BedIcon aria-hidden className="size-4" />
								Sunday is the rest day.
							</p>
						) : (
							<ToggleGroup
								aria-labelledby={gymId}
								variant="outline"
								className="flex-wrap"
								value={gym ? [gym] : []}
								onValueChange={([next]) =>
									setGym(isSession(next) ? next : null)
								}
							>
								{SESSIONS.map(({ value, label }) => (
									<ToggleGroupItem
										key={value}
										value={value}
										className={PRESSED}
									>
										{label}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						)}
					</div>

					<div className="grid grid-cols-2 gap-4">
						<div className="flex flex-col gap-1.5 text-sm">
							<span id={mateId}>Mate & supplements</span>
							<YesNo labelId={mateId} value={mate} onChange={setMate} />
						</div>
						<div className="flex flex-col gap-1.5 text-sm">
							<span id={cleanId}>Masturbated</span>
							<YesNo
								labelId={cleanId}
								value={masturbated}
								onChange={setMasturbated}
							/>
						</div>
					</div>

					{invalid || error ? (
						<p role="alert" className="text-destructive text-sm">
							{invalid ?? error}
						</p>
					) : null}

					<DialogFooter>
						<DialogClose
							render={
								<Button type="button" variant="outline">
									Cancel
								</Button>
							}
						/>
						<Button type="submit" disabled={busy}>
							{busy ? <Spinner /> : null}
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
