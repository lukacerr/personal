// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
	StoredFileView,
	type StoredFileViewProps,
} from '@web/components/notes/note-file-view';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

function view(overrides: Partial<StoredFileViewProps> = {}) {
	const props: StoredFileViewProps = {
		state: 'ready',
		name: 'diagram.png',
		contentType: 'image/png',
		size: 2048,
		url: 'https://files.test/signed',
		...overrides,
	};
	render(<StoredFileView {...props} />);
	return props;
}

describe('Stored file block', () => {
	it.each([
		['an image', 'image/png', 'img'],
		['a video', 'video/mp4', 'video'],
		['an audio file', 'audio/mpeg', 'audio'],
	])('renders %s inline', (_case, contentType, tag) => {
		const { container } = render(
			<StoredFileView
				state="ready"
				name="clip"
				contentType={contentType}
				size={10}
				url="https://files.test/signed"
			/>,
		);

		expect(container.querySelector(tag)).toBeTruthy();
	});

	/**
	 * A note is for reading, not for hosting a document viewer. Anything without
	 * a viewer worth embedding — a pdf included — is a reference you can open.
	 */
	it.each([
		['a pdf', 'application/pdf'],
		['an archive', 'application/zip'],
	])(
		'offers %s as a download instead of embedding it',
		(_case, contentType) => {
			const { container } = render(
				<StoredFileView
					state="ready"
					name="report"
					contentType={contentType}
					size={2048}
					url="https://files.test/signed"
				/>,
			);

			expect(
				screen.getByRole('button', { name: 'Download report' }),
			).toBeTruthy();
			expect(container.querySelector('img, video, audio, iframe')).toBeNull();
		},
	);

	/**
	 * Deleting a file is allowed to leave a note pointing at nothing. The block
	 * says so and keeps the name, rather than vanishing and taking the record of
	 * what used to be there with it.
	 */
	it('says a deleted file was deleted, and still names it', () => {
		view({ state: 'missing', name: 'gone.png', url: undefined });

		expect(screen.getByText(/“gone.png” was deleted/)).toBeTruthy();
	});

	/**
	 * All this state knows is that the browser could not render the bytes, which
	 * could be damage, an unsupported format, or an object that left the bucket
	 * without its record. It offers the file rather than picking a culprit.
	 */
	it('offers the file when its bytes could not be displayed', async () => {
		const user = userEvent.setup();
		const onDownload = vi.fn();
		render(
			<StoredFileView
				state="broken"
				name="torn.png"
				contentType="image/png"
				size={10}
				onDownload={onDownload}
			/>,
		);

		expect(screen.getByText(/could not be displayed/)).toBeTruthy();
		await user.click(screen.getByRole('button', { name: /Download/ }));

		expect(onDownload).toHaveBeenCalledOnce();
	});

	it('offers a retry only when retrying could help', async () => {
		const user = userEvent.setup();
		const onRetry = vi.fn();
		render(
			<StoredFileView
				state="failed"
				name="flaky.png"
				contentType="image/png"
				size={10}
				onRetry={onRetry}
			/>,
		);

		await user.click(screen.getByRole('button', { name: /Retry/ }));

		expect(onRetry).toHaveBeenCalledOnce();
	});

	it('tells a reader of a public note that an attachment is not shared', () => {
		view({ state: 'unavailable', url: undefined });

		expect(screen.getByText('This file is not shared')).toBeTruthy();
	});

	/**
	 * Publishing a note does not publish its files, so the one place the gap is
	 * visible is next to the file it applies to.
	 */
	it('warns in the editor when a public note holds a private file', async () => {
		const user = userEvent.setup();
		const onPublish = vi.fn();
		render(
			<StoredFileView
				state="ready"
				name="private.png"
				contentType="image/png"
				size={10}
				url="https://files.test/signed"
				unshared
				onPublish={onPublish}
			/>,
		);

		expect(
			screen.getByText(/nobody opening the link will see it/),
		).toBeTruthy();
		await user.click(
			screen.getByRole('button', { name: 'Share this file too' }),
		);

		expect(onPublish).toHaveBeenCalledOnce();
	});

	/**
	 * A pdf has no business rendering inside a paragraph, but "download it to
	 * find out what it is" is not an answer either. It opens in the same viewer
	 * Storage uses.
	 */
	it('opens a non-media file in the storage viewer', async () => {
		const user = userEvent.setup();
		const onPreview = vi.fn();
		render(
			<StoredFileView
				state="ready"
				name="report.pdf"
				contentType="application/pdf"
				size={2048}
				url="https://files.test/signed"
				onPreview={onPreview}
			/>,
		);

		await user.click(
			screen.getByRole('button', { name: 'Preview report.pdf' }),
		);

		expect(onPreview).toHaveBeenCalledOnce();
	});

	/** A size only a mouse can set is a size a keyboard cannot set at all. */
	it('resizes media from the keyboard as well as by dragging', async () => {
		const user = userEvent.setup();
		const onResize = vi.fn();
		render(
			<StoredFileView
				state="ready"
				name="wide.png"
				contentType="image/png"
				size={10}
				url="https://files.test/signed"
				editable
				onResize={onResize}
			/>,
		);

		const handle = screen.getByRole('button', { name: 'Resize' });
		handle.focus();
		await user.keyboard('{ArrowRight}');

		expect(onResize).toHaveBeenCalledWith(expect.any(Number));
	});

	/**
	 * A screenshot with no background of its own blends into the page it is
	 * pasted on, so the frame is a real need rather than decoration.
	 */
	it('frames media only when asked to', () => {
		const { container, rerender } = render(
			<StoredFileView
				state="ready"
				name="shot.png"
				contentType="image/png"
				size={10}
				url="https://files.test/signed"
			/>,
		);
		expect(container.querySelector('img')?.className).not.toContain('ring-1');

		rerender(
			<StoredFileView
				state="ready"
				name="shot.png"
				contentType="image/png"
				size={10}
				url="https://files.test/signed"
				bordered
			/>,
		);
		expect(container.querySelector('img')?.className).toContain('ring-1');
	});

	it.each([
		['left', 'mr-auto'],
		['center', 'mx-auto'],
		['right', 'ml-auto'],
	] as const)('aligns media to the %s', (alignment, expected) => {
		const { container } = render(
			<StoredFileView
				state="ready"
				name="shot.png"
				contentType="image/png"
				size={10}
				url="https://files.test/signed"
				alignment={alignment}
			/>,
		);

		// The figure is the box BlockNote outlines when the block is selected, so
		// it is the box that has to both hug the media and carry the alignment.
		const figure = container.querySelector('figure');
		expect(figure?.className).toContain('w-fit');
		expect(figure?.className).toContain(expected);
	});

	it('offers alignment and framing to an editor, and to nobody else', async () => {
		const user = userEvent.setup();
		const onAlign = vi.fn();
		const onToggleBorder = vi.fn();
		const media = (editable: boolean) => (
			<StoredFileView
				state="ready"
				name="shot.png"
				contentType="image/png"
				size={10}
				url="https://files.test/signed"
				editable={editable}
				onResize={vi.fn()}
				onAlign={onAlign}
				onToggleBorder={onToggleBorder}
			/>
		);

		const { rerender } = render(media(false));
		expect(screen.queryByRole('button', { name: 'Align right' })).toBeNull();

		rerender(media(true));
		await user.click(screen.getByRole('button', { name: 'Align right' }));
		await user.click(screen.getByRole('button', { name: 'Toggle border' }));

		expect(onAlign).toHaveBeenCalledWith('right');
		expect(onToggleBorder).toHaveBeenCalledOnce();
	});

	it('offers no resize handle to someone who cannot edit', () => {
		render(
			<StoredFileView
				state="ready"
				name="wide.png"
				contentType="image/png"
				size={10}
				url="https://files.test/signed"
				editable={false}
				onResize={vi.fn()}
			/>,
		);

		expect(screen.queryByRole('button', { name: 'Resize' })).toBeNull();
	});

	it('asks for a file when the block holds none', async () => {
		const user = userEvent.setup();
		const onChoose = vi.fn();
		render(
			<StoredFileView
				state="empty"
				name=""
				contentType=""
				size={0}
				onChoose={onChoose}
			/>,
		);

		await user.click(screen.getByRole('button', { name: /Choose or upload/ }));

		expect(onChoose).toHaveBeenCalledOnce();
	});
});
