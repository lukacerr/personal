import {
	BotIcon,
	CalendarDaysIcon,
	ChartNoAxesCombinedIcon,
	FolderOpenIcon,
	GraduationCapIcon,
	KeyRoundIcon,
	LayoutDashboardIcon,
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
		label: 'Calendar',
		path: '/calendar',
		description: 'Schedule and organize tasks by day.',
		icon: CalendarDaysIcon,
	},
	{
		label: 'Finance',
		path: '/finance',
		description: 'Log spending and track savings.',
		icon: ChartNoAxesCombinedIcon,
	},
	{
		label: 'Credentials',
		path: '/credentials',
		description: 'Store and recover credentials securely.',
		icon: KeyRoundIcon,
	},
	{
		label: 'Storage',
		path: '/storage',
		description: 'Manage files and uploads in object storage.',
		icon: FolderOpenIcon,
	},
	{
		label: 'Studyo',
		path: '/studyo',
		description: 'Build AI-powered study material for exams.',
		icon: GraduationCapIcon,
	},
	{
		label: 'Nutrition',
		path: '/nutrition',
		description: 'Track diet, calories and weight.',
		icon: SaladIcon,
	},
	{
		label: 'Agent',
		path: '/agent',
		description: 'Work with your personal agent and MCP tools.',
		icon: BotIcon,
	},
] as const;

export function getNavigationItem(pathname: string) {
	return appNavigation.find(({ path }) => path === pathname);
}

export function getBreadcrumbItems(pathname: string) {
	const item = getNavigationItem(pathname);
	if (!item || item.path === '/') return [{ label: 'Personal' }] as const;

	return [{ label: 'Personal', path: '/' }, { label: item.label }] as const;
}
