export type NotesRefreshResult =
	| { status: 'refreshed' }
	| { status: 'offline' }
	| { status: 'failed'; error: unknown };

export type NotesRefreshFailure = Exclude<
	NotesRefreshResult,
	{ status: 'refreshed' }
>;

type NotesRefreshOptions = {
	syncOutbox: () => Promise<unknown>;
	refreshIndex: () => Promise<unknown>;
	fetchNote: (id: string) => Promise<unknown>;
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

	return function refresh(noteId?: string): Promise<NotesRefreshResult> {
		if (active) return active;
		if (!isOnline()) return Promise.resolve({ status: 'offline' as const });

		active = (async (): Promise<NotesRefreshResult> => {
			try {
				// Local work ships first, so the index cannot report the note as
				// outdated against a version this device has not sent yet.
				await syncOutbox();
				await refreshIndex();
				if (noteId) {
					const state = await getNoteState(noteId);
					if (state && !state.dirty && state.pendingCount === 0)
						await fetchNote(noteId);
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
