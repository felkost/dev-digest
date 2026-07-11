import { describe, it, expect } from 'vitest';
import type { Db } from '../src/db/client.js';
import { Container } from '../src/platform/container.js';
import { loadConfig } from '../src/platform/config.js';
import { MockAuthProvider, MockSecretsProvider, MockRunnerBundler } from '../src/adapters/mocks.js';
import { NccRunnerBundler } from '../src/adapters/runner-bundle/ncc.js';

/**
 * Container DI-wiring tests only — no real db/network. `runnerBundler.build()`
 * is NEVER invoked here (that would run a real `ncc` build); these tests only
 * verify which class gets constructed / which override wins.
 */
describe('Container.runnerBundler', () => {
  const config = loadConfig({});
  const db = {} as unknown as Db;

  it('returns the injected override when supplied via ContainerOverrides', () => {
    const fixture = new MockRunnerBundler();
    const container = new Container(config, db, {
      auth: new MockAuthProvider(),
      secrets: new MockSecretsProvider(),
      runnerBundler: fixture,
    });
    expect(container.runnerBundler).toBe(fixture);
  });

  it('lazily constructs a real NccRunnerBundler when no override is supplied', () => {
    const container = new Container(config, db, {
      auth: new MockAuthProvider(),
      secrets: new MockSecretsProvider(),
    });
    expect(container.runnerBundler).toBeInstanceOf(NccRunnerBundler);
  });

  it('memoizes the same NccRunnerBundler instance across repeated access (mirrors the `git` getter pattern)', () => {
    const container = new Container(config, db, {
      auth: new MockAuthProvider(),
      secrets: new MockSecretsProvider(),
    });
    expect(container.runnerBundler).toBe(container.runnerBundler);
  });
});
