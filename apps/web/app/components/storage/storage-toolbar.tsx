import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@web/components/ui/collapsible';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from '@web/components/ui/input-group';
import { Spinner } from '@web/components/ui/spinner';
import { Toggle } from '@web/components/ui/toggle';
import { formatBytes, type StorageView } from '@web/lib/storage';
import {
	ArrowDownAZIcon,
	ChevronDownIcon,
	FilterIcon,
	HardDriveIcon,
	MoreHorizontalIcon,
	RefreshCwIcon,
	SearchIcon,
	UploadIcon,
	XIcon,
} from 'lucide-react';
import { useState } from 'react';

const sortLabels: Record<StorageView['sort'], string> = {
	'name-asc': 'Title A–Z',
	'name-desc': 'Title Z–A',
	'path-asc': 'Path A–Z',
	newest: 'Newest uploaded',
	oldest: 'Oldest uploaded',
	'size-desc': 'Largest',
	'size-asc': 'Smallest',
};

const uploadedOptions = [
	['any', 'Any time'],
	['today', 'Today'],
	['7d', 'Last 7 days'],
	['30d', 'Last 30 days'],
	['1y', 'Last year'],
] as const;

const visibilityOptions = [
	['all', 'All'],
	['public', 'Public'],
	['private', 'Private'],
] as const;

