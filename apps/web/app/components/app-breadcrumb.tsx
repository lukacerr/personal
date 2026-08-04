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
			<BreadcrumbList>
				{items.map((item, index) => (
					<Fragment key={item.label}>
						<BreadcrumbItem>
							{'path' in item ? (
								<BreadcrumbLink render={<Link to={item.path} />}>
									{item.label}
								</BreadcrumbLink>
							) : (
								<BreadcrumbPage>{item.label}</BreadcrumbPage>
							)}
						</BreadcrumbItem>
						{index < items.length - 1 && <BreadcrumbSeparator />}
					</Fragment>
				))}
			</BreadcrumbList>
		</Breadcrumb>
	);
}
