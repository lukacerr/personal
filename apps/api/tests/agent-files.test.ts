import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
	ATTACHMENT_LIMITS,
	capExtractedText,
	EXTRACT_MAX_CHARS,
	extractFileText,
	fileKind,
	fileReadModelOutput,
	gotenbergOverride,
	liftToolImagesToUserMessages,
	readFileForAgent,
} from '@api/agent-files';
import { db, storage } from '@api/env';
import { derivedPdfKey, objectKey } from '@api/files-storage';
import { file } from '@api/schema';
import type { ModelMessage } from 'ai';
import { randomUUIDv7 } from 'bun';
import { inArray } from 'drizzle-orm';

const DOCX_TYPE =
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_TYPE =
	'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX_TYPE =
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const fixture = (name: string) =>
	Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).bytes();

const seededIds = new Set<string>();

async function seedFile(options: {
	name: string;
	contentType: string;
	bytes?: Uint8Array | string;
	size?: number;
	path?: string | null;
}) {
	const id = randomUUIDv7();
	seededIds.add(id);
	const body = options.bytes ?? 'file-body';
	await storage.write(objectKey(id), body);
	const size =
		options.size ??
		(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength);
	await db.insert(file).values({
		id,
		name: options.name,
		// The table is unique on (path, name); a folder per row keeps the
		// fixture names readable without colliding across tests.
		path: options.path ?? `agent-files-test/${id}`,
		contentType: options.contentType,
		size,
	});
	return id;
}

afterEach(() => {
	gotenbergOverride.url = undefined;
});

afterAll(async () => {
	const ids = [...seededIds];
	if (ids.length === 0) return;
	await db.delete(file).where(inArray(file.id, ids));
	await Promise.allSettled(
		ids.flatMap((id) => [
			storage.delete(objectKey(id)),
			storage.delete(derivedPdfKey(id)),
		]),
	);
});

describe('fileKind', () => {
	const cases: [string, string][] = [
		['image/png', 'image'],
		['image/jpeg', 'image'],
		['image/gif', 'image'],
		['image/webp', 'image'],
		['application/pdf', 'pdf'],
		[DOCX_TYPE, 'docx'],
		[PPTX_TYPE, 'pptx'],
		[XLSX_TYPE, 'xlsx'],
		['text/plain', 'text'],
		['text/csv', 'text'],
		['text/markdown', 'text'],
		['application/json', 'text'],
		['application/xml', 'text'],
		['image/svg+xml', 'text'],
		['video/mp4', 'unsupported'],
		['application/zip', 'unsupported'],
		['application/vnd.ms-excel', 'unsupported'],
		['application/msword', 'unsupported'],
	];
	test.each(cases)('%s → %s', (contentType, kind) => {
		expect(fileKind(contentType)).toBe(kind as ReturnType<typeof fileKind>);
	});
});

describe('capExtractedText', () => {
	test('short text passes through untouched', () => {
		expect(capExtractedText('hello')).toBe('hello');
	});

	test('long text is capped with a truncation notice', () => {
		const long = 'x'.repeat(EXTRACT_MAX_CHARS + 500);
		const capped = capExtractedText(long);
		expect(capped.length).toBeLessThan(long.length);
		expect(capped).toStartWith('x'.repeat(100));
		expect(capped).toContain(`${EXTRACT_MAX_CHARS}`);
		expect(capped).toContain(`${long.length}`);
	});
});

describe('extractFileText', () => {
	test('docx yields its paragraphs as text', async () => {
		const text = await extractFileText('docx', await fixture('sample.docx'));
		expect(text).toContain('XYLOPHONE-77');
		expect(text).toContain('Quarterly Report Alpha');
	});

	test('xlsx yields every sheet as CSV with quoting', async () => {
		const text = await extractFileText('xlsx', await fixture('sample.xlsx'));
		expect(text).toContain('Budget');
		expect(text).toContain('Notes');
		expect(text).toContain('"Groceries, weekly",340.5');
		expect(text).toContain('Rent,1200');
	});

	test('text decodes as UTF-8', async () => {
		const text = await extractFileText(
			'text',
			new TextEncoder().encode('café ☕'),
		);
		expect(text).toBe('café ☕');
	});
});

