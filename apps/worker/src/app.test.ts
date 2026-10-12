import { expect, test } from 'vitest';
import { createWorker } from './app.js';

test('worker runs without an API or database process', async () => {
  const app = createWorker();
  try {
    const response = await app.inject('/health');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'worker' });
  } finally {
    await app.close();
  }
});
