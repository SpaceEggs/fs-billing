import { expect, test } from 'vitest';
import { createApi } from './app.js';

test('API exposes an independent health endpoint', async () => {
  const app = createApi();
  try {
    const response = await app.inject('/api/health');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'api' });
  } finally {
    await app.close();
  }
});
