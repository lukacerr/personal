// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { useTodayLocalDate } from '@web/lib/calendar-today';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
	vi.useRealTimers();
});

describe('Calendar local day', () => {
	it.each(['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'])(
		'advances after midnight on %s activity while the window stayed visible',
		(type) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date(2026, 7, 23, 23, 59));
			const { result } = renderHook(() => useTodayLocalDate());
			expect(result.current).toBe('2026-08-23');

			vi.setSystemTime(new Date(2026, 7, 24, 0, 1));
			act(() => document.dispatchEvent(new Event(type)));

			expect(result.current).toBe('2026-08-24');
		},
	);
});
