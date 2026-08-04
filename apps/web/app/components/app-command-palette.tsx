import { Button } from '@web/components/ui/button';
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandShortcut,
} from '@web/components/ui/command';
import { Kbd, KbdGroup } from '@web/components/ui/kbd';
import { Separator } from '@web/components/ui/separator';
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from '@web/components/ui/tooltip';
import { appNavigation } from '@web/lib/app-navigation';
import { isCommandPaletteShortcut } from '@web/lib/command-palette';
import { SearchIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

export function AppCommandPalette() {
	const [open, setOpen] = useState(false);
	const [tooltipOpen, setTooltipOpen] = useState(false);
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const previousFocus = useRef<HTMLElement | null>(null);

	const openPalette = () => {
		previousFocus.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		setTooltipOpen(false);
		setOpen(true);
	};

	const closePalette = () => {
		setOpen(false);
		requestAnimationFrame(() => previousFocus.current?.focus());
	};

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (!isCommandPaletteShortcut(event)) return;
			event.preventDefault();
			if (open) closePalette();
			else openPalette();
		};

		document.addEventListener('keydown', handleKeyDown, true);
		return () => document.removeEventListener('keydown', handleKeyDown, true);
	}, [open]);

	const selectPath = (path: string) => {
		closePalette();
		if (path !== pathname) void navigate(path);
	};

	return (
		<>
			<Tooltip
				open={tooltipOpen && !open}
				onOpenChange={setTooltipOpen}
			>
				<TooltipTrigger
					render={
						<Button
							variant="outline"
							size="icon-lg"
							aria-label="Open command palette"
							aria-keyshortcuts="Control+Space Control+Shift+Space"
							onClick={openPalette}
							className="rounded-lg sm:w-auto sm:gap-2.5 sm:px-3"
						/>
					}
				>
					<SearchIcon data-icon="inline-start" aria-hidden="true" />
					<span className="hidden sm:inline">Commands</span>
					<KbdGroup className="hidden gap-1.5 lg:inline-flex" aria-hidden="true">
						<Kbd>Ctrl</Kbd>
						<span className="font-mono text-xs text-muted-foreground">+</span>
						<Kbd>Space</Kbd>
					</KbdGroup>
				</TooltipTrigger>
				{!open && (
					<TooltipContent side="bottom">
						Open command palette · Ctrl+Shift+Space in Vivaldi
					</TooltipContent>
				)}
			</Tooltip>

			<CommandDialog
				open={open}
				onOpenChange={(nextOpen) => {
					if (nextOpen) openPalette();
					else closePalette();
				}}
				title="Command palette"
				description="Search for a solution to open."
				showCloseButton
			>
				<Command className="rounded-none p-0">
					<CommandInput
						placeholder="Find a solution or command..."
						className="h-12 pr-10 text-base"
					/>
					<CommandList className="max-h-[50svh] min-h-56">
						<CommandEmpty>No solutions found.</CommandEmpty>
						<CommandGroup heading="Go to">
							{appNavigation.map(({ description, icon: Icon, label, path }) => (
								<CommandItem
									key={path}
									value={`${label} ${description}`}
									onSelect={() => selectPath(path)}
								>
									<Icon aria-hidden="true" />
									<span>{label}</span>
									{pathname === path && (
										<CommandShortcut>Current</CommandShortcut>
									)}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
					<Separator />
					<div className="flex min-h-12 flex-wrap items-center justify-center gap-x-5 gap-y-2 px-4 py-2 text-xs text-muted-foreground">
						<span className="flex items-center gap-1.5">
							<Kbd>↑</Kbd>
							<Kbd>↓</Kbd>
							<span>navigate</span>
						</span>
						<span className="flex items-center gap-1.5">
							<Kbd>Enter</Kbd>
							<span>open</span>
						</span>
						<span className="flex items-center gap-1.5">
							<Kbd>Esc</Kbd>
							<span>dismiss</span>
						</span>
						<span className="hidden items-center gap-1.5 sm:flex">
							<KbdGroup className="gap-1.5">
								<Kbd>Ctrl</Kbd>
								<span className="font-mono">+</span>
								<Kbd>Shift</Kbd>
								<span className="font-mono">+</span>
								<Kbd>Space</Kbd>
							</KbdGroup>
							<span>Vivaldi</span>
						</span>
					</div>
				</Command>
			</CommandDialog>
		</>
	);
}
