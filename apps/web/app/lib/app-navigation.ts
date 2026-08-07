import {
	BotIcon,
	CalendarDaysIcon,
	ChartNoAxesCombinedIcon,
	FolderOpenIcon,
	GraduationCapIcon,
	HouseIcon,
	KeyRoundIcon,
	LayoutDashboardIcon,
	type LucideIcon,
	NotebookPenIcon,
	SaladIcon,
} from 'lucide-react';

export const appNavigation = [
	{
		label: 'Overview',
		path: '/',
		description: 'Your personal systems at a glance.',
		icon: LayoutDashboardIcon,
	},
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
		label: 'Nutrition',
		path: '/nutrition',
		description: 'Track diet, calories and weight.',
		icon: SaladIcon,
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
	{
		label: 'Studyo',
		path: '/studyo',
		description: 'Build AI-powered study material for exams.',
		icon: GraduationCapIcon,
	},
] as const;

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
	if (!item || item.path === '/')
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
