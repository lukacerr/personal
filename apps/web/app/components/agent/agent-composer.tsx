import { AgentModelPicker } from '@web/components/agent/agent-model-picker';
import { AgentToolPicker } from '@web/components/agent/agent-tool-picker';
import { Button } from '@web/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Input } from '@web/components/ui/input';
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from '@web/components/ui/popover';
import { Spinner } from '@web/components/ui/spinner';
import { Textarea } from '@web/components/ui/textarea';
import {
	type AgentSelection,
	reasoningForModel,
	temperatureForModel,
} from '@web/lib/agent';
import type { AgentCatalog } from '@web/lib/agent-api';
import { AGENT_MAX_STEPS } from '@web/lib/agent-settings';
import {
	ArrowUpIcon,
	BrainIcon,
	ChevronDownIcon,
	SlidersHorizontalIcon,
	SquareIcon,
} from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

type ComposerStatus = 'ready' | 'submitted' | 'streaming' | 'error';

/** One row of the settings surface: what it sets on the left, the control on
 * the right. Every control carries its own accessible name, so the caption is a
 * heading for the eye and never a second label. */
function SettingRow({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-4">
			<p className="font-medium text-muted-foreground text-xs">{label}</p>
			{children}
		</div>
	);
}

/**
 * The one input of the screen. The bordered container is the field; the
 * textarea inside is transparent so the whole box reads as one control.
 *
 * Outside the field stay exactly two affordances: send/stop/pending, and the
 * single trigger that opens the turn's selection. Everything the next send
 * depends on — model, reasoning, tools, step budget, temperature — lives inside
 * that one surface. Kept inline, each of those is text whose length belongs to
 * a registry meant to grow, so the row wrapped into two or three lines the
 * moment a label got long; with two icon buttons its width is a constant.
 *
 * Model and tools are searchable pickers rather than plain menus: both lists
 * are registries meant to grow, and a flat menu of forty models is a scroll,
 * not a choice. Reasoning stays a menu — its levels are per-model and never
 * more than a handful, so a search field would be furniture.
 */
