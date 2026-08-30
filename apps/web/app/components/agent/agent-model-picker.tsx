import {
	AgentEntityPicker,
	type PickerEntity,
} from '@web/components/agent/agent-entity-picker';
import { Button } from '@web/components/ui/button';
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from '@web/components/ui/popover';
import { ChevronDownIcon, EyeIcon } from 'lucide-react';
import { useState } from 'react';

export type AgentModelOption = {
	id: string;
	provider: string;
	label: string;
	attachments: { image: boolean; pdf: boolean };
	reasoning: { levels: readonly string[]; default?: string };
};

/**
 * Only the providers this app talks to today. Anything else is title-cased
 * rather than left raw, so a catalogue that grows a provider still reads as a
 * heading instead of as an identifier.
 */
const providerHeadings: Record<string, string> = {
	anthropic: 'Anthropic',
	google: 'Google',
	openai: 'OpenAI',
	novita: 'Novita',
};

export function providerHeading(provider: string) {
	return (
		providerHeadings[provider] ??
		(provider.charAt(0).toUpperCase() + provider.slice(1) || 'Other')
	);
}

/**
 * What a model can be *shown*, spelled out: the two flags are independent —
 * Novita's multimodal models take images but not PDFs — so the badge names
 * exactly what arrives as bytes. A model without it still reads a mentioned
 * file, it just receives the text placeholder instead. Nothing else the
 * catalogue knows — reasoning levels, a temperature knob — changes what the
 * model can be asked, so it stays out of a row meant to be scanned.
 */
export function attachmentBadge(attachments: AgentModelOption['attachments']) {
	if (attachments.image && attachments.pdf) return 'Reads images and PDFs';
	if (attachments.image) return 'Reads images';
	if (attachments.pdf) return 'Reads PDFs';
	return undefined;
}

export function modelEntity(model: AgentModelOption): PickerEntity {
	const badge = attachmentBadge(model.attachments);
	return {
		id: model.id,
		label: model.label,
		group: providerHeading(model.provider),
		...(badge ? { badges: [{ icon: EyeIcon, label: badge }] } : {}),
	};
}

export function AgentModelPicker({
	models,
	value,
	onSelect,
}: {
	models: readonly AgentModelOption[];
	value: string;
	onSelect: (id: string) => void;
}) {
	return (
		<AgentEntityPicker
			entities={models.map(modelEntity)}
			selected={[value]}
			noun="models"
			groupsLabel="Providers"
			onSelect={onSelect}
		/>
	);
}

/**
 * The same picker behind a trigger, for the surfaces that pick a model as one
 * setting among several — the preferences popover holds two of these. The
 * composer embeds the picker directly instead: there the model *is* the
 * surface, and a trigger inside a popover would be a second click to nowhere.
 */
export function AgentModelPickerPopover({
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
				className="w-[min(92vw,26rem)] gap-0 overflow-hidden p-0"
			>
				<AgentModelPicker
					models={models}
					value={value}
					onSelect={(id) => {
						onSelect(id);
						setOpen(false);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}