describe('readFileForAgent', () => {
	test('an image resolves to small metadata, never bytes', async () => {
		const id = await seedFile({
			name: 'photo.png',
			contentType: 'image/png',
			bytes: new Uint8Array([137, 80, 78, 71]),
		});
		const output = await readFileForAgent(id);
		expect(output).toEqual({
			fileId: id,
			name: 'photo.png',
			mediaType: 'image/png',
			size: 4,
			kind: 'image',
			converted: false,
		});
	});

	test('an unknown id names the failure', async () => {
		expect(readFileForAgent(randomUUIDv7())).rejects.toThrow(/not found/i);
	});

	test('an oversize image names the limit instead of reading it', async () => {
		const id = await seedFile({
			name: 'huge.png',
			contentType: 'image/png',
			size: ATTACHMENT_LIMITS.image + 1,
		});
		expect(readFileForAgent(id)).rejects.toThrow(/too large/i);
	});

	test('an unsupported format says so', async () => {
		const id = await seedFile({ name: 'movie.mp4', contentType: 'video/mp4' });
		expect(readFileForAgent(id)).rejects.toThrow(/not supported/i);
	});

	test('xlsx validates its extraction at read time', async () => {
		const id = await seedFile({
			name: 'budget.xlsx',
			contentType: XLSX_TYPE,
			bytes: await fixture('sample.xlsx'),
		});
		const output = await readFileForAgent(id);
		expect(output.kind).toBe('xlsx');
		expect(output.converted).toBe(false);
	});

	test('docx converts through Gotenberg and caches the derived PDF', async () => {
		const id = await seedFile({
			name: 'report.docx',
			contentType: DOCX_TYPE,
			bytes: await fixture('sample.docx'),
		});
		const output = await readFileForAgent(id);
		expect(output.kind).toBe('docx');
		expect(output.converted).toBe(true);
		const derived = await storage.file(derivedPdfKey(id)).bytes();
		expect(new TextDecoder().decode(derived.slice(0, 5))).toBe('%PDF-');

		// A second read reuses the derived object instead of converting again.
		gotenbergOverride.url = null;
		const again = await readFileForAgent(id);
		expect(again.converted).toBe(true);
	});

	test('pptx converts through Gotenberg', async () => {
		const id = await seedFile({
			name: 'deck.pptx',
			contentType: PPTX_TYPE,
			bytes: await fixture('sample.pptx'),
		});
		const output = await readFileForAgent(id);
		expect(output.converted).toBe(true);
	});

	test('docx without a converter degrades to text extraction', async () => {
		gotenbergOverride.url = null;
		const id = await seedFile({
			name: 'report.docx',
			contentType: DOCX_TYPE,
			bytes: await fixture('sample.docx'),
		});
		const output = await readFileForAgent(id);
		expect(output.converted).toBe(false);
	});

	test('pptx without a converter is an explicit failure', async () => {
		gotenbergOverride.url = null;
		const id = await seedFile({
			name: 'deck.pptx',
			contentType: PPTX_TYPE,
			bytes: await fixture('sample.pptx'),
		});
		expect(readFileForAgent(id)).rejects.toThrow(/conver/i);
	});

	test('an unreachable converter surfaces as a clear failure', async () => {
		gotenbergOverride.url = 'http://127.0.0.1:9';
		const id = await seedFile({
			name: 'deck.pptx',
			contentType: PPTX_TYPE,
			bytes: await fixture('sample.pptx'),
		});
		expect(readFileForAgent(id)).rejects.toThrow();
	});
});