export function AgentComposer({
	value,
	status,
	busy: busyOverride,
	catalog,
	selection,
	error,
	onChange,
	onSelectionChange,
	onSubmit,
	onStop,
}: {
	value: string;
	status: ComposerStatus;
	/** Synchronous work before the chat SDK flips its own status. */
	busy?: boolean;
	catalog: AgentCatalog;
	selection: AgentSelection;
	/** A failure creating the thread; the text stays right here, unsent. */
	error?: string;
	onChange: (value: string) => void;
	onSelectionChange: (next: AgentSelection) => void;
	onSubmit: () => void;
	onStop: () => void;
}) {
	const inputId = useId();
	const maxStepsId = useId();
	const temperatureId = useId();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [reasoningOpen, setReasoningOpen] = useState(false);
	const [maxStepsText, setMaxStepsText] = useState(String(selection.maxSteps));
	const [temperatureText, setTemperatureText] = useState(
		selection.temperature === undefined ? '' : String(selection.temperature),
	);
	const busy =
		busyOverride ?? (status === 'submitted' || status === 'streaming');
	const canStop = status === 'submitted' || status === 'streaming';
	const model = catalog.models.find((entry) => entry.id === selection.model);
	const modelLabel = model?.label ?? 'Select model';

	useEffect(
		() => setMaxStepsText(String(selection.maxSteps)),
		[selection.maxSteps],
	);
	useEffect(
		() =>
			setTemperatureText(
				selection.temperature === undefined
					? ''
					: String(selection.temperature),
			),
		[selection.temperature],
	);

	/**
	 * The AI SDK lets a tool describe itself with a function, so the contract
	 * types the description as a union. The picker shows text: narrow with a
	 * guard here — at the boundary — rather than asserting it away.
	 */
	const toolOptions = useMemo(
		() =>
			catalog.tools.map((tool) => ({
				name: tool.name,
				description:
					typeof tool.description === 'string' ? tool.description : '',
			})),
		[catalog.tools],
	);

	function pickModel(id: string) {
		const next = catalog.models.find((entry) => entry.id === id);
		if (!next) return;
		// The level follows the model: a level both models accept survives the
		// switch, one the next model cannot express falls to its default, and a
		// model without a knob carries none at all.
		const reasoning = reasoningForModel(next, selection.reasoning);
		const temperature = temperatureForModel(
			next,
			reasoning,
			selection.temperature,
		);
		onSelectionChange({
			model: id,
			tools: selection.tools,
			maxSteps: selection.maxSteps,
			...(reasoning === undefined ? {} : { reasoning }),
			...(temperature === undefined ? {} : { temperature }),
		});
	}

	const temperatureCapability =
		model &&
		temperatureForModel(
			model,
			selection.reasoning,
			model.temperature?.default,
		) !== undefined
			? model.temperature
			: undefined;
	function toggleTool(name: string) {
		onSelectionChange({
			...selection,
			tools: selection.tools.includes(name)
				? selection.tools.filter((tool) => tool !== name)
				: [...selection.tools, name],
		});
	}

	/**
	 * One function, one layout: the ceiling `AGENT_MAX_STEPS` and the catalog's
	 * temperature bounds are enforced here and nowhere else, so a second surface
	 * — if one is ever needed — renders this rather than its own copy of the
	 * rules.
	 */
	const generationInputs = () => (
		<>
			<label
				htmlFor={maxStepsId}
				className="flex items-center justify-between gap-4"
			>
				<span className="font-medium text-muted-foreground text-xs">
					Maximum steps
				</span>
				<Input
					id={maxStepsId}
					type="number"
					min={1}
					max={AGENT_MAX_STEPS}
					step={1}
					value={maxStepsText}
					onChange={(event) => {
						const text = event.currentTarget.value;
						setMaxStepsText(text);
						const value = Number(text);
						/**
						 * `max` only decorates a typed number, so the ceiling the API
						 * enforces is checked here too: a larger budget would be a 422.
						 */
						if (
							!/^\d+$/.test(text) ||
							!Number.isInteger(value) ||
							value < 1 ||
							value > AGENT_MAX_STEPS
						)
							return;
						onSelectionChange({ ...selection, maxSteps: value });
					}}
					onBlur={() => setMaxStepsText(String(selection.maxSteps))}
					className="h-8 w-16 rounded-md px-1.5 text-center tabular-nums max-sm:h-11"
				/>
			</label>

			{temperatureCapability && (
				<label
					htmlFor={temperatureId}
					className="flex items-center justify-between gap-4"
				>
					<span className="font-medium text-muted-foreground text-xs">
						Temperature
					</span>
					<Input
						id={temperatureId}
						type="number"
						min={temperatureCapability.min}
						max={temperatureCapability.max}
						step={temperatureCapability.step}
						placeholder="Default"
						value={temperatureText}
						onChange={(event) => {
							const text = event.currentTarget.value;
							setTemperatureText(text);
							const next = { ...selection };
							delete next.temperature;
							if (text === '') {
								onSelectionChange(next);
								return;
							}
							const value = Number(text);
							const steps =
								(value - temperatureCapability.min) /
								temperatureCapability.step;
							if (
								!Number.isFinite(value) ||
								value < temperatureCapability.min ||
								value > temperatureCapability.max ||
								Math.abs(steps - Math.round(steps)) > 1e-9
							)
								return;
							onSelectionChange({ ...next, temperature: value });
						}}
						onBlur={() =>
							setTemperatureText(
								selection.temperature === undefined
									? ''
									: String(selection.temperature),
							)
						}
						className="h-8 w-20 rounded-md px-1.5 text-center tabular-nums max-sm:h-11"
					/>
				</label>
			)}
		</>
	);

	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit();
			}}
		>
			<div className="flex flex-col rounded-2xl border bg-background shadow-xs focus-within:ring-1 focus-within:ring-ring">
				<label htmlFor={inputId} className="sr-only">
					Message the agent
				</label>
				<Textarea
					id={inputId}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					onKeyDown={(event) => {
						if (
							event.key === 'Enter' &&
							!event.shiftKey &&
							!event.nativeEvent.isComposing
						) {
							event.preventDefault();
							onSubmit();
						}
					}}
					placeholder="Message the agent…"
					className="field-sizing-content max-h-52 min-h-12 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
				/>

				<div className="flex min-w-0 items-center gap-1 px-2 pb-2">
					{/*
					 * One surface at every width. A popover on desktop plus a sheet on
					 * mobile would be two open states for one control, and the shell
					 * already paid for that once: a breakpoint change between them
					 * leaves a backdrop on screen. The trigger is icon-only and names
					 * the active model in its accessible name — a visible label is the
					 * unbounded text this row was collapsed to get rid of.
					 */}
					<Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
						<PopoverTrigger
							render={
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="text-muted-foreground max-sm:size-11"
									aria-label={`Generation settings: ${modelLabel}`}
								/>
							}
						>
							<SlidersHorizontalIcon aria-hidden="true" />
						</PopoverTrigger>
						<PopoverContent align="start" side="top">
							<PopoverHeader>
								<PopoverTitle>Generation settings</PopoverTitle>
								<PopoverDescription>
									Applies to the next message, not to the thread.
								</PopoverDescription>
							</PopoverHeader>

							<div className="grid gap-3">
								<SettingRow label="Model">
									<AgentModelPicker
										models={catalog.models}
										value={selection.model}
										onSelect={pickModel}
									/>
								</SettingRow>

								{model && model.reasoning.levels.length > 0 && (
									<SettingRow label="Reasoning">
										<DropdownMenu
											open={reasoningOpen}
											onOpenChange={setReasoningOpen}
										>
											<DropdownMenuTrigger
												render={
													<Button
														type="button"
														variant="ghost"
														size="sm"
														className="gap-1 text-muted-foreground hover:text-foreground max-sm:h-11"
														aria-label="Reasoning level"
													/>
												}
											>
												<BrainIcon aria-hidden="true" />
												<span className="capitalize">
													{selection.reasoning}
												</span>
												<ChevronDownIcon aria-hidden="true" />
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												<DropdownMenuRadioGroup
													value={selection.reasoning}
													onValueChange={(level) => {
														const reasoning = String(level);
														const temperature = temperatureForModel(
															model,
															reasoning,
															selection.temperature,
														);
														const next = { ...selection };
														delete next.temperature;
														onSelectionChange({
															...next,
															reasoning,
															...(temperature === undefined
																? {}
																: { temperature }),
														});
														setReasoningOpen(false);
													}}
												>
													{/* A Base UI group label has to sit inside a group. */}
													<DropdownMenuLabel>Reasoning</DropdownMenuLabel>
													{model.reasoning.levels.map((level) => (
														<DropdownMenuRadioItem key={level} value={level}>
															<span className="capitalize">{level}</span>
														</DropdownMenuRadioItem>
													))}
												</DropdownMenuRadioGroup>
											</DropdownMenuContent>
										</DropdownMenu>
									</SettingRow>
								)}

								{toolOptions.length > 0 && (
									<SettingRow label="Tools">
										<AgentToolPicker
											tools={toolOptions}
											value={selection.tools}
											onToggle={toggleTool}
										/>
									</SettingRow>
								)}

								{generationInputs()}
							</div>
						</PopoverContent>
					</Popover>

					<div className="min-w-2 flex-1" />

					{canStop ? (
						<Button
							type="button"
							size="icon"
							variant="outline"
							className="max-sm:size-11"
							onClick={onStop}
							aria-label="Stop generating"
						>
							<SquareIcon aria-hidden="true" />
						</Button>
					) : busy ? (
						<Button
							type="button"
							size="icon"
							variant="outline"
							className="max-sm:size-11"
							disabled
							aria-label="Preparing message"
						>
							<Spinner />
						</Button>
					) : (
						<Button
							type="submit"
							size="icon"
							className="max-sm:size-11"
							disabled={value.trim().length === 0}
							aria-label="Send message"
						>
							<ArrowUpIcon aria-hidden="true" />
						</Button>
					)}
				</div>
			</div>

			{error && <p className="px-1 text-destructive text-sm">{error}</p>}
		</form>
	);
}
