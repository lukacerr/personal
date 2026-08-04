import { Badge } from '@web/components/ui/badge';

export type AppEnvironment = 'development' | 'production';

export function AppEnvironmentBadge({
	environment,
}: {
	environment: AppEnvironment;
}) {
	return (
		<Badge variant="outline" aria-label={`Environment: ${environment}`}>
			{environment === 'development' ? 'DEV' : 'PROD'}
		</Badge>
	);
}
