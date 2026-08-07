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
import { loadSystemCommands } from '@web/lib/app-systems';
import {
	consumeCommandPaletteHistory,
	isCommandPaletteHistoryEntry,
	isCommandPaletteShortcut,
	pushCommandPaletteHistory,
	shouldRestorePaletteFocus,
} from '@web/lib/command-palette';
import { useLiveQuery } from 'dexie-react-hooks';
import { SearchIcon } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

export function AppCommandPalette() {
	const [open, setOpen] = useState(false);
	const [tooltipOpen, setTooltipOpen] = useState(false);
	const location = useLocation();
	const { pathname } = location;
	const navigate = useNavigate();
	const previousFocus = useRef<HTMLElement | null>(null);
	const consumingHistory = useRef(false);
	const systemGroups = useLiveQuery(loadSystemCommands, [], []);

	const openPalette = () => {
		consumingHistory.current = false;
		pushCommandPaletteHistory(
			window.history,
			`${location.pathname}${location.search}${location.hash}`,
		);
		previousFocus.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		setTooltipOpen(false);
		setOpen(true);
	};

	const closePalette = (reason: 'dismiss' | 'navigate' = 'dismiss') => {
		setOpen(false);
		if (reason === 'dismiss' && !consumingHistory.current) {
			consumingHistory.current = consumeCommandPaletteHistory(window.history);
		}
		if (shouldRestorePaletteFocus(reason))
			requestAnimationFrame(() => previousFocus.current?.focus());
	};

	const togglePalette = useEffectEvent(() => {
		if (open) closePalette();
		else openPalette();
	});

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (!isCommandPaletteShortcut(event)) return;
			event.preventDefault();
			togglePalette();
		};

		document.addEventListener('keydown', handleKeyDown, true);
		return () => document.removeEventListener('keydown', handleKeyDown, true);
	}, []);

	useEffect(() => {
		if (!open) return;
		const handlePopState = (event: PopStateEvent) => {
			if (isCommandPaletteHistoryEntry(event.state)) return;
			consumingHistory.current = false;
			setOpen(false);
			requestAnimationFrame(() => previousFocus.current?.focus());
		};
		window.addEventListener('popstate', handlePopState);
		return () => window.removeEventListener('popstate', handlePopState);
	}, [open]);

	const selectPath = (path: string) => {
		const currentPath = `${location.pathname}${location.search}${location.hash}`;
		if (path === currentPath) {
			closePalette();
			return;
		}
		const replace = isCommandPaletteHistoryEntry(window.history.state);
		closePalette('navigate');
		void navigate(path, { replace });
	};

	return (
		<>
			<Tooltip open={tooltipOpen && !open} onOpenChange={setTooltipOpen}>
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
					<KbdGroup
						className="hidden gap-1.5 lg:inline-flex"
						aria-hidden="true"
					>
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
				description="Search for a solution, note, or command."
				showCloseButton
			>
				<Command className="rounded-none p-0">
					<CommandInput
						placeholder="Find a solution, note, or command..."
						className="h-12 pr-10 text-base"
					/>
					<CommandList className="max-h-[50svh] min-h-56">
						<CommandEmpty>No matching results.</CommandEmpty>
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
						{systemGroups.map(({ system, commands }) =>
							commands.length === 0 ? null : (
								<CommandGroup key={system.key} heading={system.heading}>
									{commands.map((command) => {
										const Icon = system.icon;
										return (
											<CommandItem
												key={`${system.key}:${command.id}`}
												value={`${command.label} ${command.detail ?? ''}`}
												onSelect={() => selectPath(command.to)}
											>
												{Icon && <Icon aria-hidden="true" />}
												<span className="min-w-0 flex-1 truncate">
													{command.label}
												</span>
												{command.detail && (
													<CommandShortcut className="max-w-48 truncate">
														{command.detail}
													</CommandShortcut>
												)}
											</CommandItem>
										);
									})}
								</CommandGroup>
							),
						)}
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
