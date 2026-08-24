import type { DefaultReactSuggestionItem } from '@blocknote/react';
import { createReactBlockSpec } from '@blocknote/react';
import { CredentialUnlockDialog } from '@web/components/credentials/credential-unlock';
import { NoteCredentialView } from '@web/components/notes/note-credential-view';
import { readCredentialValue } from '@web/lib/credentials';
import type { Credential } from '@web/lib/credentials-api';
import { useCredentialsSecretStore } from '@web/lib/credentials-secret';
import { useCredentialsStore } from '@web/lib/credentials-store';
import { indexUnavailable } from '@web/lib/index-store';
import {
	CREDENTIAL_BLOCK_TYPE,
	type CredentialBlockState,
} from '@web/lib/notes-credentials';
import { blockText } from '@web/lib/notes-editor';
import { opensDisplayEquation } from '@web/lib/notes-math';
import type { NotesEditor } from '@web/lib/notes-schema';
import { KeyRoundIcon } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';
import { toast } from 'sonner';

const CREDENTIAL_MENU_GROUP = 'Credentials';
/** The slash menu deletes its query but leaves the trigger in the block. */
const CREDENTIAL_MENU_TRIGGER = '/';

export type NoteCredentialAccess = {
	/**
	 * Whether the reader has a session. A public visitor has none, and a credential
	 * is never resolved for one — unlike an attachment, there is no public endpoint
	 * to fall back on, and there must not be one.
	 */
	authenticated: boolean;
};

/**
 * The same schema renders in three places that do not have the same rights: the
 * editor, the read-only history preview, and the public page, where the visitor
 * has no session at all. `editor.isEditable` tells the first from the other two
 * but not the last two from each other, so the context says it outright. The
 * default is the authenticated value, which is what lets the history preview work
 * with no provider at all.
 */
export const editorNoteCredentialAccess: NoteCredentialAccess = {
	authenticated: true,
};

/** What a public page can offer: nothing, and it says so. */
export const publicNoteCredentialAccess: NoteCredentialAccess = {
	authenticated: false,
};

const NoteCredentialAccessContext = createContext<NoteCredentialAccess>(
	editorNoteCredentialAccess,
);

export function NoteCredentialAccessProvider({
	value,
	children,
}: {
	value: NoteCredentialAccess;
	children: React.ReactNode;
}) {
	return (
		<NoteCredentialAccessContext.Provider value={value}>
			{children}
		</NoteCredentialAccessContext.Provider>
	);
}

/**
 * Inside a block spec BlockNote narrows the editor's schema to that one block, so
 * its `updateBlock` will not accept a paragraph — the same wall the attachment
 * block hits, and answered the same way.
 */
function discardEmptyCredential(
	editor: { updateBlock: CallableFunction },
	blockId: string,
) {
	editor.updateBlock(blockId, { type: 'paragraph' });
}

function useNoteCredential(credentialId: string) {
	// Depended on individually rather than through the context object: a provider
	// that rebuilds its value every render would otherwise restart this effect on
	// every render.
	const { authenticated } = useContext(NoteCredentialAccessContext);

	// The same index the screen and the palette read, so one fetch serves all
	// three and a block never disagrees with the list about what exists.
	const credentials = useCredentialsStore((state) => state.credentials);
	const status = useCredentialsStore((state) => state.status);
	const load = useCredentialsStore((state) => state.load);
	const secret = useCredentialsSecretStore((state) => state.secret);

	const [state, setState] = useState<CredentialBlockState>('loading');
	const [value, setValue] = useState<string>();
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!credentialId || !authenticated) return;
		void load(attempt > 0);
	}, [attempt, authenticated, credentialId, load]);

	useEffect(() => {
		if (!credentialId) {
			setState('empty');
			return;
		}
		if (!authenticated) {
			setState('unavailable');
			return;
		}
		if (indexUnavailable(status)) {
			setState('failed');
			return;
		}
		if (status !== 'ready') {
			setState('loading');
			return;
		}

		const found = credentials.find((entry) => entry.id === credentialId);
		if (!found) {
			// The index loaded and this id is not in it, so the credential is gone.
			// Deleting one never touches the notes that pointed at it; they say so.
			setState('missing');
			return;
		}

		let current = true;
		void (async () => {
			const read = await readCredentialValue(found, secret);
			if (!current) return;
			setState(read.state === 'readable' ? 'ready' : read.state);
			setValue(read.state === 'readable' ? read.value : undefined);
		})();
		return () => {
			current = false;
		};
	}, [authenticated, credentialId, credentials, secret, status]);

	return {
		state,
		value,
		samples: credentials,
		retry: () => setAttempt((count) => count + 1),
	};
}

