import type { App } from '@api';
import { treaty } from '@elysia/eden';
import { env } from '@web/lib/env';

export const api = treaty<App>(env.VITE_API_URL);
