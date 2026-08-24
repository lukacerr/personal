import {
	type AgentModelOption,
	AgentModelPicker,
} from '@web/components/agent/agent-model-picker';
import { Button } from '@web/components/ui/button';
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from '@web/components/ui/popover';
import type { AgentSettings } from '@web/lib/agent-api';
import type {
	AgentPreferenceSize,
	AgentPreferences,
} from '@web/lib/agent-preferences';
import { Settings2Icon } from 'lucide-react';
import { useId } from 'react';

const preferenceSizes: AgentPreferenceSize[] = ['small', 'medium', 'large'];

/**
 * A single-choice control, so it is a radio group rather than a set of toggle
 * buttons: assistive technology announces the position within the choice and
 * arrow keys move between options. Same shape as the Notes control, because the
 * two preference popovers should not read differently.
 */
function AgentPreferenceGroup({
	label,
	value,
	onChange,
}: {
	label: string;
	value: AgentPreferenceSize;
	onChange: (value: AgentPreferenceSize) => void;
}) {
	const labelId = useId();

	return (
		<div className="grid gap-2">
			<p className="text-xs font-medium text-muted-foreground" id={labelId}>
				{label}
			</p>
			<div
				role="radiogroup"
				aria-labelledby={labelId}
				className="grid w-full grid-cols-3 gap-1"
			>
				{preferenceSizes.map((size) => (
					<Button
						key={size}
						type="button"
						role="radio"
						aria-checked={value === size}
						variant={value === size ? 'secondary' : 'ghost'}
						size="sm"
						className="capitalize max-sm:h-11"
						onClick={() => onChange(size)}
					>
						{size}
					</Button>
				))}
			</div>
		</div>
	);
}

/** One labelled server-side model choice inside the popover. */
function AgentSettingsModelRow({
	label,
	hint,
	models,
	value,
	onSelect,
}: {
	label: string;
	hint: string;
	models: readonly AgentModelOption[];
	value?: string;
	onSelect: (id: string) => void;
}) {
	const labelId = useId();
	return (
		<div className="grid gap-2">
			<div className="grid gap-0.5">
				<p className="font-medium text-muted-foreground text-xs" id={labelId}>
					{label}
				</p>
				<p className="text-muted-foreground/70 text-xs">{hint}</p>
			</div>
			<AgentModelPicker
				models={models}
				value={value ?? ''}
				onSelect={onSelect}
			/>
		</div>
	);
}

export function AgentPreferencesControl({
	preferences,
	setPreference,
	models,
	settings,
	onSettingsChange,
}: {
	preferences: AgentPreferences;
	setPreference: (
		key: keyof AgentPreferences,
		value: AgentPreferenceSize,
	) => void;
	/** The catalog's models, for the two server-side choices below. */
	models: readonly AgentModelOption[];
	/**
	 * All shared Agent choices; `undefined` only while reconciliation loads.
	 */
	settings: AgentSettings | undefined;
	/**
	 * A patch, not the whole object: the store merges it over what the server
	 * actually holds, so picking one model can never wipe the other choice.
	 */
	onSettingsChange: (patch: Partial<AgentSettings>) => void;
}) {
	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						type="button"
						size="icon-sm"
						variant="ghost"
						aria-label="View preferences"
						className="text-muted-foreground max-sm:size-11"
					/>
				}
			>
				<Settings2Icon aria-hidden="true" />
			</PopoverTrigger>
			<PopoverContent side="top" align="end">
				<PopoverHeader>
					<PopoverTitle>View preferences</PopoverTitle>
					<PopoverDescription>Saved only on this device.</PopoverDescription>
				</PopoverHeader>
				<AgentPreferenceGroup
					label="Font size"
					value={preferences.fontSize}
					onChange={(value) => setPreference('fontSize', value)}
				/>
				<AgentPreferenceGroup
					label="Margins"
					value={preferences.margins}
					onChange={(value) => setPreference('margins', value)}
				/>

				{/*
				 * Unlike the view knobs above, these two travel to the server: they
				 * pick which model names new threads and which one compacts long
				 * ones, and every device shares that choice.
				 */}
				<div className="mt-1 border-t pt-3">
					<div className="grid gap-3">
						<AgentSettingsModelRow
							label="Title model"
							hint="Names new conversations. Saved for every device."
							models={models}
							value={settings?.titleModel}
							onSelect={(id) => onSettingsChange({ titleModel: id })}
						/>
						<AgentSettingsModelRow
							label="Compaction model"
							hint="Writes the context summary when you compact."
							models={models}
							value={settings?.compactionModel}
							onSelect={(id) => onSettingsChange({ compactionModel: id })}
						/>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