export const credentialBlock = createReactBlockSpec(
	{
		type: CREDENTIAL_BLOCK_TYPE,
		/**
		 * The id and the title, and nothing else. Props are serialised verbatim into
		 * the note document, every history version, every delta and the payload of a
		 * published note, so the value can never be one of them. The title is
		 * denormalised so the block draws before the network answers and still names
		 * what it held once the credential is deleted.
		 *
		 * Not `fileId`: `GET /files/unreferenced` matches `props.fileId` across every
		 * block type. Not `contentType`: BlockNote renders props as `data-*` and
		 * `data-content-type` is how it marks a block's own type.
		 */
		propSchema: {
			credentialId: { default: '' },
			title: { default: '' },
		},
		content: 'none',
	},
	{
		render: ({ block, editor }) => {
			const { credentialId, title } = block.props;
			const { state, value, samples, retry } = useNoteCredential(credentialId);
			const editable = editor.isEditable;
			// A block inserted from the menu has nothing in it, so it asks straight
			// away rather than sitting there as a button waiting to be found.
			const [picking, setPicking] = useState(editable && !credentialId);
			const [shown, setShown] = useState(false);
			const [unlocking, setUnlocking] = useState(false);
			const unlock = useCredentialsSecretStore((store) => store.unlock);

			return (
				<>
					<NoteCredentialView
						state={state}
						title={title}
						value={value}
						shown={shown}
						editable={editable}
						onChoose={() => setPicking(true)}
						onToggleShown={() => setShown((current) => !current)}
						onUnlock={() => setUnlocking(true)}
						onRetry={retry}
						onCopy={() => {
							if (value === undefined) return;
							void navigator.clipboard
								.writeText(value)
								.then(() => toast.success(`“${title}” copied.`))
								.catch(() =>
									toast.error(
										'This browser would not let the value be copied.',
									),
								);
						}}
					/>

					<CredentialUnlockDialog
						open={unlocking}
						samples={samples}
						onUnlock={unlock}
						onClose={() => setUnlocking(false)}
					/>

					{picking && editable ? (
						<NoteCredentialPickerMount
							onClose={() => {
								setPicking(false);
								// A reference nobody chose gives back the paragraph it took.
								if (!credentialId) discardEmptyCredential(editor, block.id);
							}}
							onPick={(picked) => {
								setPicking(false);
								editor.updateBlock(block, {
									props: { credentialId: picked.id, title: picked.title },
								});
							}}
						/>
					) : null}
				</>
			);
		},
	},
);

/**
 * Loaded only when someone asks for it: the picker drags in the whole credential
 * index, and most notes never open one.
 */
function NoteCredentialPickerMount({
	onClose,
	onPick,
}: {
	onClose: () => void;
	onPick: (credential: Credential) => void;
}) {
	const [Picker, setPicker] = useState<
		| typeof import('@web/components/credentials/credential-picker').CredentialPicker
		| null
	>(null);

	useEffect(() => {
		let current = true;
		void import('@web/components/credentials/credential-picker').then(
			(module) => {
				if (current) setPicker(() => module.CredentialPicker);
			},
		);
		return () => {
			current = false;
		};
	}, []);

	if (!Picker) return null;
	return <Picker onClose={onClose} onPick={onPick} />;
}

type CredentialMenuEditor = Pick<
	NotesEditor,
	| 'getTextCursorPosition'
	| 'insertBlocks'
	| 'setTextCursorPosition'
	| 'updateBlock'
>;

export function credentialSlashMenuItems(
	editor: CredentialMenuEditor,
): DefaultReactSuggestionItem[] {
	return [
		{
			title: 'Credential',
			subtext: 'Reference a stored credential',
			// Without a group BlockNote emits a section with no name and no key.
			group: CREDENTIAL_MENU_GROUP,
			icon: <KeyRoundIcon />,
			onItemClick: () => {
				const { block } = editor.getTextCursorPosition();
				const reference = {
					type: CREDENTIAL_BLOCK_TYPE,
					props: { credentialId: '', title: '' },
				} as const;
				// Like a display equation, a reference replaces the block it lands on,
				// so picking one from the middle of a written line adds it below instead
				// of erasing the line.
				if (opensDisplayEquation(blockText(block), CREDENTIAL_MENU_TRIGGER)) {
					editor.updateBlock(block, reference);
					return;
				}
				const [inserted] = editor.insertBlocks([reference], block, 'after');
				if (inserted) editor.setTextCursorPosition(inserted);
			},
		},
	];
}
