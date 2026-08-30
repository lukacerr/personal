import {
	Command,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from '@web/components/ui/command';
import { type ComponentType, useState } from 'react';

/**
 * One row of a picker, whatever the picker lists. `group` is the key the rail
 * filters by and the heading the list shows; `hint` is the second line, and
 * `badges` are short capability words — never a sentence, they sit inline.
 */
export type PickerEntity = {
	id: string;
	label: string;
	group: string;
	hint?: string;
	badges?: readonly PickerBadge[];
};

/**
 * A capability mark on a row. The glyph is what gets scanned; `label` is what
 * the row is called out loud and on hover, because an icon alone is not a
 * message anyone can read back.
 */
export type PickerBadge = {
	icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
	label: string;
};

export type PickerGroupCount = { group: string; count: number };

/** Everything a row carries is searchable, including its group name. */
export function matchesEntity(entity: PickerEntity, query: string) {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return true;
	return `${entity.id} ${entity.label} ${entity.group} ${entity.hint ?? ''}`
		.toLowerCase()
		.includes(needle);
}

/**
 * Groups in the order the catalogue lists them — the server already orders
 * what it prefers first — each with how many of its rows the query matches.
 */
export function groupCounts(
	entities: readonly PickerEntity[],
	query: string,
): PickerGroupCount[] {
	const counts: PickerGroupCount[] = [];
	for (const entity of entities) {
		const found = counts.find((entry) => entry.group === entity.group);
		const hit = matchesEntity(entity, query) ? 1 : 0;
		if (found) found.count += hit;
		else counts.push({ group: entity.group, count: hit });
	}
	return counts;
}

/**
 * A group filter only survives while it has something to show: typing a query
 * no group but the active one matches would otherwise answer "nothing matches"
 * while the row sits one click away. Falling back to all is the answer that
 * still shows the match.
 */
export function resolveGroup(
	group: string | undefined,
	counts: readonly PickerGroupCount[],
) {
	if (group === undefined) return undefined;
	return counts.some((entry) => entry.group === group && entry.count > 0)
		? group
		: undefined;
}

export function visibleEntities(
	entities: readonly PickerEntity[],
	group: string | undefined,
	query: string,
) {
	return entities.filter(
		(entity) =>
			(group === undefined || entity.group === group) &&
			matchesEntity(entity, query),
	);
}

/**
 * The two-pane picker both registries use: groups on the left, rows on the
 * right, one search field over everything. Written once because models and
 * tools are the same problem — a list meant to grow that a flat menu turns
 * into a scroll — and because the second copy is where the two would drift.
 *
 * Filtering is ours (`shouldFilter={false}`): the rail is a second axis cmdk
 * knows nothing about, and the group counts have to come from the same pass
 * that decides the rows.
 */
export function AgentEntityPicker({
	entities,
	selected,
	forced = [],
	noun,
	groupsLabel,
	forcedHint,
	onSelect,
}: {
	entities: readonly PickerEntity[];
	selected: readonly string[];
	/** Granted whatever the selection says: checked, and not toggleable. */
	forced?: readonly string[];
	/** Plural, for the search placeholder and the empty state. */
	noun: string;
	/** What the left rail filters by, for its accessible name. */
	groupsLabel: string;
	forcedHint?: string;
	onSelect: (id: string) => void;
}) {
	const [query, setQuery] = useState('');
	const [group, setGroup] = useState<string>();
	const counts = groupCounts(entities, query);
	const activeGroup = resolveGroup(group, counts);
	const visible = visibleEntities(entities, activeGroup, query);
	const total = counts.reduce((sum, entry) => sum + entry.count, 0);
	const groupsShown =
		activeGroup === undefined
			? counts.filter((entry) => entry.count > 0).map((entry) => entry.group)
			: [activeGroup];

	return (
		<Command
			loop
			shouldFilter={false}
			className="rounded-none bg-transparent p-0 [&_[data-slot=command-input-wrapper]]:pr-0 [&_[data-slot=input-group]]:h-11"
		>
			<CommandInput
				value={query}
				onValueChange={setQuery}
				placeholder={`Search ${noun}…`}
			/>
			<div className="flex min-h-0">
				{/*
				 * Outside cmdk's item semantics but inside its root, so Enter here
				 * would also fire the highlighted row: the rail stops those keys
				 * from bubbling. Filtering by provider must never pick a model.
				 */}
				<fieldset
					className="no-scrollbar flex w-24 min-w-24 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-1"
					onKeyDown={(event) => {
						if (event.key === 'Enter' || event.key === ' ')
							event.stopPropagation();
					}}
				>
					<legend className="sr-only">{groupsLabel}</legend>
					<button
						type="button"
						aria-pressed={activeGroup === undefined}
						onClick={() => setGroup(undefined)}
						className="flex items-center justify-between gap-1 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted aria-pressed:bg-muted aria-pressed:font-medium max-sm:min-h-11"
					>
						<span className="min-w-0 truncate">All</span>
						<span className="shrink-0 text-muted-foreground tabular-nums">
							{total}
						</span>
					</button>
					{counts.map((entry) => (
						<button
							key={entry.group}
							type="button"
							disabled={entry.count === 0}
							aria-pressed={activeGroup === entry.group}
							onClick={() => setGroup(entry.group)}
							className="flex items-center justify-between gap-1 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-40 aria-pressed:bg-muted aria-pressed:font-medium max-sm:min-h-11"
						>
							<span className="min-w-0 truncate">{entry.group}</span>
							<span className="shrink-0 text-muted-foreground tabular-nums">
								{entry.count}
							</span>
						</button>
					))}
				</fieldset>

				<CommandList className="max-h-72 min-w-0 flex-1 overflow-y-auto overscroll-contain">
					{/* Ours, not `CommandEmpty`: with `shouldFilter={false}` cmdk
					    counts rows it never filtered, so its empty state and this
					    list would disagree about what is on screen. */}
					{visible.length === 0 && (
						<p className="py-6 text-center text-sm">No {noun} match.</p>
					)}
					{groupsShown.map((name) => (
						<CommandGroup key={name} heading={name}>
							{visible
								.filter((entity) => entity.group === name)
								.map((entity) => {
									const isForced = forced.includes(entity.id);
									const checked = isForced || selected.includes(entity.id);
									return (
										<CommandItem
											key={entity.id}
											value={entity.id}
											aria-checked={checked}
											data-checked={checked}
											data-forced={isForced || undefined}
											onSelect={() => {
												if (!isForced) onSelect(entity.id);
											}}
										>
											<span className="min-w-0 flex-1">
												<span className="flex min-w-0 items-center gap-1.5">
													<span className="min-w-0 truncate">
														{entity.label}
													</span>
													{entity.badges?.map((badge) => (
														<span
															key={badge.label}
															title={badge.label}
															className="shrink-0 text-muted-foreground"
														>
															<badge.icon
																className="size-3.5"
																aria-hidden={true}
															/>
															<span className="sr-only">{badge.label}</span>
														</span>
													))}
												</span>
												{entity.hint && (
													<span className="block truncate font-normal text-muted-foreground text-xs">
														{entity.hint}
													</span>
												)}
											</span>
											{isForced && forcedHint && (
												<span className="shrink-0 text-muted-foreground text-xs">
													{forcedHint}
												</span>
											)}
										</CommandItem>
									);
								})}
						</CommandGroup>
					))}
				</CommandList>
			</div>
		</Command>
	);
}
