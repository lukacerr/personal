import {
	buildStorageTree,
	canDropFolder,
	collectFileTypes,
	collectFolderPaths,
	fileTypeLabel,
	filterStorageFiles,
	formatBytes,
	isDuplicateName,
	normalizeStoragePath,
	parentFolder,
	parseStorageView,
	previewKind,
	readTextPrefix,
	reconcileStorageSelection,
	sortStorageFiles,
	storageBreadcrumb,
	storageSummary,
	uniqueFileName,
	updateStorageSearchParams,
	validateFileName,
	validateFolderName,
	validateStoragePath,
} from '@web/lib/storage';
import { describe, expect, it } from 'vitest';

function entry(name: string, path: string | null, contentType = 'text/plain') {
	return {
		id: `${path ?? ''}/${name}`,
		name,
		path,
		contentType,
		size: 10,
		isPublic: false,
		uploadedFromNotes: false,
		createdAt: 0,
		updatedAt: 0,
	};
}

describe('Byte formatting', () => {
	it.each([
		[0, '0 B'],
		[999, '999 B'],
		[1024, '1 KB'],
		[1536, '1.5 KB'],
		[1024 * 1024, '1 MB'],
		[1024 * 1024 * 1024 * 3.25, '3.25 GB'],
	])('renders %i bytes as %s', (size, expected) => {
		expect(formatBytes(size)).toBe(expected);
	});
});

describe('Preview kind', () => {
	it.each([
		['image/png', 'image'],
		['image/svg+xml', 'image'],
		['video/mp4', 'video'],
		['audio/mpeg', 'audio'],
		['application/pdf', 'pdf'],
		['text/plain', 'text'],
		['text/markdown', 'text'],
		['application/json', 'text'],
		['application/xml', 'text'],
		['text/csv', 'sheet'],
		[
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'sheet',
		],
		[
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			'document',
		],
		['application/octet-stream', 'unknown'],
		[
			'application/vnd.openxmlformats-officedocument.presentationml.presentation',
			'unknown',
		],
	])('reads %s as %s', (contentType, expected) => {
		expect(previewKind(contentType)).toBe(expected);
	});

	it('ignores the parameters of a content type', () => {
		expect(previewKind('text/plain; charset=utf-8')).toBe('text');
	});
});

describe('Text preview reads', () => {
	function streamOf(chunks: string[], onCancel: () => void) {
		let index = 0;
		return new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					const chunk = chunks[index];
					index += 1;
					if (chunk === undefined) controller.close();
					else controller.enqueue(new TextEncoder().encode(chunk));
				},
				cancel: onCancel,
			}),
		);
	}

	/**
	 * A preview shows the head of a file. Reading the rest of a half-gigabyte log
	 * spends the user's bandwidth on something nobody will ever look at.
	 */
	it('stops reading and hangs up once it has enough', async () => {
		let cancelled = false;
		const response = streamOf(['abcde', 'fghij', 'klmno'], () => {
			cancelled = true;
		});

		expect(await readTextPrefix(response, 7)).toBe('abcdefg');
		expect(cancelled).toBe(true);
	});

	it('returns everything when the file is shorter than the limit', async () => {
		const response = streamOf(['short'], () => undefined);

		expect(await readTextPrefix(response, 1024)).toBe('short');
	});
});

describe('Storage tree', () => {
	const files = [
		entry('a.txt', null),
		entry('b.txt', 'work'),
		entry('c.txt', 'work/reports'),
		entry('d.txt', 'work/reports/2026'),
		entry('e.txt', 'personal'),
	];

	it('lists the folders and files of the root', () => {
		const tree = buildStorageTree(files, null);

		expect(tree.folders).toEqual(['personal', 'work']);
		expect(tree.files.map((item) => item.name)).toEqual(['a.txt']);
	});

	it('lists only the immediate children of a folder', () => {
		const tree = buildStorageTree(files, 'work');

		expect(tree.folders).toEqual(['reports']);
		expect(tree.files.map((item) => item.name)).toEqual(['b.txt']);
	});

	it('reports an empty folder rather than inventing entries', () => {
		expect(buildStorageTree(files, 'nowhere')).toEqual({
			folders: [],
			files: [],
		});
	});

	it('sorts files by name regardless of the order they arrive in', () => {
		const tree = buildStorageTree(
			[entry('z.txt', 'x'), entry('A.txt', 'x'), entry('m.txt', 'x')],
			'x',
		);

		expect(tree.files.map((item) => item.name)).toEqual([
			'A.txt',
			'm.txt',
			'z.txt',
		]);
	});
});

