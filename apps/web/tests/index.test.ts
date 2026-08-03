import { meta } from '@web/routes/_app._index';
import { describe, expect, it } from 'vitest';

describe('Home', () => {
	it('Defines the page title', () => {
		expect(meta()).toContainEqual({ title: 'Personal systems' });
	});
});
