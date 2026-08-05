import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from '@web/components/ui/breadcrumb';
import { getBreadcrumbItems } from '@web/lib/app-navigation';
import { Fragment } from 'react';
import { Link } from 'react-router';

export function AppBreadcrumb({ pathname }: { pathname: string }) {
	const items = getBreadcrumbItems(pathname);

	return (
		<Breadcrumb>
			<BreadcrumbList className="flex-nowrap gap-1.5 sm:gap-2.5">
				{items.map((item, index) => (
					<Fragment key={item.label}>
						<BreadcrumbItem className="min-w-0 gap-1.5">
							{'path' in item ? (
								<BreadcrumbLink
									className="flex min-w-0 items-center gap-1.5"
									render={<Link to={item.path} />}
								>
									<item.icon aria-hidden="true" className="size-4 shrink-0" />
									<span className="hidden truncate sm:inline">{item.label}</span>
									<span className="sr-only sm:hidden">{item.label}</span>
								</BreadcrumbLink>
							) : (
								<BreadcrumbPage className="flex min-w-0 items-center gap-1.5">
									<item.icon aria-hidden="true" className="size-4 shrink-0" />
									<span className="hidden truncate sm:inline">{item.label}</span>
									<span className="sr-only sm:hidden">{item.label}</span>
								</BreadcrumbPage>
							)}
						</BreadcrumbItem>
						{index < items.length - 1 && (
							<BreadcrumbSeparator className="shrink-0" />
						)}
					</Fragment>
				))}
			</BreadcrumbList>
		</Breadcrumb>
	);
}