describe('Breadcrumb', () => {
	it('accumulates the path of every segment', () => {
		expect(storageBreadcrumb('work/reports/2026')).toEqual([
			{ label: 'work', path: 'work' },
			{ label: 'reports', path: 'work/reports' },
			{ label: '2026', path: 'work/reports/2026' },
		]);
	});

	it('has no segments at the root', () => {
		expect(storageBreadcrumb(null)).toEqual([]);
	});
});

describe('Name validation', () => {
	it.each([
		['an empty name', '   ', 'Enter a name.'],
		['a path separator', 'a/b.txt', 'A name cannot contain / or \\.'],
		['a backslash', 'a\\b.txt', 'A name cannot contain / or \\.'],
		['a lone dot', '.', 'Enter a valid name.'],
		['a parent reference', '..', 'Enter a valid name.'],
	])('rejects %s', (_case, name, message) => {
		expect(validateFileName(name)).toBe(message);
	});

	it('accepts an ordinary name', () => {
		expect(validateFileName('Informe año 2026.pdf')).toBeUndefined();
	});

	it('rejects a name longer than storage records', () => {
		expect(validateFileName('a'.repeat(256))).toBe('That name is too long.');
	});

	it('rejects a folder name that would nest another level', () => {
		expect(validateFolderName('a/b')).toBe('A name cannot contain / or \\.');
	});
});

describe('Duplicate detection', () => {
	const files = [entry('Report.PDF', 'work'), entry('other.txt', 'personal')];

	it('matches ignoring case, like the server does', () => {
		expect(isDuplicateName(files, 'work', 'report.pdf')).toBe(true);
		expect(isDuplicateName(files, 'WORK', 'report.pdf')).toBe(true);
	});

	it('allows the same name in a different folder', () => {
		expect(isDuplicateName(files, 'personal', 'report.pdf')).toBe(false);
	});

	it('ignores the file being renamed', () => {
		expect(
			isDuplicateName(files, 'work', 'report.pdf', 'work/Report.PDF'),
		).toBe(false);
	});
});

/**
 * The type of a file is what storage records it as, never something inferred
 * from its name: renaming `photo.png` to `photo` changes nothing about what the
 * file is, and a type that disappears on rename is a type that was never read.
 */
describe('File types', () => {
	it.each([
		['application/pdf', 'PDF'],
		['image/png', 'PNG'],
		['image/jpeg', 'JPEG'],
		['image/svg+xml', 'SVG'],
		['video/mp4', 'MP4'],
		['audio/mpeg', 'MPEG'],
		['text/csv', 'CSV'],
		['text/plain', 'Text'],
		['text/markdown', 'Markdown'],
		['application/json', 'JSON'],
		['application/zip', 'ZIP'],
		[
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			'Word',
		],
		[
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'Excel',
		],
		[
			'application/vnd.openxmlformats-officedocument.presentationml.presentation',
			'PowerPoint',
		],
		// Registry bookkeeping is stripped before the subtype is shown.
		['application/vnd.appimage', 'AppImage'],
		['application/x-flac', 'FLAC'],
		['application/x-msdownload', 'EXE'],
		['application/vnd.android.package-archive', 'APK'],
		// A vendor type nobody recognises says less than its category does.
		['application/vnd.acme.invoice-v2', 'File'],
		['image/vnd.acme.raw-sensor', 'Image'],
		['application/octet-stream', 'File'],
	])('reads %s as %s', (contentType, expected) => {
		expect(fileTypeLabel(contentType)).toBe(expected);
	});

	it('ignores the parameters of a content type', () => {
		expect(fileTypeLabel('text/plain; charset=utf-8')).toBe('Text');
	});

	it('collects each type once, however the files are named', () => {
		expect(
			collectFileTypes([
				entry('slides', null, 'application/pdf'),
				entry('report.pdf', null, 'application/pdf'),
				entry('photo', 'work', 'image/png'),
			]),
		).toEqual(['PDF', 'PNG']);
	});
});

/**
 * Storage refuses a duplicate name and says so, which is the right answer when
 * someone is uploading on purpose. Inserting an image into a note is not that
 * moment: two notes both holding a `screenshot.png` is ordinary, and a dead end
 * in the editor is not.
 */