export function StorageToolbar({
	view,
	types,
	visibleCount,
	visibleSize,
	resultMode,
	refreshing,
	busy,
	onQueryChange,
	onTypesChange,
	onVisibilityChange,
	onUploadedChange,
	onSortChange,
	onClearFilters,
	onRefresh,
	onReconcile,
	onUpload,
}: {
	view: StorageView;
	/** Every type present, as labels; the view holds them lowercased. */
	types: string[];
	visibleCount: number;
	visibleSize: number;
	resultMode: boolean;
	refreshing: boolean;
	busy: boolean;
	onQueryChange: (query: string) => void;
	onTypesChange: (types: string[]) => void;
	onVisibilityChange: (visibility: StorageView['visibility']) => void;
	onUploadedChange: (uploaded: StorageView['uploaded']) => void;
	onSortChange: (sort: StorageView['sort']) => void;
	onClearFilters: () => void;
	onRefresh: () => void;
	onReconcile: () => void;
	onUpload: () => void;
}) {
	const [filtersOpen, setFiltersOpen] = useState(false);
	const activeFilters =
		view.types.length +
		Number(view.visibility !== 'all') +
		Number(view.uploaded !== 'any');

	const toggleType = (label: string) => {
		const value = label.toLocaleLowerCase();
		onTypesChange(
			view.types.includes(value)
				? view.types.filter((current) => current !== value)
				: [...view.types, value].sort((a, b) => a.localeCompare(b)),
		);
	};
	const labelFor = (value: string) =>
		types.find((label) => label.toLocaleLowerCase() === value) ?? value;

	return (
		// The filters sit in the page rather than behind an overlay: they describe
		// what is on screen, so hiding the screen to change them is backwards.
		<Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
			<header className="flex flex-col gap-3">
				<div className="flex items-center gap-2 md:hidden">
					<div className="min-w-0 flex-1">
						<p className="font-heading font-semibold">Storage</p>
						<p className="truncate text-muted-foreground text-xs">
							{visibleCount} {visibleCount === 1 ? 'file' : 'files'} ·{' '}
							{formatBytes(visibleSize)}
						</p>
					</div>
					<Button
						size="icon"
						variant="outline"
						onClick={onRefresh}
						disabled={refreshing}
						aria-label="Refresh files from server"
					>
						{refreshing ? <Spinner /> : <RefreshCwIcon />}
					</Button>
					<Button onClick={onUpload}>
						<UploadIcon data-icon="inline-start" />
						Upload
					</Button>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					{/* Narrow enough that the row still fits a 360 px phone whole: at
					    `min-w-48` the overflow menu wrapped onto a line of its own. */}
					<InputGroup className="min-w-40 flex-1 md:max-w-xl">
						<InputGroupAddon>
							<SearchIcon aria-hidden="true" />
						</InputGroupAddon>
						<InputGroupInput
							value={view.query}
							placeholder="Search title or path…"
							aria-label="Search files by title or path"
							onChange={(event) => onQueryChange(event.target.value)}
						/>
						{view.query ? (
							<InputGroupAddon align="inline-end">
								<InputGroupButton
									size="icon-xs"
									aria-label="Clear search"
									onClick={() => onQueryChange('')}
								>
									<XIcon />
								</InputGroupButton>
							</InputGroupAddon>
						) : null}
					</InputGroup>

					<CollapsibleTrigger render={<Button variant="outline" />}>
						<FilterIcon data-icon="inline-start" />
						<span className="hidden sm:inline">Filters</span>
						{activeFilters > 0 ? (
							<Badge variant="secondary">{activeFilters}</Badge>
						) : null}
						<ChevronDownIcon
							data-icon="inline-end"
							aria-hidden="true"
							className={
								filtersOpen
									? 'rotate-180 transition-transform'
									: 'transition-transform'
							}
						/>
					</CollapsibleTrigger>

					<DropdownMenu>
						<DropdownMenuTrigger render={<Button variant="outline" />}>
							<ArrowDownAZIcon data-icon="inline-start" />
							<span className="hidden sm:inline">{sortLabels[view.sort]}</span>
							<span className="sr-only sm:hidden">Sort files</span>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-56">
							<DropdownMenuGroup>
								<DropdownMenuLabel>Sort files</DropdownMenuLabel>
								<DropdownMenuRadioGroup
									value={view.sort}
									onValueChange={(value) =>
										onSortChange(value as StorageView['sort'])
									}
								>
									{Object.entries(sortLabels).map(([value, label]) => (
										<DropdownMenuRadioItem key={value} value={value}>
											{label}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>

					<Button
						variant="ghost"
						className="hidden md:inline-flex"
						onClick={onRefresh}
						disabled={refreshing}
						aria-busy={refreshing}
						aria-label="Refresh files"
					>
						{refreshing ? <Spinner /> : <RefreshCwIcon />}
						<span className="hidden lg:inline">Refresh</span>
					</Button>

					<div className="ml-auto hidden items-center gap-2 md:flex">
						<Button onClick={onUpload}>
							<UploadIcon data-icon="inline-start" />
							Upload
						</Button>
					</div>

					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									size="icon"
									variant="ghost"
									aria-label="More storage actions"
								/>
							}
						>
							<MoreHorizontalIcon />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={onReconcile} disabled={busy}>
								<HardDriveIcon />
								Reconcile storage
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>

				<CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-150 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
					<div className="grid gap-6 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
						<fieldset className="min-w-0">
							<legend className="mb-2 font-medium text-sm">File type</legend>
							{types.length > 0 ? (
								<div className="flex flex-wrap gap-2">
									{types.map((label) => (
										<Toggle
											key={label}
											size="sm"
											variant="outline"
											pressed={view.types.includes(label.toLocaleLowerCase())}
											onPressedChange={() => toggleType(label)}
										>
											{label}
										</Toggle>
									))}
								</div>
							) : (
								<p className="text-muted-foreground text-sm">
									No file types yet.
								</p>
							)}
						</fieldset>

						<fieldset>
							<legend className="mb-2 font-medium text-sm">Visibility</legend>
							<div className="flex flex-wrap gap-2">
								{visibilityOptions.map(([value, label]) => (
									<Toggle
										key={value}
										size="sm"
										variant="outline"
										pressed={view.visibility === value}
										onPressedChange={() => onVisibilityChange(value)}
									>
										{label}
									</Toggle>
								))}
							</div>
						</fieldset>

						<fieldset>
							<legend className="mb-2 font-medium text-sm">Uploaded</legend>
							<div className="flex flex-wrap gap-2">
								{uploadedOptions.map(([value, label]) => (
									<Toggle
										key={value}
										size="sm"
										variant="outline"
										pressed={view.uploaded === value}
										onPressedChange={() => onUploadedChange(value)}
									>
										{label}
									</Toggle>
								))}
							</div>
						</fieldset>
					</div>
				</CollapsibleContent>

				<div className="hidden min-h-6 flex-wrap items-center gap-2 text-muted-foreground text-xs md:flex">
					<p aria-live="polite">
						{visibleCount} {visibleCount === 1 ? 'file' : 'files'} ·{' '}
						{formatBytes(visibleSize)}
						{resultMode ? ' in results' : ''}
					</p>
					{view.types.map((type) => (
						<Badge key={type} variant="secondary">
							{labelFor(type)}
						</Badge>
					))}
					{view.visibility !== 'all' ? (
						<Badge variant="secondary">{view.visibility}</Badge>
					) : null}
					{view.uploaded !== 'any' ? (
						<Badge variant="secondary">
							{uploadedOptions.find(([value]) => value === view.uploaded)?.[1]}
						</Badge>
					) : null}
					{activeFilters > 0 ? (
						<Button size="xs" variant="ghost" onClick={onClearFilters}>
							Clear all
						</Button>
					) : null}
				</div>
			</header>
		</Collapsible>
	);
}