describe('fileReadModelOutput', () => {
	const meta = (
		overrides: Partial<Parameters<typeof fileReadModelOutput>[0]>,
	) => ({
		fileId: randomUUIDv7(),
		name: 'file.bin',
		mediaType: 'application/octet-stream',
		size: 4,
		kind: 'text' as const,
		converted: false,
		...overrides,
	});

	test('an image reaches a vision model as a file part', async () => {
		const bytes = new Uint8Array([137, 80, 78, 71]);
		const id = await seedFile({
			name: 'photo.png',
			contentType: 'image/png',
			bytes,
		});
		const output = await fileReadModelOutput(
			meta({
				fileId: id,
				name: 'photo.png',
				mediaType: 'image/png',
				kind: 'image',
			}),
			{ image: true, pdf: true },
		);
		if (output.type !== 'content') throw new Error(`got ${output.type}`);
		const filePart = output.value.find((part) => part.type === 'file');
		if (filePart?.type !== 'file') throw new Error('missing file part');
		expect(filePart.mediaType).toBe('image/png');
		expect(filePart.filename).toBe('photo.png');
	});

	test('an image degrades to a text placeholder without vision', async () => {
		const id = await seedFile({ name: 'photo.png', contentType: 'image/png' });
		const output = await fileReadModelOutput(
			meta({
				fileId: id,
				name: 'photo.png',
				mediaType: 'image/png',
				kind: 'image',
			}),
			{ image: false, pdf: false },
		);
		if (output.type !== 'text') throw new Error(`got ${output.type}`);
		expect(output.value).toContain('not viewable');
		expect(output.value).toContain(id);
	});

	test('a pdf reaches a capable model as a document', async () => {
		const id = await seedFile({
			name: 'doc.pdf',
			contentType: 'application/pdf',
			bytes: new TextEncoder().encode('%PDF-1.7 fake'),
		});
		const output = await fileReadModelOutput(
			meta({
				fileId: id,
				name: 'doc.pdf',
				mediaType: 'application/pdf',
				kind: 'pdf',
			}),
			{ image: true, pdf: true },
		);
		if (output.type !== 'content') throw new Error(`got ${output.type}`);
		const filePart = output.value.find((part) => part.type === 'file');
		if (filePart?.type !== 'file') throw new Error('missing file part');
		expect(filePart.mediaType).toBe('application/pdf');
	});

	test('a converted docx is delivered as its derived PDF', async () => {
		const id = await seedFile({
			name: 'report.docx',
			contentType: DOCX_TYPE,
			bytes: await fixture('sample.docx'),
		});
		await storage.write(derivedPdfKey(id), '%PDF-1.7 derived');
		const output = await fileReadModelOutput(
			meta({
				fileId: id,
				name: 'report.docx',
				mediaType: DOCX_TYPE,
				kind: 'docx',
				converted: true,
			}),
			{ image: true, pdf: true },
		);
		if (output.type !== 'content') throw new Error(`got ${output.type}`);
		const filePart = output.value.find((part) => part.type === 'file');
		if (filePart?.type !== 'file') throw new Error('missing file part');
		expect(filePart.mediaType).toBe('application/pdf');
	});

	test('a docx falls back to extracted text without pdf support', async () => {
		const id = await seedFile({
			name: 'report.docx',
			contentType: DOCX_TYPE,
			bytes: await fixture('sample.docx'),
		});
		const output = await fileReadModelOutput(
			meta({
				fileId: id,
				name: 'report.docx',
				mediaType: DOCX_TYPE,
				kind: 'docx',
				converted: true,
			}),
			{ image: false, pdf: false },
		);
		if (output.type !== 'text') throw new Error(`got ${output.type}`);
		expect(output.value).toContain('XYLOPHONE-77');
	});

	test('a pptx without pdf support degrades to a placeholder', async () => {
		const output = await fileReadModelOutput(
			meta({
				name: 'deck.pptx',
				mediaType: PPTX_TYPE,
				kind: 'pptx',
				converted: true,
			}),
			{ image: false, pdf: false },
		);
		if (output.type !== 'text') throw new Error(`got ${output.type}`);
		expect(output.value).toContain('not viewable');
	});

	test('an xlsx is delivered as text for every model', async () => {
		const id = await seedFile({
			name: 'budget.xlsx',
			contentType: XLSX_TYPE,
			bytes: await fixture('sample.xlsx'),
		});
		const output = await fileReadModelOutput(
			meta({
				fileId: id,
				name: 'budget.xlsx',
				mediaType: XLSX_TYPE,
				kind: 'xlsx',
			}),
			{ image: true, pdf: true },
		);
		if (output.type !== 'text') throw new Error(`got ${output.type}`);
		expect(output.value).toContain('Rent,1200');
	});

	test('a deleted object degrades to text instead of throwing', async () => {
		const output = await fileReadModelOutput(
			meta({ name: 'gone.png', mediaType: 'image/png', kind: 'image' }),
			{ image: true, pdf: true },
		);
		if (output.type !== 'text') throw new Error(`got ${output.type}`);
		expect(output.value).toContain('no longer readable');
	});
});

/**
 * Where a tool result cannot carry bytes (openai-compatible stringifies the
 * content array), the images move to the user message after it. This runs on
 * every step of a request, so it also has to leave an already-lifted prompt
 * alone.
 */
describe('lifting images out of tool results', () => {
	const toolMessage = (): ModelMessage => ({
		role: 'tool',
		content: [
			{
				type: 'tool-result',
				toolCallId: 'call-1',
				toolName: 'storageRead',
				output: {
					type: 'content',
					value: [
						{ type: 'text', text: 'File "photo.png" (image/png, 8 bytes):' },
						{
							type: 'file',
							data: { type: 'data', data: new Uint8Array([1, 2, 3]) },
							mediaType: 'image/png',
							filename: 'photo.png',
						},
					],
				},
			},
		],
	});

	test('moves the bytes to a following user message and says so', () => {
		const lifted = liftToolImagesToUserMessages([
			{ role: 'user', content: 'mirá' },
			toolMessage(),
		]);

		expect(lifted).toHaveLength(3);
		const [, tool, carrier] = lifted;
		expect(JSON.stringify(tool)).toContain('next message');
		expect(JSON.stringify(tool)).not.toContain('"type":"file"');
		expect(carrier?.role).toBe('user');
		expect(JSON.stringify(carrier)).toContain('image/png');
	});

	test('is a no-op on a prompt it already lifted', () => {
		const once = liftToolImagesToUserMessages([toolMessage()]);
		expect(liftToolImagesToUserMessages(once)).toEqual(once);
	});

	test('leaves text-only tool results untouched', () => {
		const text: ModelMessage[] = [
			{
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: 'call-1',
						toolName: 'storageRead',
						output: { type: 'text', value: 'plain' },
					},
				],
			},
		];
		expect(liftToolImagesToUserMessages(text)).toEqual(text);
	});
});