describe('Unique file names', () => {
	const existing = [
		entry('screenshot.png', 'Notes'),
		entry('screenshot (2).png', 'Notes'),
		entry('README', 'Notes'),
		entry('elsewhere.png', 'work'),
	];

	it.each([
		['a free name', 'diagram.png', 'diagram.png'],
		['a taken name', 'screenshot.png', 'screenshot (3).png'],
		// Uniqueness is case-insensitive like the server's, but the name the user
		// gave the file is theirs and survives intact.
		['a name taken in another case', 'SCREENSHOT.PNG', 'SCREENSHOT (3).PNG'],
		['a name with no extension', 'README', 'README (2)'],
		['a compound extension', 'archive.tar.gz', 'archive.tar.gz'],
	])('resolves %s', (_case, name, expected) => {
		expect(uniqueFileName(existing, 'Notes', name)).toBe(expected);
	});

	it('only counts names in the destination folder', () => {
		expect(uniqueFileName(existing, 'work', 'screenshot.png')).toBe(
			'screenshot.png',
		);
	});

	it('keeps the suffix before the extension so the type survives', () => {
		expect(uniqueFileName([entry('a.png', null)], null, 'a.png')).toBe(
			'a (2).png',
		);
	});
});

describe('Folder drop targets', () => {
	it.each([
		['a sibling folder', 'work/reports', 'archive', true],
		['the root', 'work', null, false],
		['a folder into itself', 'work', 'work', false],
		['a folder into its own descendant', 'work', 'work/reports', false],
		['a folder into where it already is', 'work/reports', 'work', false],
		['a folder into a lookalike prefix', 'work', 'workbench', true],
		['a nested folder up to the root', 'work/reports', null, true],
	])('%s', (_case, source, target, expected) => {
		expect(canDropFolder(source, target)).toBe(expected);
	});
});

describe('Storage view parameters', () => {
	it('parses a complete view from the URL', () => {
		const view = parseStorageView(
			new URLSearchParams(
				'path=work&q=invoice&types=pdf,word&visibility=public&uploaded=30d&source=notes&sort=path-asc&file=abc',
			),
		);

		expect(view).toEqual({
			path: 'work',
			query: 'invoice',
			types: ['pdf', 'word'],
			visibility: 'public',
			uploaded: '30d',
			source: 'notes',
			sort: 'path-asc',
			file: 'abc',
		});
	});

	it('falls back safely when URL values are unknown', () => {
		expect(
			parseStorageView(
				new URLSearchParams(
					'visibility=secret&uploaded=forever&source=elsewhere&sort=random',
				),
			),
		).toEqual({
			path: null,
			query: '',
			types: [],
			visibility: 'all',
			uploaded: 'any',
			source: 'all',
			sort: 'newest',
			file: null,
		});
	});

	it('changes one concern while preserving every other parameter', () => {
		const current = new URLSearchParams(
			'path=work&q=invoice&types=pdf&visibility=private&sort=newest',
		);

		expect(
			updateStorageSearchParams(current, { path: 'work/2026' }).toString(),
		).toBe(
			'path=work%2F2026&q=invoice&types=pdf&visibility=private&sort=newest',
		);
		expect(updateStorageSearchParams(current, { query: '' }).toString()).toBe(
			'path=work&types=pdf&visibility=private&sort=newest',
		);
	});
});

describe('Storage filtering', () => {
	const now = Date.UTC(2026, 7, 9, 12);
	const files = [
		{
			...entry('invoice.pdf', 'work', 'application/pdf'),
			createdAt: now - 60_000,
			size: 30,
		},
		{
			...entry(
				'slides.pptx',
				'work/presentations',
				'application/vnd.openxmlformats-officedocument.presentationml.presentation',
			),
			createdAt: now - 2 * 86_400_000,
			size: 20,
			isPublic: true,
		},
		{
			...entry('invoice.xlsx', 'work/archive', 'text/csv'),
			createdAt: now - 20 * 86_400_000,
			size: 10,
		},
		{ ...entry('private.pdf', 'personal'), createdAt: now - 400 * 86_400_000 },
	];

	it('searches names and paths recursively below the open folder', () => {
		expect(
			filterStorageFiles(files, 'work', { query: 'invoice' }, now).map(
				(item) => item.name,
			),
		).toEqual(['invoice.pdf', 'invoice.xlsx']);
		expect(
			filterStorageFiles(files, 'work', { query: 'presentations' }, now).map(
				(item) => item.name,
			),
		).toEqual(['slides.pptx']);
	});

	it('never leaks results from outside the open folder', () => {
		expect(
			filterStorageFiles(files, 'work', { query: 'private' }, now),
		).toEqual([]);
	});

	/**
	 * Where a file came from is a property of the file, so it filters like every
	 * other one. `notes-unused` is the exception the UI has to know about: the
	 * set comes from the server, and the client only narrows it further.
	 */
	it('filters by where the file came from', () => {
		const mixed = [
			{ ...entry('manual.pdf', 'work', 'application/pdf') },
			{
				...entry('attached.png', 'Notes', 'image/png'),
				uploadedFromNotes: true,
			},
		];

		expect(
			filterStorageFiles(mixed, null, { source: 'notes' }, now).map(
				(item) => item.name,
			),
		).toEqual(['attached.png']);
		expect(
			filterStorageFiles(mixed, null, { source: 'manual' }, now).map(
				(item) => item.name,
			),
		).toEqual(['manual.pdf']);
		expect(
			filterStorageFiles(mixed, null, { source: 'all' }, now),
		).toHaveLength(2);
		// The server already narrowed it; narrowing again must not drop anything.
		expect(
			filterStorageFiles(mixed, null, { source: 'notes-unused' }, now).map(
				(item) => item.name,
			),
		).toEqual(['attached.png']);
	});

	it('filters by recorded type, visibility and upload window', () => {
		expect(
			filterStorageFiles(
				files,
				'work',
				{ types: ['powerpoint'], visibility: 'public', uploaded: '7d' },
				now,
			).map((item) => item.name),
		).toEqual(['slides.pptx']);
		expect(
			filterStorageFiles(files, 'work', { uploaded: 'today' }, now).map(
				(item) => item.name,
			),
		).toEqual(['invoice.pdf']);
	});
});

