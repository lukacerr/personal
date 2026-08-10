import { Button } from '@web/components/ui/button';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from '@web/components/ui/input-group';
import { Spinner } from '@web/components/ui/spinner';
import {
	EyeIcon,
	EyeOffIcon,
	LockIcon,
	LockOpenIcon,
	PlusIcon,
	RefreshCwIcon,
	SearchIcon,
	XIcon,
} from 'lucide-react';

export function CredentialToolbar({
	query,
	count,
	locked,
	anyShown,
	refreshing,
	onQueryChange,
	onToggleAllShown,
	onCreate,
	onUnlock,
	onForget,
	onRefresh,
}: {
	query: string;
	count: number;
	locked: boolean;
	anyShown: boolean;
	refreshing: boolean;
	onQueryChange: (value: string) => void;
	onToggleAllShown: () => void;
	onCreate: () => void;
	onUnlock: () => void;
	onForget: () => void;
	onRefresh: () => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<InputGroup className="min-w-40 flex-1 md:max-w-xl">
				<InputGroupAddon>
					<SearchIcon aria-hidden="true" />
				</InputGroupAddon>
				<InputGroupInput
					value={query}
					placeholder="Search credentials…"
					aria-label="Search credentials by title"
					onChange={(event) => onQueryChange(event.target.value)}
				/>
				{query ? (
					<InputGroupAddon align="inline-end">
						<InputGroupButton
							size="icon-xs"
							aria-label="Clear credential search"
							onClick={() => onQueryChange('')}
						>
							<XIcon />
						</InputGroupButton>
					</InputGroupAddon>
				) : null}
			</InputGroup>

			{/* Only offered once there is something to reveal, and never while the
			    vault is locked: there would be nothing behind the mask. */}
			{!locked && count > 0 ? (
				<Button variant="outline" onClick={onToggleAllShown}>
					{anyShown ? (
						<EyeOffIcon data-icon="inline-start" />
					) : (
						<EyeIcon data-icon="inline-start" />
					)}
					{anyShown ? 'Hide all' : 'Reveal all'}
				</Button>
			) : null}

			{locked ? (
				<Button variant="outline" onClick={onUnlock}>
					<LockIcon data-icon="inline-start" /> Unlock
				</Button>
			) : (
				<Button variant="outline" onClick={onForget}>
					<LockOpenIcon data-icon="inline-start" /> Forget secret
				</Button>
			)}

			<Button
				variant="outline"
				size="icon"
				onClick={onRefresh}
				disabled={refreshing}
				aria-label="Refresh credentials"
			>
				{refreshing ? <Spinner /> : <RefreshCwIcon />}
			</Button>

			<Button onClick={onCreate}>
				<PlusIcon data-icon="inline-start" /> New credential
			</Button>
		</div>
	);
}
