import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { VERSION } from '../../src/index.js';

describe('VERSION export', () => {
  test('matches package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(VERSION).toBe(pkg.version);
  });

  test('is a non-empty semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
