import {
	formatCount,
	formatSleep,
	type KpiKey,
	LOCKIN_TARGETS,
	type Verdict,
} from '@web/lib/lockin';
import { cn } from '@web/lib/utils';
import {
	BeefIcon,
	CheckIcon,
	DumbbellIcon,
	FootprintsIcon,
	LeafIcon,
	type LucideIcon,
	MinusIcon,
	MoonIcon,
	ShieldCheckIcon,
	UtensilsIcon,
	XIcon,
} from 'lucide-react';

export const KPI_ICONS: Record<KpiKey, LucideIcon> = {
	calories: UtensilsIcon,
	protein: BeefIcon,
	steps: FootprintsIcon,
	gym: DumbbellIcon,
	sleep: MoonIcon,
	mate: LeafIcon,
	clean: ShieldCheckIcon,
};

/** The target in as few characters as it takes to read it. */
export const KPI_TARGET_TEXT: Record<KpiKey, string> = {
	calories: `≤ ${formatCount(LOCKIN_TARGETS.caloriesPerDay)} kcal`,
	protein: `≥ ${LOCKIN_TARGETS.proteinGrams} g`,
	steps: `≥ ${formatCount(LOCKIN_TARGETS.steps)}`,
	gym: 'Mon–Sat',
	sleep: `≥ ${formatSleep(LOCKIN_TARGETS.sleepMinutes)}`,
	mate: 'Every day',
	clean: 'Every day',
};

/** A day that has not started yet is not a verdict, but it sits in the same grid. */
export type Mark = Verdict | 'future';

export const MARK_LABELS: Record<Mark, string> = {
	met: 'On target',
	missed: 'Missed',
	pending: 'Not logged',
	rest: 'Rest day',
	future: 'Upcoming',
};

const MARK_STYLES: Record<Mark, string> = {
	met: 'bg-success text-white',
	missed: 'bg-destructive text-white',
	pending: 'bg-muted text-muted-foreground',
	rest: 'border border-dashed border-foreground/20 text-muted-foreground',
	future: 'bg-muted/40',
};

const MARK_ICONS: Partial<Record<Mark, LucideIcon>> = {
	met: CheckIcon,
	missed: XIcon,
	rest: MinusIcon,
};

/**
 * One cell of a status grid. Colour never speaks alone: met and missed carry a
 * check and a cross, and the label is there for a screen reader and a hover.
 */
export function VerdictMark({
	mark,
	label,
	className,
}: {
	mark: Mark;
	/** Absent where the text beside the mark already says it, as in a legend. */
	label?: string;
	className?: string;
}) {
	const Icon = MARK_ICONS[mark];
	return (
		<span
			{...(label
				? { role: 'img', 'aria-label': label, title: label }
				: { 'aria-hidden': true })}
			className={cn(
				'flex items-center justify-center rounded-[4px]',
				MARK_STYLES[mark],
				className,
			)}
		>
			{Icon ? <Icon aria-hidden className="size-3/5" strokeWidth={3} /> : null}
		</span>
	);
}

const PILL_STYLES: Record<Mark, string> = {
	met: 'bg-success',
	missed: 'bg-destructive',
	pending: 'bg-muted-foreground/25',
	// Shorter as well as hollow, so rest reads apart from "not logged" in shape.
	rest: 'mx-auto w-1/2 border border-foreground/30 border-dashed',
	future: 'bg-muted',
};

/**
 * One day of a habit as a pill, like the logged-days ticks of the header: the
 * compact form the habit cards use, a row per week. There is no room for an
 * icon, so the label carries the day and its answer for a hover and a screen
 * reader, and the heading's legend names the colours.
 */
export function VerdictPill({
	mark,
	label,
	className,
}: {
	mark: Mark;
	/** Absent where the text beside the pill already says it, as in a legend. */
	label?: string;
	className?: string;
}) {
	return (
		<span
			{...(label
				? { role: 'img', 'aria-label': label, title: label }
				: { 'aria-hidden': true })}
			className={cn(
				'block h-2 w-full rounded-full',
				PILL_STYLES[mark],
				className,
			)}
		/>
	);
}

/** The legend the habit pills share. */
export function VerdictLegend({ className }: { className?: string }) {
	return (
		<ul
			className={cn(
				'flex flex-wrap items-center gap-x-4 gap-y-2 text-muted-foreground text-xs',
				className,
			)}
		>
			{(['met', 'missed', 'pending', 'rest'] as const).map((mark) => (
				<li key={mark} className="flex items-center gap-1.5">
					<span className="w-4">
						<VerdictPill mark={mark} />
					</span>
					{MARK_LABELS[mark]}
				</li>
			))}
		</ul>
	);
}
