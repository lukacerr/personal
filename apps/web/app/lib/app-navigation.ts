import {
	BotIcon,
	CalendarDaysIcon,
	ChartNoAxesCombinedIcon,
	FolderOpenIcon,
	GraduationCapIcon,
	HouseIcon,
	KeyRoundIcon,
	LayoutDashboardIcon,
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
		description: 'Write and connect simple Markdown notes.',
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

export function getBreadcrumbItems(pathname: string) {
	const item = getNavigationItem(pathname);
	if (!item || item.path === '/')
		return [{ label: 'Personal', icon: HouseIcon }] as const;

	return [
		{ label: 'Personal', path: '/', icon: HouseIcon },
		{ label: item.label, icon: item.icon },
	] as const;
}
