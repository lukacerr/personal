/**
 * How the agent's read tool turns a stored file into something a model can
 * see. The split matters: `readFileForAgent` runs once, inside the tool's
 * `execute`, and returns only small metadata — that is what persists in the
 * thread and what every budget (prompt window, Redis cache, compaction
 * transcript) measures. The heavy content is produced by
 * `fileReadModelOutput`, which `toModelOutput` calls while building the
 * provider prompt on every turn, so it must be deterministic (stable bytes
 * keep Anthropic's prefix cache valid) and it must never throw (a throw there
 * poisons every future turn of the thread).
 */
import type { AttachmentSupport } from '@api/agent-models';
import { db, env, storage } from '@api/env';
import { derivedPdfKey, objectKey } from '@api/files-storage';
import { file } from '@api/schema';
import type { FilePart, ModelMessage, Tool } from 'ai';
import { eq } from 'drizzle-orm';
import mammoth from 'mammoth';
import readXlsxFile from 'read-excel-file/node';

export type ToolModelOutput = Awaited<
	ReturnType<NonNullable<Tool['toModelOutput']>>
>;

export type FileKind = 'image' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'text';

/** What the read tool persists in the thread. Small on purpose. */
export type StorageReadOutput = {
	fileId: string;
	name: string;
	mediaType: string;
	size: number;
	kind: FileKind;
	/** Whether a derived PDF exists for an Office file. */
	converted: boolean;
};

const DOCX_TYPE =
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_TYPE =
	'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX_TYPE =
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const TEXT_TYPES = new Set([
	'application/json',
	'application/xml',
	'image/svg+xml',
]);

/**
 * Dispatch is on content type, never the filename — same rule as the web's
 * preview. Anything not listed is unsupported on purpose: a format the tool
 * cannot faithfully deliver should say so instead of guessing.
 */
export function fileKind(contentType: string): FileKind | 'unsupported' {
	const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
	if (
		type === 'image/png' ||
		type === 'image/jpeg' ||
		type === 'image/gif' ||
		type === 'image/webp'
	)
		return 'image';
	if (type === 'application/pdf') return 'pdf';
	if (type === DOCX_TYPE) return 'docx';
	if (type === PPTX_TYPE) return 'pptx';
	if (type === XLSX_TYPE) return 'xlsx';
	if (
		type.startsWith('text/') ||
		TEXT_TYPES.has(type) ||
		type.endsWith('+json') ||
		type.endsWith('+xml')
	)
		return 'text';
	return 'unsupported';
}

const MIB = 1024 * 1024;

/**
 * Source-size ceilings, enforced before any bytes leave storage. The image
 * cap is Anthropic's per-image hard limit; the PDF cap keeps the base64 form
 * under Google's inline ceiling; documents get headroom because only their
 * extracted text or converted PDF ever reaches a model.
 */
export const ATTACHMENT_LIMITS = {
	image: 5 * MIB,
	pdf: 15 * MIB,
	document: 20 * MIB,
} as const;

/** ~25k tokens. Extraction output is a prompt, not an archive. */
export const EXTRACT_MAX_CHARS = 100_000;

export function capExtractedText(text: string): string {
	if (text.length <= EXTRACT_MAX_CHARS) return text;
	return `${text.slice(0, EXTRACT_MAX_CHARS)}\n[truncated: ${EXTRACT_MAX_CHARS} of ${text.length} characters shown]`;
}

