import { Button } from '@web/components/ui/button';
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from '@web/components/ui/command';
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from '@web/components/ui/popover';
import { WrenchIcon } from 'lucide-react';
import { useState } from 'react';

export type AgentToolOption = { name: string; description: string };

export function AgentToolPicker({
	tools,
	value,
	onToggle,
}: {
	tools: readonly AgentToolOption[];
	value: readonly string[];
	onToggle: (name: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const enabled = value.length;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="sm"
						aria-label="Tools for this conversation"
						className="text-muted-foreground max-sm:h-11"
					/>
				}
			>
				<WrenchIcon data-icon="inline-start" aria-hidden="true" />
				{enabled > 0 && <span className="tabular-nums">{enabled}</span>}
			</PopoverTrigger>
			<PopoverContent
				align="start"
				side="top"
				className="w-72 gap-0 overflow-hidden p-0"
			>
				{/* Multi-select, so selecting never closes the popup. cmdk marks the
				    highlighted row with `aria-selected`, which is why the enabled state
				    is `aria-checked` on the same `role="option"` instead. */}
				<Command
					loop
					className="rounded-none bg-transparent p-0 [&_[data-slot=command-input-wrapper]]:pr-0 [&_[data-slot=input-group]]:h-11"
				>
					<CommandInput placeholder="Search tools…" />
					<CommandList className="max-h-64 overflow-y-auto overscroll-contain">
						<CommandEmpty>No tools match.</CommandEmpty>
						{tools.map((tool) => {
							const checked = value.includes(tool.name);
							return (
								<CommandItem
									key={tool.name}
									value={`${tool.name} ${tool.description}`}
									aria-checked={checked}
									data-checked={checked}
									onSelect={() => onToggle(tool.name)}
								>
									<span className="min-w-0 flex-1">
										<span className="block truncate">{tool.name}</span>
										<span className="block truncate text-xs font-normal text-muted-foreground">
											{tool.description}
										</span>
									</span>
								</CommandItem>
							);
						})}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
