import { Button } from '@web/components/ui/button';
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from '@web/components/ui/command';
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from '@web/components/ui/popover';
import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';

export type AgentModelOption = {
	id: string;
	provider: string;
	label: string;
	reasoning: { levels: readonly string[]; default?: string };
};

/**
 * Only the providers this app talks to today. Anything else is title-cased
 * rather than left raw, so a catalogue that grows a provider still reads as a
 * heading instead of as an identifier.
 */
const providerHeadings: Record<string, string> = {
	anthropic: 'Anthropic',
	google: 'Google AI Studio',
	openai: 'OpenAI',
	novita: 'Novita',
};

function providerHeading(provider: string) {
	return (
		providerHeadings[provider] ??
		(provider.charAt(0).toUpperCase() + provider.slice(1) || 'Other')
	);
}

/**
 * Grouped in the order the catalogue lists them, not alphabetically: the server
 * already orders the models it prefers first, and re-sorting here would hide
 * that intent behind provider names.
 */
function groupByProvider(models: readonly AgentModelOption[]) {
	const groups: {
		provider: string;
		heading: string;
		models: AgentModelOption[];
	}[] = [];
	for (const model of models) {
		const group = groups.find((entry) => entry.provider === model.provider);
		if (group) group.models.push(model);
		else
			groups.push({
				provider: model.provider,
				heading: providerHeading(model.provider),
				models: [model],
			});
	}
	return groups;
}

export function AgentModelPicker({
	models,
	value,
	onSelect,
	disabled,
}: {
	models: readonly AgentModelOption[];
	value: string;
	onSelect: (id: string) => void;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const active = models.find((model) => model.id === value);
	const activeLabel = active?.label ?? 'Select model';
	const groups = groupByProvider(models);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={disabled}
						// The name has to carry the current model: the label is the value
						// here, and a bare "Model" would announce the control without ever
						// announcing what it is set to.
						aria-label={`Model: ${activeLabel}`}
						className="max-w-44 justify-between text-muted-foreground max-sm:h-11 sm:max-w-56"
					/>
				}
			>
				<span className="min-w-0 truncate">{activeLabel}</span>
				<ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
			</PopoverTrigger>
			<PopoverContent
				align="start"
				side="top"
				className="w-72 gap-0 overflow-hidden p-0"
			>
				{/* cmdk filters: this is a handful of rows already in memory, so the
				    match is cheaper than a round trip to the registry. The two arbitrary
				    variants undo chrome the vendored input carries for the command
				    dialog — room for its close button, and a 56px row. */}
				<Command
					loop
					className="rounded-none bg-transparent p-0 [&_[data-slot=command-input-wrapper]]:pr-0 [&_[data-slot=input-group]]:h-11"
				>
					<CommandInput placeholder="Search models…" />
					<CommandList className="max-h-64 overflow-y-auto overscroll-contain">
						<CommandEmpty>No models match.</CommandEmpty>
						{groups.map((group) => (
							<CommandGroup key={group.provider} heading={group.heading}>
								{group.models.map((model) => (
									<CommandItem
										key={model.id}
										// Both, so typing the identifier or the display name finds it.
										value={`${model.id} ${model.label}`}
										aria-checked={model.id === value}
										data-checked={model.id === value}
										onSelect={() => {
											onSelect(model.id);
											setOpen(false);
										}}
									>
										<span className="min-w-0 flex-1 truncate">
											{model.label}
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