function csvCell(value: unknown): string {
	if (value === null || value === undefined) return '';
	const text = value instanceof Date ? value.toISOString() : String(value);
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function extractFileText(
	kind: 'docx' | 'xlsx' | 'text',
	bytes: Uint8Array,
): Promise<string> {
	if (kind === 'docx') {
		const result = await mammoth.extractRawText({
			buffer: Buffer.from(bytes),
		});
		return capExtractedText(result.value);
	}
	if (kind === 'xlsx') {
		const sheets = await readXlsxFile(Buffer.from(bytes));
		const rendered = sheets
			.map(
				(sheet) =>
					`# Sheet: ${sheet.sheet}\n${sheet.data
						.map((row) => row.map(csvCell).join(','))
						.join('\n')}`,
			)
			.join('\n\n');
		return capExtractedText(rendered);
	}
	return capExtractedText(new TextDecoder().decode(bytes));
}

/**
 * Test seam: `undefined` uses `env.GOTENBERG_URL`, `null` simulates the
 * converter being unconfigured, a string points somewhere else (for example a
 * closed port, the same pattern the dolarapi tests use).
 */
export const gotenbergOverride: { url?: string | null } = {};

function gotenbergUrl(): string | undefined {
	if (gotenbergOverride.url !== undefined)
		return gotenbergOverride.url ?? undefined;
	return env.GOTENBERG_URL;
}

/**
 * Cloud Run service-to-service auth: a private Gotenberg only accepts callers
 * whose identity token names it as audience. Outside Cloud Run there is no
 * metadata server, so this resolves to nothing and the request goes bare —
 * which is exactly right against the local Compose service.
 */
let cachedIdToken: { audience: string; token: string; expiresAt: number } = {
	audience: '',
	token: '',
	expiresAt: 0,
};

async function googleIdToken(audience: string): Promise<string | undefined> {
	if (
		cachedIdToken.audience === audience &&
		cachedIdToken.expiresAt > Date.now()
	)
		return cachedIdToken.token;
	try {
		const response = await fetch(
			`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
			{
				headers: { 'metadata-flavor': 'Google' },
				signal: AbortSignal.timeout(1000),
			},
		);
		if (!response.ok) return undefined;
		const token = await response.text();
		cachedIdToken = {
			audience,
			token,
			// Tokens last an hour; refresh well before that.
			expiresAt: Date.now() + 50 * 60 * 1000,
		};
		return token;
	} catch {
		return undefined;
	}
}

const CONVERT_TIMEOUT_MS = 30_000;

const OFFICE_EXTENSION = { docx: '.docx', pptx: '.pptx' } as const;

/** LibreOffice picks its import filter from the filename's extension. */
function conversionFilename(name: string, kind: 'docx' | 'pptx') {
	const extension = OFFICE_EXTENSION[kind];
	return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
}

async function convertOfficeToPdf(
	url: string,
	bytes: Uint8Array<ArrayBuffer>,
	filename: string,
	contentType: string,
): Promise<Uint8Array> {
	const form = new FormData();
	form.append('files', new File([bytes], filename, { type: contentType }));
	const token = await googleIdToken(url);
	const response = await fetch(`${url}/forms/libreoffice/convert`, {
		method: 'POST',
		body: form,
		headers: token ? { authorization: `Bearer ${token}` } : undefined,
		signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
	});
	if (!response.ok) {
		const detail = (await response.text().catch(() => '')).slice(0, 200);
		throw new Error(
			`The document converter failed (${response.status}). ${detail}`.trim(),
		);
	}
	return new Uint8Array(await response.arrayBuffer());
}

/** Typed against a plain ArrayBuffer so the bytes satisfy `BlobPart`. */
async function readObjectBytes(id: string): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await storage.file(objectKey(id)).arrayBuffer());
}

/**
 * Converts once and caches the result as an immutable derived object. The
 * cache is what keeps `toModelOutput` deterministic across turns: LibreOffice
 * stamps a creation date into every PDF it writes, so converting per turn
 * would feed the provider different bytes each time and break prompt caching.
 */
async function ensureDerivedPdf(
	row: { id: string; name: string; contentType: string },
	kind: 'docx' | 'pptx',
): Promise<boolean> {
	if (await storage.file(derivedPdfKey(row.id)).exists()) return true;

	const url = gotenbergUrl();
	if (!url) {
		if (kind === 'docx') {
			// Still a useful read: validate extraction now so a broken file
			// fails the tool call instead of every later prompt build.
			await extractFileText('docx', await readObjectBytes(row.id));
			return false;
		}
		throw new Error(
			`"${row.name}" needs the document converter to be readable, and it is not configured right now.`,
		);
	}

	const pdf = await convertOfficeToPdf(
		url,
		await readObjectBytes(row.id),
		conversionFilename(row.name, kind),
		row.contentType,
	);
	if (pdf.byteLength > ATTACHMENT_LIMITS.pdf)
		throw new Error(
			`"${row.name}" converts to a ${Math.ceil(pdf.byteLength / MIB)} MiB PDF, above the ${ATTACHMENT_LIMITS.pdf / MIB} MiB limit.`,
		);
	await storage.write(derivedPdfKey(row.id), pdf, {
		type: 'application/pdf',
	});
	return true;
}

function limitFor(kind: FileKind): number {
	if (kind === 'image') return ATTACHMENT_LIMITS.image;
	if (kind === 'pdf') return ATTACHMENT_LIMITS.pdf;
	return ATTACHMENT_LIMITS.document;
}

/**
 * The body of the read tool's `execute`. Validates everything that can fail
 * loudly — existence, format, size, extraction, conversion — exactly once, so
 * the per-turn hydration path only ever re-reads bytes that already proved
 * readable. Throws domain messages; the SDK surfaces them as tool errors.
 */
export async function readFileForAgent(
	fileId: string,
): Promise<StorageReadOutput> {
	const [row] = await db
		.select()
		.from(file)
		.where(eq(file.id, fileId))
		.limit(1);
	if (!row) throw new Error(`File ${fileId} was not found in storage.`);

	const kind = fileKind(row.contentType);
	if (kind === 'unsupported')
		throw new Error(
			`"${row.name}" (${row.contentType}) is not supported yet. Readable formats: images (png, jpeg, gif, webp), PDF, docx, pptx, xlsx, and plain text.`,
		);

	const limit = limitFor(kind);
	if (row.size > limit)
		throw new Error(
			`"${row.name}" is too large to read (${Math.ceil(row.size / MIB)} MiB; the limit for this format is ${limit / MIB} MiB).`,
		);

	let converted = false;
	if (kind === 'docx' || kind === 'pptx') {
		converted = await ensureDerivedPdf(row, kind);
	} else if (kind === 'xlsx' || kind === 'text') {
		// Validation read: a corrupt spreadsheet should fail the tool call,
		// not the prompt build of every following turn.
		await extractFileText(kind, await readObjectBytes(row.id));
	}

	return {
		fileId: row.id,
		name: row.name,
		mediaType: row.contentType,
		size: row.size,
		kind,
		converted,
	};
}

function placeholder(
	label: string,
	output: StorageReadOutput,
): ToolModelOutput {
	return {
		type: 'text',
		value: `[${label} "${output.name}" (${output.size} bytes) attached — not viewable by this model; its id is ${output.fileId}]`,
	};
}

function mediaOutput(
	output: StorageReadOutput,
	bytes: Uint8Array,
	mediaType: string,
	filename: string,
): ToolModelOutput {
	return {
		type: 'content',
		value: [
			{
				type: 'text',
				text: `File "${output.name}" (${output.mediaType}, ${output.size} bytes):`,
			},
			{
				type: 'file',
				data: { type: 'data', data: bytes },
				mediaType,
				filename,
			},
		],
	};
}

function textOutput(output: StorageReadOutput, text: string): ToolModelOutput {
	return {
		type: 'text',
		value: `File "${output.name}" (${output.mediaType}):\n\n${text}`,
	};
}

/**
 * The per-turn hydration behind `toModelOutput`, bound to the current model's
 * attachment support. Never throws: the persisted metadata may outlive the
 * file, and a missing object must degrade this one tool result, not fail the
 * whole prompt build.
 */
export async function fileReadModelOutput(
	output: StorageReadOutput,
	attachments: AttachmentSupport,
): Promise<ToolModelOutput> {
	try {
		switch (output.kind) {
			case 'image': {
				if (!attachments.image) return placeholder('image', output);
				const bytes = await readObjectBytes(output.fileId);
				return mediaOutput(output, bytes, output.mediaType, output.name);
			}
			case 'pdf': {
				if (!attachments.pdf) return placeholder('document', output);
				const bytes = await readObjectBytes(output.fileId);
				return mediaOutput(output, bytes, 'application/pdf', output.name);
			}
			case 'docx': {
				if (attachments.pdf && output.converted) {
					const bytes = await storage
						.file(derivedPdfKey(output.fileId))
						.bytes();
					return mediaOutput(
						output,
						bytes,
						'application/pdf',
						`${output.name}.pdf`,
					);
				}
				const text = await extractFileText(
					'docx',
					await readObjectBytes(output.fileId),
				);
				return textOutput(output, text);
			}
			case 'pptx': {
				if (attachments.pdf && output.converted) {
					const bytes = await storage
						.file(derivedPdfKey(output.fileId))
						.bytes();
					return mediaOutput(
						output,
						bytes,
						'application/pdf',
						`${output.name}.pdf`,
					);
				}
				return placeholder('slide deck', output);
			}
			case 'xlsx': {
				const text = await extractFileText(
					'xlsx',
					await readObjectBytes(output.fileId),
				);
				return textOutput(output, text);
			}
			case 'text': {
				const text = await extractFileText(
					'text',
					await readObjectBytes(output.fileId),
				);
				return textOutput(output, text);
			}
		}
	} catch (error) {
		return {
			type: 'text',
			value: `[file "${output.name}" (${output.fileId}) is no longer readable: ${error instanceof Error ? error.message : String(error)}]`,
		};
	}
}

/**
 * Moves image bytes out of tool results and into a user message right after
 * them.
 *
 * `@ai-sdk/openai-compatible` maps a tool result whose output is a content
 * array through `JSON.stringify` — the base64 would arrive as text, costing a
 * fortune and showing the model nothing. The same package maps a **user**
 * file part with an `image/*` media type to `image_url`, which is exactly what
 * Novita's multimodal models take. So for those providers the bytes travel one
 * message later, and the tool result keeps a line saying where they went.
 *
 * Only images: no openai-compatible endpoint here takes PDFs, so those models
 * declare `pdf: false` and never produce a PDF part to lift.
 */
export function liftToolImagesToUserMessages(
	messages: ModelMessage[],
): ModelMessage[] {
	const lifted: ModelMessage[] = [];
	for (const message of messages) {
		if (message.role !== 'tool' || typeof message.content === 'string') {
			lifted.push(message);
			continue;
		}
		const images: FilePart[] = [];
		const content = message.content.map((part) => {
			if (part.type !== 'tool-result' || part.output.type !== 'content')
				return part;
			const kept: string[] = [];
			for (const item of part.output.value) {
				if (item.type === 'text') {
					kept.push(item.text);
					continue;
				}
				// The output union also allows urls and provider file ids; only the
				// inline bytes this module produces can be moved.
				if (item.type !== 'file' || item.data.type !== 'data') continue;
				if (!item.mediaType.startsWith('image/')) continue;
				images.push({
					type: 'file',
					data: item.data.data,
					mediaType: item.mediaType,
					...(item.filename ? { filename: item.filename } : {}),
				});
			}
			if (images.length === 0) return part;
			kept.push('The image follows in the next message.');
			return {
				...part,
				output: { type: 'text' as const, value: kept.join(' ') },
			};
		});
		lifted.push({ ...message, content });
		if (images.length > 0)
			lifted.push({
				role: 'user',
				content: [
					{ type: 'text', text: 'Image from the file read above:' },
					...images,
				],
			});
	}
	return lifted;
}
