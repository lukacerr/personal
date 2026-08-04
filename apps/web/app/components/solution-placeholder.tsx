import { Badge } from '@web/components/ui/badge';
import { Card, CardContent } from '@web/components/ui/card';
import { getNavigationItem } from '@web/lib/app-navigation';

export function SolutionPlaceholder({ path }: { path: string }) {
	const item = getNavigationItem(path);
	if (!item) return null;

	const Icon = item.icon;

	return (
		<div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-5 py-10 sm:px-8 sm:py-14 lg:px-12">
			<div className="flex max-w-2xl flex-col gap-4">
				<Badge variant="secondary" className="w-fit">
					Planned
				</Badge>
				<div className="flex items-center gap-4">
					<span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-muted text-muted-foreground">
						<Icon aria-hidden="true" />
					</span>
					<h1 className="font-heading text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
						{item.label}
					</h1>
				</div>
				<p className="text-base leading-7 text-muted-foreground">
					{item.description}
				</p>
			</div>

			<Card className="mt-10 min-h-64 border-dashed shadow-none sm:mt-14">
				<CardContent className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
					This workspace will take shape here.
				</CardContent>
			</Card>
		</div>
	);
}
