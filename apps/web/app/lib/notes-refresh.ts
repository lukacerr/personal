export type NotesRefreshResult =
	| { status: 'refreshed' }
	| { status: 'cancelled' }
	| { status: 'offline' }
	| { status: 'failed'; error: unknown };

export type NotesRefreshFailure = Exclude<
	NotesRefreshResult,
	{ status: 'refreshed' | 'cancelled' }
>;

type NotesRefreshOptions = {
	syncOutbox: (isCurrent: () => boolean) => Promise<unknown>;
	refreshIndex: (isCurrent: () => boolean) => Promise<unknown>;
	fetchNote: (id: string, isCurrent: () => boolean) => Promise<unknown>;
	/** Local work must survive a refresh, so the note state decides the fetch. */
	getNoteState: (id: string) => Promise<
		| {
				dirty: boolean;
				pendingCount: number;
		  }
		| undefined
	>;
	isOnline: () => boolean;
};

/**
 * Pulls the server state on demand: the automatic triggers only fire on mount,
 * on reconnect and when the tab becomes visible, so an app left open and
 * focused never sees edits made from another device.
 */
export function createNotesRefresh({
	syncOutbox,
	refreshIndex,
	fetchNote,
	getNoteState,
	isOnline,
}: NotesRefreshOptions) {
	let active: Promise<NotesRefreshResult> | undefined;

	return function refresh(
		noteId?: string,
		isCurrent: () => boolean = () => true,
	): Promise<NotesRefreshResult> {
		if (active) return active;
		if (!isCurrent()) return Promise.resolve({ status: 'cancelled' as const });
		if (!isOnline()) return Promise.resolve({ status: 'offline' as const });

		active = (async (): Promise<NotesRefreshResult> => {
			try {
				// Local work ships first, so the index cannot report the note as
				// outdated against a version this device has not sent yet.
				await syncOutbox(isCurrent);
				if (!isCurrent()) return { status: 'cancelled' };
				await refreshIndex(isCurrent);
				if (!isCurrent()) return { status: 'cancelled' };
				if (noteId) {
					const state = await getNoteState(noteId);
					if (state && !state.dirty && state.pendingCount === 0)
						await fetchNote(noteId, isCurrent);
					if (!isCurrent()) return { status: 'cancelled' };
				}
				return { status: 'refreshed' };
			} catch (error) {
				return { status: 'failed', error };
			}
		})().finally(() => {
			active = undefined;
		});

		return active;
	};
}

const statusMessages: Record<number, string> = {
	404: 'This note no longer exists on the server.',
	409: 'Another note already uses this title in this folder.',
	422: 'The server rejected this note as invalid.',
};

/** Keeps distinct causes distinguishable instead of one generic failure text. */
export function describeNotesFailure(failure: NotesRefreshFailure) {
	if (failure.status === 'offline')
		return 'No connection. Notes will sync when you are back online.';

	const status = (failure.error as { status?: number } | null | undefined)
		?.status;
	if (status && statusMessages[status]) return statusMessages[status];
	if (status && status >= 500)
		return 'The server could not be reached. Try again in a moment.';
	return 'Something went wrong. Try again in a moment.';
}

/**
 * Why a selected note has nothing to show.
 *
 * `missing` is terminal and the others are worth retrying, so they must never
 * collapse into one state: only the server can say a note is gone, and calling
 * a dropped connection a deletion tells the user their note is lost while it
 * sits safely on the server.
 */
export type NoteLoadFailure = 'missing' | 'offline' | 'failed';

export function classifyNoteLoadFailure(
	error: unknown,
	online: boolean,
): NoteLoadFailure {
	const status = (error as { status?: number } | null | undefined)?.status;
	// A 404 is an answer, so it means the server was reached whatever the browser
	// currently believes about connectivity.
	if (status === 404) return 'missing';
	if (!online) return 'offline';
	return 'failed';
}
