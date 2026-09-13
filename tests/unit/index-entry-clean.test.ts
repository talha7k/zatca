import { describe, expect, test } from 'bun:test';

describe('package entry point security invariants', () => {
  test('importing the package root must not read AUTH_API_KEY or invoke atob/eval', async () => {
    let authApiKeyAccessed = false;
    let atobCalled = false;
    let evalCalled = false;

    // Bun's process.env rejects accessor descriptors — use a transparent
    // Proxy so reads of AUTH_API_KEY are detected without affecting other
    // environment lookups. A harmless localhost URL is returned so that, if
    // the key IS read, no real endpoint is ever contacted.
    const realEnv = process.env;
    const harmlessUrl = Buffer.from('http://127.0.0.1:9/x').toString('base64');
    process.env = new Proxy(realEnv, {
      get(target, prop, receiver) {
        if (prop === 'AUTH_API_KEY') {
          authApiKeyAccessed = true;
          return harmlessUrl;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as NodeJS.ProcessEnv;

    const realAtob = globalThis.atob;
    const realEval = globalThis.eval;
    globalThis.atob = ((input: string) => {
      atobCalled = true;
      return realAtob(input);
    }) as typeof atob;
    globalThis.eval = ((source: string) => {
      evalCalled = true;
      return realEval(source);
    }) as typeof eval;

    try {
      await import('../../src/index.js');
    } finally {
      process.env = realEnv;
      globalThis.atob = realAtob;
      globalThis.eval = realEval;
    }

    expect(authApiKeyAccessed).toBe(false);
    expect(atobCalled).toBe(false);
    expect(evalCalled).toBe(false);
  });
});
