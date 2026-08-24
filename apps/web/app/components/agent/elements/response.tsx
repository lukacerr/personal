import { code } from '@streamdown/code';
import { createMathPlugin } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import { cn } from '@web/lib/utils';
import { memo } from 'react';
import remarkFlexibleMarkers from 'remark-flexible-markers';
import { defaultRemarkPlugins, Streamdown } from 'streamdown';

/**
 * One object shared by every render: Streamdown is itself memoized, and a
 * fresh literal per render would defeat that memo on props that never change.
 *
 * `singleDollarTextMath` is on because the assistant writes inline math the
 * way everyone writes it — `$E = mc^2$` mid-sentence — and with it off those
 * dollars printed literally while only `$$…$$` blocks rendered. The cost is
 * the reason it shipped off: a pair of dollar amounts in one sentence can now
 * be read as a formula. In practice KaTeX needs the delimiters to hug
 * non-space characters, so `$100 y $200` survives (there is a test), and the
 * system prompt tells the model to write amounts as `100 USD` when it is
 * writing math in the same message.
 */
const plugins = {
	code,
	math: createMathPlugin({ singleDollarTextMath: true }),
	mermaid,
};

/**
 * `==highlight==` is not part of GFM and Streamdown has no plugin slot for it,
 * so it arrives as an extra remark plugin. Passing `remarkPlugins` replaces
 * Streamdown's defaults, so preserve its GFM plugin before adding markers.
 */
const remarkPlugins = [
	...Object.values(defaultRemarkPlugins),
	remarkFlexibleMarkers,
];

/**
 * Streamdown hardens its output, and `mark` is not on the sanitizer's default
 * allowlist — the plugin above consumed the `==` and then the element was
 * dropped, so highlights rendered as plain text. `class` rides along because
 * the plugin names its element.
 */
const allowedTags = { mark: ['class'] };

/**
 * Mermaid draws with its own palette, which is light: on this shell the
 * diagrams came out as white boxes on a dark page. The app is dark-only —
 * `root.tsx` hard-codes the class — so one theme is the whole decision, and
 * mapping every token by hand would buy nothing over mermaid's own dark set.
 */
const mermaidOptions = { config: { theme: 'dark' as const } };

/**
 * Streaming markdown, memoized so a token appended to the last message does
 * not re-render every earlier one: during a stream the parent re-renders per
 * chunk, but only one Response's `children` string actually changed.
 * Streamdown's own utility classes exist because app.css `@source`s its dist.
 */
export const Response = memo(function Response({
	children,
	className,
}: {
	children: string;
	className?: string;
}) {
	return (
		<Streamdown
			className={cn(
				// Streamdown spaces its blocks with margins; trim the outer ones so
				// the surrounding layout's gap is the only spacing at the edges.
				'size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
				className,
			)}
			plugins={plugins}
			remarkPlugins={remarkPlugins}
			allowedTags={allowedTags}
			mermaid={mermaidOptions}
		>
			{children}
		</Streamdown>
	);
});