describe('Storage sorting', () => {
	const files = [
		{ ...entry('beta.txt', 'z'), size: 20, createdAt: 20 },
		{ ...entry('Alpha.txt', 'a/deep'), size: 30, createdAt: 10 },
		{ ...entry('charlie.txt', 'a'), size: 10, createdAt: 30 },
	];

	it.each([
		['name-asc', ['Alpha.txt', 'beta.txt', 'charlie.txt']],
		['name-desc', ['charlie.txt', 'beta.txt', 'Alpha.txt']],
		['path-asc', ['charlie.txt', 'Alpha.txt', 'beta.txt']],
		['newest', ['charlie.txt', 'beta.txt', 'Alpha.txt']],
		['oldest', ['Alpha.txt', 'beta.txt', 'charlie.txt']],
		['size-desc', ['Alpha.txt', 'beta.txt', 'charlie.txt']],
		['size-asc', ['charlie.txt', 'beta.txt', 'Alpha.txt']],
	] as const)('sorts by %s', (sort, expected) => {
		expect(sortStorageFiles(files, sort).map((item) => item.name)).toEqual(
			expected,
		);
	});

	it('does not mutate the server index', () => {
		const before = files.map((item) => item.name);
		sortStorageFiles(files, 'name-asc');
		expect(files.map((item) => item.name)).toEqual(before);
	});
});

describe('Storage summaries and move targets', () => {
	const files = [
		entry('root.txt', null),
		entry('a.txt', 'work'),
		entry('b.txt', 'work/reports/2026'),
		entry('c.txt', 'personal'),
	];

	it('summarizes exactly the files on screen', () => {
		expect(storageSummary(files.slice(0, 3))).toEqual({ count: 3, size: 30 });
	});

	it('derives every real folder and includes the root once', () => {
		expect(collectFolderPaths(files)).toEqual([
			null,
			'personal',
			'work',
			'work/reports',
			'work/reports/2026',
		]);
	});
});

describe('Storage paths', () => {
	it.each([
		['', null],
		[' /work/reports/ ', 'work/reports'],
		['work/reports', 'work/reports'],
		['  personal  ', 'personal'],
	])('normalizes %j to %j', (input, expected) => {
		expect(normalizeStoragePath(input)).toBe(expected);
	});

	it.each([
		['work/reports', undefined],
		['proyectos/año', undefined],
		['work//reports', 'A path cannot contain empty segments.'],
		['work/../reports', 'A path cannot contain . or .. segments.'],
		['work\\reports', 'A path cannot contain backslashes.'],
	])('validates %j', (path, expected) => {
		expect(validateStoragePath(path)).toBe(expected);
	});

	it.each([
		[null, null],
		['work', null],
		['work/reports', 'work'],
		['work/reports/2026', 'work/reports'],
	])('finds the parent of %j', (path, expected) => {
		expect(parentFolder(path)).toBe(expected);
	});
});

describe('Storage selection', () => {
	it('keeps only ids that still exist after refresh', () => {
		expect(
			reconcileStorageSelection(new Set(['kept', 'gone']), [
				{ ...entry('kept.txt', null), id: 'kept' },
			]),
		).toEqual(new Set(['kept']));
	});
});
