import {
	BotIcon,
	CalendarDaysIcon,
	ChartNoAxesCombinedIcon,
	FolderOpenIcon,
	HouseIcon,
	KeyRoundIcon,
	type LucideIcon,
	NotebookPenIcon,
} from 'lucide-react';

export const appNavigation = [
	{
		label: 'Agent',
		path: '/agent',
		description: 'Work with your personal agent and MCP tools.',
		icon: BotIcon,
	},
	{
		label: 'Calendar',
		path: '/calendar',
		description: 'Schedule and organize tasks by day.',
		icon: CalendarDaysIcon,
	},
	{
		label: 'Notes',
		path: '/notes',
		description: 'Write structured notes that stay available offline.',
		icon: NotebookPenIcon,
	},
	{
		label: 'Finance',
		path: '/finance',
		description: 'Log spending and track savings.',
		icon: ChartNoAxesCombinedIcon,
	},
	{
		label: 'Storage',
		path: '/storage',
		description: 'Manage files and uploads in object storage.',
		icon: FolderOpenIcon,
	},
	{
		label: 'Credentials',
		path: '/credentials',
		description: 'Store and recover credentials securely.',
		icon: KeyRoundIcon,
	},
] as const;

/**
 * Where the root lands when there is no remembered screen to restore.
 *
 * `/` is not a screen of its own: it redirects here. Declared next to the paths
 * it has to agree with, so renaming that route breaks a test instead of quietly
 * sending every fresh start to a route that no longer exists.
 */
export const APP_DEFAULT_PATH = '/agent';

export function getNavigationItem(pathname: string) {
	return appNavigation.find(({ path }) => path === pathname);
}

export type AppBreadcrumbItem = {
	/** Stable across renders: sibling folders can repeat a label at other depths. */
	key: string;
	label: string;
	path?: string;
	icon?: LucideIcon;
	current?: boolean;
};

/**
 * `trail` holds the items a solution contributes for the record it has open.
 * Navigation stays generic: it never learns what those items represent, and the
 * last item of the composed breadcrumb is always the current page.
 */
export function getBreadcrumbItems(
	pathname: string,
	trail: AppBreadcrumbItem[] = [],
): AppBreadcrumbItem[] {
	const item = getNavigationItem(pathname);
	// `/` has no navigation entry of its own — it redirects — so it lands here
	// along with any route that is not a product area.
	if (!item)
		return [{ key: 'home', label: 'Personal', icon: HouseIcon, current: true }];

	const items: AppBreadcrumbItem[] = [
		{ key: 'home', label: 'Personal', path: '/', icon: HouseIcon },
		{
			key: item.path,
			label: item.label,
			icon: item.icon,
			...(trail.length > 0 ? { path: item.path } : {}),
		},
		...trail,
	];

	return items.map((entry, index) =>
		index === items.length - 1 ? { ...entry, current: true } : entry,
	);
}
