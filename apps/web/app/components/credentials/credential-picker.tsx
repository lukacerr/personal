import { Button } from '@web/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@web/components/ui/dialog';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from '@web/components/ui/input-group';
import { Spinner } from '@web/components/ui/spinner';
import { filterCredentials } from '@web/lib/credentials';
import type { Credential } from '@web/lib/credentials-api';
import { useCredentialsStore } from '@web/lib/credentials-store';
import { KeyRoundIcon, SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

/**
 * Picks a credential for a note block.
 *
 * Titles only: choosing what to reference needs no secret, and a picker is the
 * last place that should be decrypting anything.
 */
export function CredentialPicker({
	onPick,
	onClose,
}: {
	onPick: (credential: Credential) => void;
	onClose: () => void;
}) {
	const credentials = useCredentialsStore((state) => state.credentials);
	const status = useCredentialsStore((state) => state.status);
	const load = useCredentialsStore((state) => state.load);
	const [query, setQuery] = useState('');

	useEffect(() => {
		void load();
	}, [load]);

	const matches = useMemo(
		() => filterCredentials(credentials, query),
		[credentials, query],
	);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Reference a credential</DialogTitle>
					<DialogDescription>
						The note stores only which credential this is, never its value.
					</DialogDescription>
				</DialogHeader>

				<InputGroup>
					<InputGroupAddon>
						<SearchIcon aria-hidden="true" />
					</InputGroupAddon>
					<InputGroupInput
						autoFocus
						value={query}
						placeholder="Search credentials…"
						aria-label="Search credentials by title"
						onChange={(event) => setQuery(event.target.value)}
					/>
				</InputGroup>

				{status === 'loading' && credentials.length === 0 ? (
					<div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
						<Spinner /> Loading credentials…
					</div>
				) : matches.length === 0 ? (
					<p className="py-6 text-center text-muted-foreground text-sm">
						{credentials.length === 0
							? 'There are no credentials to reference yet.'
							: 'No credential matches that search.'}
					</p>
				) : (
					<ul className="max-h-72 overflow-y-auto">
						{matches.map((credential) => (
							<li key={credential.id}>
								<Button
									variant="ghost"
									className="h-auto w-full justify-start py-2.5"
									onClick={() => onPick(credential)}
								>
									<KeyRoundIcon data-icon="inline-start" />
									<span className="truncate">{credential.title}</span>
								</Button>
							</li>
						))}
					</ul>
				)}
			</DialogContent>
		</Dialog>
	);
}
