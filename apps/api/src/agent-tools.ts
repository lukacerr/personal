import { fileReadModelOutput, readFileForAgent } from '@api/agent-files';
import type { AttachmentSupport } from '@api/agent-models';
import { db, env } from '@api/env';
import { inFolder } from '@api/folder-paths';
import { likeContaining } from '@api/like-patterns';
import { file } from '@api/schema';
import { type TavilyClient, tavily } from '@tavily/core';
import { type ToolSet, tool } from 'ai';
import { and, desc, sql } from 'drizzle-orm';
import { z } from 'zod';

/**
 * Exported so tests exercise the exact schema the model is constrained by,
 * instead of re-declaring the bounds next to the asserts.
 */
export const tavilyInputSchema = z.object({
	query: z.string().min(1).max(400),
	searchDepth: z.enum(['basic', 'advanced']).default('basic'),
	maxResults: z.number().int().min(1).max(8).default(5),
});

export type TavilySearchInput = z.infer<typeof tavilyInputSchema>;

/**
 * What the tool hands back to the model — and what the web renders as
 * sources. Kept to the fields both consumers need so a Tavily response
 * reshaping upstream stays contained here.
 */
export type TavilySearchOutput = {
	query: string;
	results: { title: string; url: string; content: string; score: number }[];
};

/**
 * Test seam. Tests set `tavilyOverride.execute` and restore it to
 * `undefined`; the suite never reaches Tavily's API.
 */
export const tavilyOverride: {
	execute?: (input: TavilySearchInput) => Promise<TavilySearchOutput>;
} = {};

/** Lazy so importing the registry never constructs the HTTP client. */
let client: TavilyClient | undefined;

async function searchTavily(
	input: TavilySearchInput,
): Promise<TavilySearchOutput> {
	client ??= tavily({ apiKey: env.TAVILY_API_KEY });
	const response = await client.search(input.query, {
		searchDepth: input.searchDepth,
		maxResults: input.maxResults,
	});
	return {
		query: input.query,
		results: response.results.map((result) => ({
			title: result.title,
			url: result.url,
			content: result.content,
			score: result.score,
		})),
	};
}

/**
 * Matches, never catalogs: the refine forces some scope so the model cannot
 * ask for the whole bucket and flood its own context.
 */
export const storageSearchInputSchema = z
	.object({
		query: z.string().min(1).max(200).optional(),
		folder: z.string().min(1).max(1024).optional(),
		limit: z.number().int().min(1).max(25).default(10),
	})
	.refine((input) => input.query !== undefined || input.folder !== undefined, {
		message:
			'Provide a query and/or a folder; listing all of storage is not supported.',
	});

export type StorageSearchInput = z.infer<typeof storageSearchInputSchema>;

async function searchStorage(input: StorageSearchInput) {
	const conditions = [];
	if (input.query !== undefined)
		conditions.push(
			sql`${file.name} ilike ${likeContaining(input.query)} escape '\\'`,
		);
	if (input.folder !== undefined)
		conditions.push(inFolder(file.path, input.folder));

	const rows = await db
		.select({
			id: file.id,
			name: file.name,
			path: file.path,
			contentType: file.contentType,
			size: file.size,
			createdAt: file.createdAt,
		})
		.from(file)
		.where(and(...conditions))
		.orderBy(desc(file.createdAt), desc(file.id))
		.limit(input.limit + 1);

	return {
		files: rows.slice(0, input.limit).map((row) => ({
			fileId: row.id,
			name: row.name,
			folder: row.path,
			mediaType: row.contentType,
			size: row.size,
			createdAt: row.createdAt.getTime(),
		})),
		hasMore: rows.length > input.limit,
	};
}

export const storageReadInputSchema = z.object({
	fileId: z.uuid(),
});

/**
 * The read tool is built per attachment support because its `toModelOutput`
 * — invoked by both `convertToModelMessages` and streamText's step loop —
 * has no other way to know what the current model can see. The static
 * registry entry is bound to no attachments, so an unwired call site
 * degrades to text instead of pushing base64 at a provider that would
 * serialize it into JSON (openai-compatible does exactly that).
 */
function storageReadTool(attachments: AttachmentSupport) {
	return tool({
		description:
			'Read a file stored in Storage by its fileId. User messages may reference files as @f:<fileId> mentions; pass that id here. Images and PDFs are shown to you directly when the model supports it; docx and pptx arrive converted to PDF; xlsx and plain text arrive as text.',
		inputSchema: storageReadInputSchema,
		execute: (input) => readFileForAgent(input.fileId),
		toModelOutput: ({ output }) => fileReadModelOutput(output, attachments),
	});
}

/**
 * Every tool the agent can be granted, by the name the chat request uses.
 * Adding a capability is one entry here; the catalog endpoint and the web
 * toggle derive from this object.
 */
export const AGENT_TOOLS = {
	tavily: tool({
		description:
			'Search the web for current information. Returns relevant pages with title, URL and a content snippet.',
		inputSchema: tavilyInputSchema,
		execute: (input) => (tavilyOverride.execute ?? searchTavily)(input),
	}),
	storageSearch: tool({
		description:
			"Search the user's stored files by name substring and/or folder. Returns matching files with fileId, folder, media type and size — never the full catalog.",
		inputSchema: storageSearchInputSchema,
		execute: (input) => searchStorage(input),
	}),
	storageRead: storageReadTool({ image: false, pdf: false }),
} satisfies ToolSet;

/**
 * The registry with `storageRead` hydration bound to what the current model
 * can see. The same bound set must go to `convertToModelMessages` and to
 * `streamText`: both invoke `toModelOutput` (history and same-request steps).
 */
export function bindToolsToModel(attachments: AttachmentSupport) {
	return {
		...AGENT_TOOLS,
		storageRead: storageReadTool(attachments),
	} satisfies ToolSet;
}

export type AgentToolName = keyof typeof AGENT_TOOLS;

/**
 * What each tool reaches for, which is how the picker groups them. Declared
 * here rather than inferred from the name: `satisfies` fails to compile the
 * day a tool is registered without a group, so the two lists cannot drift.
 */
const TOOL_GROUPS = {
	tavily: 'Web',
	storageSearch: 'Storage',
	storageRead: 'Storage',
} satisfies Record<AgentToolName, string>;

/** What the catalog endpoint publishes. */
export function agentToolCatalog() {
	return Object.entries(AGENT_TOOLS).map(([name, entry]) => ({
		name,
		group: TOOL_GROUPS[name as AgentToolName],
		description: entry.description ?? '',
	}));
}

/**
 * Resolves the request's `tools` list against the registry. Only the returned
 * `tools` reach `streamText`; unknown names are reported so the router can
 * reject them instead of silently granting less than the client asked for.
 */
export function pickTools(
	names: readonly string[],
	registry: ToolSet = AGENT_TOOLS,
) {
	const tools: ToolSet = {};
	const unknown: string[] = [];
	for (const name of names) {
		const entry = registry[name];
		if (entry) tools[name] = entry;
		else unknown.push(name);
	}
	return { tools, unknown };
}
