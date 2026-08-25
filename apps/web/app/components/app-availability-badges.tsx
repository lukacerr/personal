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
	onRecheck,
}: {
	pwaAvailability: PwaAvailability;
	apiHealth: ApiHealth;
	/**
	 * Asks the API again — the only thing that ever does. The app checks once at
	 * startup and never on its own after that, so a window left open costs
	 * nothing; see `useApiHealth` for why that beat re-checking on focus.
	 */
	onRecheck?: () => void;
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
			{/* A button, not a decorated span: since nothing re-checks on its own,
			    this is the only way to ask, so it has to be reachable by keyboard
			    and named for what it does rather than only for what it shows. */}
			<Tooltip>
				<TooltipTrigger
					render={
						<Badge
							aria-label={`API ${apiLabel} — check again`}
							className="cursor-pointer transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
							onClick={onRecheck}
							render={<button type="button" />}
							variant="outline"
						>
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
					<span className="text-background/70">Click to check again</span>
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
