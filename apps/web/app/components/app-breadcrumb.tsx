import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from '@web/components/ui/breadcrumb';
import {
	type AppBreadcrumbItem,
	getBreadcrumbItems,
} from '@web/lib/app-navigation';
import { loadSystemBreadcrumbTrail } from '@web/lib/app-systems';
import { useLiveQuery } from 'dexie-react-hooks';
import { FolderIcon } from 'lucide-react';
import { Fragment } from 'react';
import { Link } from 'react-router';

function BreadcrumbItems({
	items,
	compact = false,
}: {
	items: AppBreadcrumbItem[];
	compact?: boolean;
}) {
	return items.map((item, index) => {
		const Icon = item.icon;
		const icon = Icon && (
			<Icon aria-hidden="true" className="size-4 shrink-0" />
		);
		return (
			<Fragment key={item.key}>
				<BreadcrumbItem className="min-w-0 gap-1.5">
					{item.path ? (
						<BreadcrumbLink
							className="flex min-w-0 items-center gap-1.5"
							render={<Link to={item.path} />}
						>
							{icon}
							<span className={compact && Icon ? 'sr-only' : 'truncate'}>
								{item.label}
							</span>
						</BreadcrumbLink>
					) : item.current ? (
						<BreadcrumbPage className="flex min-w-0 items-center gap-1.5">
							{icon}
							<span className="truncate" title={item.label}>
								{item.label}
							</span>
						</BreadcrumbPage>
					) : (
						<span className="flex min-w-0 items-center gap-1.5">
							{icon}
							<span className="truncate" title={item.label}>
								{item.label}
							</span>
						</span>
					)}
				</BreadcrumbItem>
				{index < items.length - 1 && (
					<BreadcrumbSeparator className="shrink-0" />
				)}
			</Fragment>
		);
	});
}

/**
 * Narrow screens cannot fit a deep note path, so the intermediate folders
 * collapse into a single truncated segment that still names them. An opaque
 * ellipsis would hide that information without offering a way to recover it.
 */
function collapseFolders(items: AppBreadcrumbItem[]): AppBreadcrumbItem[] {
	if (items.length <= 3) return items;

	const folders = items.slice(2, -1);
	const last = items[items.length - 1];
	if (!items[1] || !last) return items;

	return [
		items[1],
		...(folders.length > 0
			? [
					{
						key: 'folders',
						label: folders.map(({ label }) => label).join('/'),
						icon: FolderIcon,
					},
				]
			: []),
		last,
	];
}

export function AppBreadcrumb({
	pathname,
	search,
}: {
	pathname: string;
	search: string;
}) {
	const trail = useLiveQuery(
		() => loadSystemBreadcrumbTrail(pathname, search),
		[pathname, search],
		[],
	);
	const items = getBreadcrumbItems(pathname, trail);

	return (
		<Breadcrumb className="min-w-0 overflow-hidden">
			<BreadcrumbList className="hidden flex-nowrap gap-1.5 overflow-hidden md:flex">
				<BreadcrumbItems items={items} />
			</BreadcrumbList>
			<BreadcrumbList className="flex flex-nowrap gap-1.5 overflow-hidden md:hidden">
				<BreadcrumbItems items={collapseFolders(items)} compact />
			</BreadcrumbList>
		</Breadcrumb>
	);
}
