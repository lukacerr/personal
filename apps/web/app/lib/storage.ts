import type { StoredFile } from '@web/lib/storage-api';
import {
	FileArchiveIcon,
	FileAudioIcon,
	FileIcon,
	FileSpreadsheetIcon,
	FileTextIcon,
	FileVideoIcon,
	ImageIcon,
} from 'lucide-react';

/** Rounded to two decimals and trimmed, so 1024 reads as `1 KB`, not `1.00 KB`. */
export function formatBytes(size: number) {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = size;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${Number(value.toFixed(2))} ${units[unit]}`;
}

export type PreviewKind =
	| 'image'
	| 'video'
	| 'audio'
	| 'pdf'
	| 'text'
	| 'sheet'
	| 'document'
	| 'unknown';

const TEXT_TYPES = new Set([
	'application/json',
	'application/xml',
	'application/javascript',
	'application/x-yaml',
]);

const SHEET_TYPES = new Set([
	'text/csv',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const DOCUMENT_TYPES = new Set([
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

/**
 * How a file should be previewed. Anything unrecognised is `unknown`, which
 * renders an honest card with a download button rather than a broken viewer.
 */
export function previewKind(contentType: string): PreviewKind {
	const type = contentType.split(';')[0]?.trim().toLocaleLowerCase() ?? '';

	if (SHEET_TYPES.has(type)) return 'sheet';
	if (DOCUMENT_TYPES.has(type)) return 'document';
	if (type === 'application/pdf') return 'pdf';
	if (type.startsWith('image/')) return 'image';
	if (type.startsWith('video/')) return 'video';
	if (type.startsWith('audio/')) return 'audio';
	if (type.startsWith('text/') || TEXT_TYPES.has(type)) return 'text';
	return 'unknown';
}

/**
 * The first bytes of a response as text, hanging up once it has enough.
 *
 * A preview shows the head of a file, so downloading the rest of a half-gigabyte
 * log costs the user their bandwidth for something no one will read. Cancelling
 * the reader ends the transfer rather than merely ignoring what arrives.
 */
export async function readTextPrefix(response: Response, limit: number) {
	const reader = response.body?.getReader();
	if (!reader) return (await response.text()).slice(0, limit);

	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < limit) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		chunks.push(value);
		size += value.byteLength;
	}
	await reader.cancel().catch(() => undefined);

	const merged = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged.slice(0, limit));
}

/** The icon that stands for a file, shared by the explorer and by Notes. */
export function fileTypeIcon(contentType: string) {
	switch (previewKind(contentType)) {
		case 'image':
			return ImageIcon;
		case 'video':
			return FileVideoIcon;
		case 'audio':
			return FileAudioIcon;
		case 'sheet':
			return FileSpreadsheetIcon;
		case 'pdf':
		case 'document':
		case 'text':
			return FileTextIcon;
		default:
			return contentType.includes('zip') ? FileArchiveIcon : FileIcon;
	}
}

export type StorageTree = { folders: string[]; files: StoredFile[] };

export const storageSorts = [
	'name-asc',
	'name-desc',
	'path-asc',
	'newest',
	'oldest',
	'size-desc',
	'size-asc',
] as const;

export type StorageSort = (typeof storageSorts)[number];
export type StorageVisibility = 'all' | 'public' | 'private';
export type StorageUploaded = 'any' | 'today' | '7d' | '30d' | '1y';

/**
 * Where a file came from. `notes-unused` is the one value the client cannot
 * answer on its own: only the server knows which Notes uploads no note
 * references anymore, so it supplies the set and the rest of the filters
 * narrow it from there.
 */
export type StorageSource = 'all' | 'notes' | 'manual' | 'notes-unused';

export type StorageView = {
	path: string | null;
	query: string;
	types: string[];
	visibility: StorageVisibility;
	uploaded: StorageUploaded;
	source: StorageSource;
	sort: StorageSort;
	/** The file whose preview is open, so a link to it can be shared. */
	file: string | null;
};

const storageVisibilities = new Set<StorageVisibility>([
	'all',
	'public',
	'private',
]);
const storageUploadedWindows = new Set<StorageUploaded>([
	'any',
	'today',
	'7d',
	'30d',
	'1y',
]);
const storageSortSet = new Set<StorageSort>(storageSorts);
const storageSources = new Set<StorageSource>([
	'all',
	'notes',
	'manual',
	'notes-unused',
]);

/** Types whose subtype is unreadable, and types a person calls something else. */
const TYPE_LABELS: Record<string, string> = {
	'application/gzip': 'GZIP',
	'application/msword': 'Word',
	'application/octet-stream': 'File',
	'application/vnd.android.package-archive': 'APK',
	'application/vnd.appimage': 'AppImage',
	'application/vnd.microsoft.portable-executable': 'EXE',
	'application/vnd.ms-excel': 'Excel',
	'application/vnd.ms-powerpoint': 'PowerPoint',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation':
		'PowerPoint',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
		'Word',
	'application/x-7z-compressed': '7z',
	'application/x-debian-package': 'DEB',
	'application/x-iso9660-image': 'ISO',
	'application/x-msdownload': 'EXE',
	'application/x-rar-compressed': 'RAR',
	'application/x-zip-compressed': 'ZIP',
	'text/markdown': 'Markdown',
	'text/plain': 'Text',
};

const TYPE_CATEGORIES: Record<string, string> = {
	audio: 'Audio',
	image: 'Image',
	text: 'Text',
	video: 'Video',
};

/**
 * What a file is, according to what storage recorded when it arrived.
 *
 * Never derived from the name: renaming `photo.png` to `photo` changes nothing
 * about the bytes, and a type read off the name vanishes the moment someone
 * drops the extension. A vendor subtype nobody recognises says less than its
 * category does, so those fall back rather than being printed raw.
 */
export function fileTypeLabel(contentType: string) {
	const type = contentType.split(';')[0]?.trim().toLocaleLowerCase() ?? '';
	const known = TYPE_LABELS[type];
	if (known) return known;

	// `vnd.` and `x-` are registry bookkeeping, not something to show anyone.
	const [category = '', subtype = ''] = type.split('/');
	const short =
		subtype
			.split('+')[0]
			?.replace(/^x-/, '')
			.replace(/^vnd\./, '') ?? '';
	if (short.length > 0 && short.length <= 8 && /^[a-z0-9-]+$/.test(short))
		return short.toLocaleUpperCase();

	return TYPE_CATEGORIES[category] ?? 'File';
}

/** Every type present, exactly once, for the filter to offer. */
export function collectFileTypes(files: StoredFile[]) {
	return [
		...new Set(files.map((item) => fileTypeLabel(item.contentType))),
	].sort((a, b) => a.localeCompare(b));
}

export function parseStorageView(params: URLSearchParams): StorageView {
	const visibility = params.get('visibility') as StorageVisibility | null;
	const uploaded = params.get('uploaded') as StorageUploaded | null;
	const source = params.get('source') as StorageSource | null;
	const sort = params.get('sort') as StorageSort | null;
	// Type labels travel lowercased so the URL stays readable; every file has a
	// content type, so there is no empty bucket to encode around.
	const types = [
		...new Set(
			(params.get('types') ?? '')
				.split(',')
				.map((type) => type.trim().toLocaleLowerCase())
				.filter((type) => type !== ''),
		),
	];

	return {
		path: params.get('path') || null,
		query: params.get('q')?.trim() ?? '',
		types,
		visibility:
			visibility && storageVisibilities.has(visibility) ? visibility : 'all',
		uploaded:
			uploaded && storageUploadedWindows.has(uploaded) ? uploaded : 'any',
		source: source && storageSources.has(source) ? source : 'all',
		sort: sort && storageSortSet.has(sort) ? sort : 'newest',
		file: params.get('file') || null,
	};
}

type StorageViewPatch = Partial<{
	path: string | null;
	query: string;
	types: string[];
	visibility: StorageVisibility;
	uploaded: StorageUploaded;
	source: StorageSource;
	sort: StorageSort;
	file: string | null;
}>;

/** Changes one concern without throwing away the rest of the shareable view. */
export function updateStorageSearchParams(
	current: URLSearchParams,
	patch: StorageViewPatch,
) {
	const next = new URLSearchParams(current);
	const values: Array<[keyof StorageViewPatch, string, string | null]> = [
		['path', 'path', patch.path ?? null],
		['query', 'q', patch.query ?? null],
		['types', 'types', patch.types?.join(',') ?? null],
		['visibility', 'visibility', patch.visibility ?? null],
		['uploaded', 'uploaded', patch.uploaded ?? null],
		['source', 'source', patch.source ?? null],
		['sort', 'sort', patch.sort ?? null],
		['file', 'file', patch.file ?? null],
	];

	for (const [field, parameter, value] of values) {
		if (!(field in patch)) continue;
		if (
			value === null ||
			value === '' ||
			(parameter === 'visibility' && value === 'all') ||
			(parameter === 'uploaded' && value === 'any') ||
			(parameter === 'source' && value === 'all') ||
			(parameter === 'sort' && value === 'newest')
		)
			next.delete(parameter);
		else next.set(parameter, value);
	}
	return next;
}

export function hasStorageFilters(view: StorageView) {
	return (
		view.query !== '' ||
		view.types.length > 0 ||
		view.visibility !== 'all' ||
		view.uploaded !== 'any' ||
		view.source !== 'all'
	);
}

/** The set on screen comes from the server rather than from the local index. */
export function needsUnreferencedFiles(view: Pick<StorageView, 'source'>) {
	return view.source === 'notes-unused';
}

function isWithinFolder(item: StoredFile, folder: string | null) {
	if (!folder) return true;
	return item.path === folder || item.path?.startsWith(`${folder}/`) === true;
}

function relativeFilePath(item: StoredFile, folder: string | null) {
	if (!item.path) return item.name;
	if (!folder) return `${item.path}/${item.name}`;
	const relative =
		item.path === folder ? '' : item.path.slice(folder.length + 1);
	return relative ? `${relative}/${item.name}` : item.name;
}

const DAY = 86_400_000;

function uploadedCutoff(window: StorageUploaded, now: number) {
	if (window === 'any') return Number.NEGATIVE_INFINITY;
	if (window === 'today') {
		const date = new Date(now);
		return new Date(
			date.getFullYear(),
			date.getMonth(),
			date.getDate(),
		).getTime();
	}
	if (window === '7d') return now - 7 * DAY;
	if (window === '30d') return now - 30 * DAY;
	return now - 365 * DAY;
}

export function filterStorageFiles(
	files: StoredFile[],
	folder: string | null,
	filters: Partial<
		Pick<StorageView, 'query' | 'types' | 'visibility' | 'uploaded' | 'source'>
	>,
	now = Date.now(),
) {
	const query = filters.query?.trim().toLocaleLowerCase() ?? '';
	const types = new Set(filters.types ?? []);
	const visibility = filters.visibility ?? 'all';
	const source = filters.source ?? 'all';
	const cutoff = uploadedCutoff(filters.uploaded ?? 'any', now);

	return files.filter((item) => {
		if (!isWithinFolder(item, folder)) return false;
		if (
			query &&
			!relativeFilePath(item, folder).toLocaleLowerCase().includes(query)
		)
			return false;
		if (
			types.size > 0 &&
			!types.has(fileTypeLabel(item.contentType).toLocaleLowerCase())
		)
			return false;
		if (visibility === 'public' && !item.isPublic) return false;
		if (visibility === 'private' && item.isPublic) return false;
		// `notes-unused` narrows a set the server already restricted to Notes
		// uploads, so here it means the same thing as `notes`.
		if (source === 'manual' && item.uploadedFromNotes) return false;
		if (source !== 'all' && source !== 'manual' && !item.uploadedFromNotes)
			return false;
		return item.createdAt >= cutoff;
	});
}

export function sortStorageFiles(files: StoredFile[], sort: StorageSort) {
	const direction = sort.endsWith('-desc') ? -1 : 1;
	return [...files].sort((left, right) => {
		let compared = 0;
		if (sort.startsWith('name')) compared = left.name.localeCompare(right.name);
		else if (sort === 'path-asc')
			compared = (left.path ?? '').localeCompare(right.path ?? '');
		else if (sort === 'newest' || sort === 'oldest')
			compared = left.createdAt - right.createdAt;
		else compared = left.size - right.size;

		const ordered =
			sort === 'newest' || sort === 'size-desc'
				? -compared
				: direction * compared;
		return ordered || left.name.localeCompare(right.name);
	});
}

export function storageSummary(files: StoredFile[]) {
	return files.reduce(
		(summary, item) => ({
			count: summary.count + 1,
			size: summary.size + item.size,
		}),
		{ count: 0, size: 0 },
	);
}

/** Every folder implied by every path, plus the root exactly once. */
export function collectFolderPaths(files: StoredFile[]) {
	const paths = new Set<string>();
	for (const item of files) {
		if (!item.path) continue;
		const segments = item.path.split('/');
		for (let depth = 1; depth <= segments.length; depth += 1)
			paths.add(segments.slice(0, depth).join('/'));
	}
	return [null, ...[...paths].sort((a, b) => a.localeCompare(b))];
}

/** Folders are not stored: they are whatever the paths of the files imply. */
export function buildStorageTree(
	files: StoredFile[],
	folder: string | null,
): StorageTree {
	const prefix = folder ? `${folder}/` : '';
	const folders = new Set<string>();
	const contents: StoredFile[] = [];

	for (const item of files) {
		const path = item.path ?? '';
		if (path === (folder ?? '')) {
			contents.push(item);
			continue;
		}
		if (folder !== null && !path.startsWith(prefix)) continue;
		const child = path.slice(prefix.length).split('/')[0];
		if (child) folders.add(child);
	}

	return {
		folders: [...folders].sort((a, b) => a.localeCompare(b)),
		files: contents.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

/** Each segment carries its cumulative path: a name can repeat at other depths. */
export function storageBreadcrumb(folder: string | null) {
	if (!folder) return [];
	const segments = folder.split('/');
	return segments.map((label, depth) => ({
		label,
		path: segments.slice(0, depth + 1).join('/'),
	}));
}

function validateName(value: string) {
	const name = value.trim();
	if (name.length === 0) return 'Enter a name.';
	if (name.includes('/') || name.includes('\\'))
		return 'A name cannot contain / or \\.';
	if (name === '.' || name === '..') return 'Enter a valid name.';
	if (name.length > 255) return 'That name is too long.';
	return undefined;
}

export const validateFileName = validateName;
export const validateFolderName = validateName;

/**
 * A name free to use in that folder, suffixed if it is not.
 *
 * The explorer refuses a duplicate and says so, which is the right answer when
 * someone is uploading on purpose. Attaching a file to a note is not that
 * moment: two notes both holding a `screenshot.png` is ordinary, and stopping
 * the editor to argue about it is not. The suffix goes before the extension so
 * the file keeps being what it is.
 */
export function uniqueFileName(
	files: NamedFile[],
	folder: string | null,
	name: string,
) {
	if (!isDuplicateName(files, folder, name)) return name;

	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : '';

	for (let suffix = 2; suffix < 1000; suffix += 1) {
		const candidate = `${stem} (${suffix})${extension}`;
		if (!isDuplicateName(files, folder, candidate)) return candidate;
	}
	// Vanishingly unlikely, and the server would reject it anyway rather than
	// silently overwrite something.
	return `${stem} (${crypto.randomUUID().slice(0, 8)})${extension}`;
}

/** Only what a name check reads, so a not-yet-uploaded file can be counted. */
type NamedFile = Pick<StoredFile, 'id' | 'name' | 'path'>;

/** Mirrors the server's case-insensitive uniqueness so the UI can say so first. */
export function isDuplicateName(
	files: NamedFile[],
	folder: string | null,
	name: string,
	exceptId?: string,
) {
	const target = name.trim().toLocaleLowerCase();
	return files.some(
		(item) =>
			item.id !== exceptId &&
			(item.path ?? '').toLocaleLowerCase() ===
				(folder ?? '').toLocaleLowerCase() &&
			item.name.toLocaleLowerCase() === target,
	);
}

/** Outer slashes are presentation noise; inner structure remains significant. */
export function normalizeStoragePath(value: string) {
	const normalized = value.trim().replace(/^\/+|\/+$/g, '');
	return normalized || null;
}

export function validateStoragePath(value: string) {
	if (value.includes('\\')) return 'A path cannot contain backslashes.';
	const path = normalizeStoragePath(value);
	if (!path) return undefined;
	if (path.length > 1024) return 'That path is too long.';
	const segments = path.split('/');
	if (segments.some((segment) => segment === ''))
		return 'A path cannot contain empty segments.';
	if (segments.some((segment) => segment === '.' || segment === '..'))
		return 'A path cannot contain . or .. segments.';
	return undefined;
}

export function reconcileStorageSelection(
	selected: Set<string>,
	files: StoredFile[],
) {
	const existing = new Set(files.map((item) => item.id));
	return new Set([...selected].filter((id) => existing.has(id)));
}

/**
 * What a bulk selection is scoped to. A change in any of these replaces the
 * files on screen, so it must also clear the selection — a filter left out of
 * this key lets the bulk bar act on files that are no longer visible.
 */
export function storageSelectionKey(
	view: Pick<
		StorageView,
		'path' | 'types' | 'visibility' | 'uploaded' | 'source'
	>,
	query: string,
) {
	return [
		view.path ?? '',
		query,
		view.types.join(','),
		view.visibility,
		view.uploaded,
		view.source,
	].join('\0');
}

export function joinPath(folder: string | null, segment: string) {
	return folder ? `${folder}/${segment}` : segment;
}

export function parentFolder(folder: string | null) {
	if (!folder) return null;
	const segments = folder.split('/');
	segments.pop();
	return segments.length > 0 ? segments.join('/') : null;
}

/** How a move turned out, for the caller to phrase however it needs to. */
export type FileMoveResult = 'moved' | 'same' | 'conflict' | 'failed';

/**
 * Whether a folder can be dropped on a destination. A folder cannot land inside
 * itself or anything below it — that renames a prefix onto its own descendants
 * and there is no sane result — and dropping it back where it already is is
 * work with no effect. The trailing slash matters: `work` is not inside
 * `workbench`.
 */
export function canDropFolder(source: string, target: string | null) {
	if (target === source) return false;
	if (target?.startsWith(`${source}/`)) return false;
	return parentFolder(source) !== target;
}
