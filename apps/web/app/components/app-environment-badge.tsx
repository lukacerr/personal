import { Badge } from '@web/components/ui/badge';
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from '@web/components/ui/tooltip';
import { CloudIcon, LaptopIcon } from 'lucide-react';

export type AppEnvironment = 'development' | 'production';

export function AppEnvironmentBadge({
	environment,
}: {
	environment: AppEnvironment;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Badge variant="outline" aria-label={`Environment: ${environment}`}>
						{environment === 'development' ? (
							<LaptopIcon data-icon="inline-start" aria-hidden="true" />
						) : (
							<CloudIcon data-icon="inline-start" aria-hidden="true" />
						)}
						<span className="hidden sm:inline">
							{environment === 'development' ? 'DEV' : 'PROD'}
						</span>
					</Badge>
				}
			/>
			<TooltipContent>
				{environment === 'development'
					? 'Development environment'
					: 'Production environment'}
			</TooltipContent>
		</Tooltip>
	);
}
