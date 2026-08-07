import { describeNotesFailure } from '@web/lib/notes-refresh';
import { refreshNoteIndex } from '@web/lib/notes-sync';
import { useEffect } from 'react';
import { toast } from 'sonner';

export function NotesBootstrap() {
	useEffect(() => {
		const refresh = () => {
			if (!navigator.onLine) return;
			void refreshNoteIndex().catch((error: unknown) => {
				toast.error(describeNotesFailure({ status: 'failed', error }));
			});
		};
		const handleVisibility = () => {
			if (document.visibilityState === 'visible') refresh();
		};

		refresh();
		window.addEventListener('online', refresh);
		document.addEventListener('visibilitychange', handleVisibility);
		return () => {
			window.removeEventListener('online', refresh);
			document.removeEventListener('visibilitychange', handleVisibility);
		};
	}, []);

	return null;
}
