import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  endControlClient,
  type ControlClientLifecycle,
} from './cancel-postgres.js';

class UnresponsiveStream extends EventEmitter {
  destroyed = false;

  destroy() {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

class ControlConnection extends EventEmitter {
  readonly stream = new UnresponsiveStream();
}

class UnresponsiveControlClient implements ControlClientLifecycle {
  readonly connection = new ControlConnection();

  end(callback?: () => void) {
    if (callback) this.connection.once('end', callback);
  }
}

class NeverClosingStream extends EventEmitter {
  destroyed = false;

  destroy() {
    this.destroyed = true;
    return this;
  }
}

class NeverClosingConnection extends EventEmitter {
  readonly stream = new NeverClosingStream();
}

class NeverClosingControlClient implements ControlClientLifecycle {
  readonly connection = new NeverClosingConnection();

  end(callback?: () => void) {
    if (callback) this.connection.once('end', callback);
  }
}

describe('PostgreSQL cancel control client cleanup', () => {
  it('destroys an unresponsive control connection and removes its end listener within the deadline', async () => {
    const client = new UnresponsiveControlClient();
    const started = performance.now();
    await endControlClient(client, 10, 50);

    expect(client.connection.stream.destroyed).toBe(true);
    expect(client.connection.listenerCount('end')).toBe(0);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('settles and removes close/end listeners when even forced socket close is delayed', async () => {
    const client = new NeverClosingControlClient();
    const started = performance.now();
    await endControlClient(client, 10, 50);

    expect(client.connection.stream.destroyed).toBe(true);
    expect(client.connection.listenerCount('end')).toBe(0);
    expect(client.connection.stream.listenerCount('close')).toBe(0);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
