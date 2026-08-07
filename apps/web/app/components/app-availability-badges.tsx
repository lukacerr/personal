import { Badge } from '@web/components/ui/badge';
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from '@web/components/ui/tooltip';
import type { ApiHealth, PwaAvailability } from '@web/lib/availability';
import { CloudOffIcon, ServerIcon, WifiIcon } from 'lucide-react';

const apiStatusLabel = {
	loading: 'Loading',
	healthy: 'Healthy',
	partial: 'Partial',
	down: 'Down',
} as const;

const apiStatusClass = {
	loading: 'bg-muted-foreground',
	healthy: 'bg-green-500',
	partial: 'bg-yellow-500',
	down: 'bg-destructive',
} as const;

const serviceLabels = {
	dbCheck: 'Database',
	cacheCheck: 'Cache',
	storageCheck: 'Storage',
} as const;

function formatCheckedAt(checkedAt: string | undefined) {
	if (!checkedAt) return 'Not checked yet';
	return `Checked ${new Intl.DateTimeFormat(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).format(new Date(checkedAt))}`;
}

export function AppAvailabilityBadges({
	pwaAvailability,
	apiHealth,
}: {
	pwaAvailability: PwaAvailability;
	apiHealth: ApiHealth;
}) {
	const unavailableServices = Object.entries(apiHealth.services ?? {})
		.filter(([, isAvailable]) => !isAvailable)
		.map(([name]) => serviceLabels[name as keyof typeof serviceLabels])
		.join(', ');
	const pwaOnline = pwaAvailability === 'online';
	const apiLabel = apiStatusLabel[apiHealth.status];
	const apiDetail =
		apiHealth.status === 'healthy'
			? 'All services operational'
			: apiHealth.status === 'partial'
				? `Unavailable: ${unavailableServices}`
				: apiHealth.status === 'down'
					? 'The API health check could not be completed'
					: 'Checking API health';

	return (
		<div className="flex shrink-0 items-center gap-1 sm:gap-2">
			<Tooltip>
				<TooltipTrigger
					render={
						<Badge variant="outline" aria-label={`PWA ${pwaAvailability}`}>
							{pwaOnline ? (
								<WifiIcon data-icon="inline-start" aria-hidden="true" />
							) : (
								<CloudOffIcon data-icon="inline-start" aria-hidden="true" />
							)}
							<span
								aria-hidden="true"
								className={`size-1.5 rounded-full ${
									pwaOnline ? 'bg-green-500' : 'bg-destructive'
								}`}
							/>
							<span className="hidden sm:inline">PWA</span>
						</Badge>
					}
				/>
				<TooltipContent>
					{pwaOnline
						? 'Browser connection available'
						: 'Browser reports no network connection'}
				</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger
					render={
						<Badge variant="outline" aria-label={`API ${apiLabel}`}>
							<ServerIcon data-icon="inline-start" aria-hidden="true" />
							<span
								aria-hidden="true"
								className={`size-1.5 rounded-full ${apiStatusClass[apiHealth.status]}`}
							/>
							<span className="hidden sm:inline">{apiLabel}</span>
						</Badge>
					}
				/>
				<TooltipContent className="flex flex-col items-start gap-0.5">
					<span>{apiDetail}</span>
					<span className="text-background/70">
						{formatCheckedAt(apiHealth.checkedAt)}
					</span>
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
