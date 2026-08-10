import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import {
	NoteFileAccessProvider,
	publicNoteFileAccess,
} from '@web/components/notes/note-file';
import { Button } from '@web/components/ui/button';
import { Spinner } from '@web/components/ui/spinner';
import { api } from '@web/lib/api';
import { type NoteBlock, notesSchema } from '@web/lib/notes-schema';
import { FileX2Icon, RotateCwIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

type PublicNoteDocument = { id: string; title: string; content: NoteBlock[] };

/**
 * The mirror of `toApiContent`: the API stores the document as opaque JSON, but
 * types its contract with BlockNote's default schema, which has no equation
 * block. This is the only place the public page has to reconcile the two views.
 */
function toNoteBlocks(content: unknown) {
	return content as NoteBlock[];
}

type PublicNoteState =
	| { status: 'loading' }
	| { status: 'ready'; note: PublicNoteDocument }
	| { status: 'unavailable' }
	| { status: 'failed' };

export function meta() {
	return [
		{ title: 'Shared note | Personal systems' },
		// A link meant for one person is not search results material.
		{ name: 'robots', content: 'noindex' },
	];
}

/**
 * BlockNote owns the document, so it is mounted per note through a key rather
 * than being handed new content. Neither Find nor the math input rules are
 * registered: nothing here is editable.
 */
function PublicNoteBody({ content }: { content: NoteBlock[] }) {
	const editor = useCreateBlockNote({
		initialContent: content,
		schema: notesSchema,
	});
	return (
		// A visitor has no session, so an attachment cannot be signed for them.
		// The only URL that works here is the published one, and a file that was
		// never shared simply does not appear.
		<NoteFileAccessProvider value={publicNoteFileAccess}>
			<BlockNoteView
				editor={editor}
				editable={false}
				slashMenu={false}
				theme="dark"
			/>
		</NoteFileAccessProvider>
	);
}

function PublicNoteMessage({
	title,
	description,
	icon: Icon,
	onRetry,
}: {
	title: string;
	description: string;
	icon: typeof FileX2Icon;
	onRetry?: () => void;
}) {
	return (
		<div className="grid min-h-dvh place-items-center px-6 text-center">
			<div className="max-w-sm" role="status">
				<Icon className="mx-auto size-10 text-muted-foreground/50" />
				<h1 className="mt-5 font-heading text-2xl font-semibold tracking-tight">
					{title}
				</h1>
				<p className="mt-2 text-sm leading-6 text-muted-foreground">
					{description}
				</p>
				{onRetry && (
					<Button className="mt-5" onClick={onRetry}>
						<RotateCwIcon data-icon="inline-start" aria-hidden="true" />
						Try again
					</Button>
				)}
			</div>
		</div>
	);
}

export default function PublicNote() {
	const [searchParams] = useSearchParams();
	const noteId = searchParams.get('note');
	const [state, setState] = useState<PublicNoteState>({ status: 'loading' });
	const [attempt, setAttempt] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger. Asking for the same note again changes nothing else, so without it a retry could never re-run this effect.
	useEffect(() => {
		if (!noteId) {
			setState({ status: 'unavailable' });
			return;
		}
		let current = true;
		setState({ status: 'loading' });
		// The unauthenticated client: a visitor has no session, and this page must
		// never touch the owner's local database either.
		void api.public
			.notes({ id: noteId })
			.get()
			.then((response) => {
				if (!current) return;
				if (
					response.status !== 200 ||
					!response.data ||
					!('content' in response.data)
				)
					setState({ status: 'unavailable' });
				else
					setState({
						status: 'ready',
						note: {
							id: response.data.id,
							title: response.data.title,
							content: toNoteBlocks(response.data.content),
						},
					});
			})
			.catch(() => {
				if (current) setState({ status: 'failed' });
			});
		return () => {
			current = false;
		};
	}, [attempt, noteId]);

	useEffect(() => {
		if (state.status === 'ready')
			document.title = `${state.note.title} | Personal systems`;
	}, [state]);

	if (state.status === 'loading')
		return (
			<div className="grid min-h-dvh place-items-center">
				<div
					className="flex items-center gap-2 text-sm text-muted-foreground"
					role="status"
				>
					<Spinner /> Loading note…
				</div>
			</div>
		);

	if (state.status === 'failed')
		return (
			<PublicNoteMessage
				icon={RotateCwIcon}
				title="Could not open this note"
				description="The server did not answer. Nothing is wrong with the note itself — try again in a moment."
				onRetry={() => setAttempt((value) => value + 1)}
			/>
		);

	if (state.status === 'unavailable')
		return (
			<PublicNoteMessage
				icon={FileX2Icon}
				title="This note is not available"
				description="The link may be wrong, or the note is no longer shared."
			/>
		);

	return (
		<main className="min-h-dvh bg-background">
			<div className="mx-auto w-full max-w-[58rem] px-8 pt-10 pb-2">
				<h1 className="font-heading text-3xl font-semibold tracking-tight">
					{state.note.title}
				</h1>
			</div>
			<div
				className="notes-editor"
				data-font-size="medium"
				data-margins="medium"
			>
				<PublicNoteBody key={state.note.id} content={state.note.content} />
			</div>
		</main>
	);
}
