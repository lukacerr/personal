import { Button } from '@web/components/ui/button';
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from '@web/components/ui/popover';
import type {
	NotesPreferenceSize,
	NotesPreferences,
} from '@web/lib/notes-preferences';
import { Settings2Icon } from 'lucide-react';

const preferenceSizes: NotesPreferenceSize[] = ['small', 'medium', 'large'];

/**
 * A single-choice control, so it is a radio group rather than a set of toggle
 * buttons: assistive technology announces the position within the choice and
 * arrow keys move between options.
 */
function NotesPreferenceGroup({
	label,
	value,
	onChange,
}: {
	label: string;
	value: NotesPreferenceSize;
	onChange: (value: NotesPreferenceSize) => void;
}) {
	return (
		<div className="grid gap-2">
			<p
				className="text-xs font-medium text-muted-foreground"
				id={`${label}-label`}
			>
				{label}
			</p>
			<div
				role="radiogroup"
				aria-labelledby={`${label}-label`}
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
						className="capitalize"
						onClick={() => onChange(size)}
					>
						{size}
					</Button>
				))}
			</div>
		</div>
	);
}

export function NotesPreferencesControl({
	preferences,
	setPreference,
}: {
	preferences: NotesPreferences;
	setPreference: (
		key: keyof NotesPreferences,
		value: NotesPreferenceSize,
	) => void;
}) {
	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						size="sm"
						variant="ghost"
						className="w-full justify-start text-muted-foreground"
					/>
				}
			>
				<Settings2Icon />
				Editor preferences
			</PopoverTrigger>
			<PopoverContent side="top" align="start">
				<PopoverHeader>
					<PopoverTitle>Editor preferences</PopoverTitle>
					<PopoverDescription>Saved only on this device.</PopoverDescription>
				</PopoverHeader>
				<NotesPreferenceGroup
					label="Font size"
					value={preferences.fontSize}
					onChange={(value) => setPreference('fontSize', value)}
				/>
				<NotesPreferenceGroup
					label="Horizontal margins"
					value={preferences.margins}
					onChange={(value) => setPreference('margins', value)}
				/>
			</PopoverContent>
		</Popover>
	);
}
