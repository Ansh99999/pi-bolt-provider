import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveredThinking, validateThinkingLevelMap } from '../src/thinking.ts';

test('validateThinkingLevelMap accepts partial explicit maps and preserves exact values', () => {
  assert.equal(validateThinkingLevelMap(undefined), undefined);
  assert.deepEqual(validateThinkingLevelMap({
    off: 'disabled',
    low: 'provider-low',
    xhigh: '  exact value  ',
    max: null,
  }), {
    off: 'disabled',
    low: 'provider-low',
    xhigh: '  exact value  ',
    max: null,
  });
});

test('validateThinkingLevelMap rejects invalid containers, levels, and values', () => {
  for (const value of [null, [], 42, { low: 42 }, { unknown: 'low' }]) {
    assert.throws(() => validateThinkingLevelMap(value), Error);
  }
  assert.throws(() => validateThinkingLevelMap({ low: '' }), /thinkingLevelMap\.low/);
  assert.throws(() => validateThinkingLevelMap({ high: 'x'.repeat(65) }), /thinkingLevelMap\.high/);
  assert.throws(() => validateThinkingLevelMap({ max: 'bad\u0007value' }), /thinkingLevelMap\.max/);
  assert.throws(
    () => validateThinkingLevelMap({ bad: 'value' }),
    /thinkingLevelMap has an unsupported level: bad/,
  );

  const prototypeMap = JSON.parse('{"__proto__":"low"}') as unknown;
  assert.throws(() => validateThinkingLevelMap(prototypeMap), /__proto__/);
});

test('discoveredThinking distinguishes absent metadata and preserves explicit booleans', () => {
  assert.deepEqual(discoveredThinking({}), {});
  assert.deepEqual(discoveredThinking({ reasoning: true }), { reasoning: true });
  assert.deepEqual(discoveredThinking({ reasoning: false }), { reasoning: false });
  assert.deepEqual(discoveredThinking({ reasoning: 'no' }), {});

  const inherited = Object.create({ reasoning: true, thinkingLevelMap: { low: 'low' } }) as Record<string, unknown>;
  assert.deepEqual(discoveredThinking(inherited), {});
});

test('discoveredThinking recognizes explicit maps and enables reasoning only for non-off capabilities', () => {
  assert.deepEqual(discoveredThinking({
    thinkingLevelMap: { off: 'off', high: 'extended', xhigh: 'xhigh', max: 'max' },
  }), {
    reasoning: true,
    thinkingLevelMap: { off: 'off', high: 'extended', xhigh: 'xhigh', max: 'max' },
  });

  assert.deepEqual(discoveredThinking({
    thinking_level_map: { off: 'disabled' },
  }), {
    thinkingLevelMap: { off: 'disabled' },
  });

  assert.deepEqual(discoveredThinking({
    reasoning: false,
    thinkingLevelMap: { high: 'high', max: 'max' },
  }), {
    reasoning: false,
    thinkingLevelMap: { high: 'high', max: 'max' },
  });
});

test('discoveredThinking maps explicit effort arrays and preserves xhigh and max', () => {
  assert.deepEqual(discoveredThinking({
    supported_reasoning_efforts: ['none', 'low', 'xhigh', 'max'],
  }), {
    reasoning: true,
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: 'low',
      medium: null,
      high: null,
      xhigh: 'xhigh',
      max: 'max',
    },
  });

  assert.deepEqual(discoveredThinking({
    reasoning_efforts: ['off', 'minimal', 'high'],
  }), {
    reasoning: true,
    thinkingLevelMap: {
      off: 'off',
      minimal: 'minimal',
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: null,
    },
  });

  assert.deepEqual(discoveredThinking({
    supported_reasoning_efforts: ['none'],
  }), {
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    },
  });
});

test('discoveredThinking ignores unsupported effort values without mapping them', () => {
  assert.deepEqual(discoveredThinking({
    reasoning_efforts: ['bogus', 'low', 'custom'],
  }), {
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    },
  });
});

test('discoveredThinking safely ignores invalid advertised metadata', () => {
  assert.deepEqual(discoveredThinking({ reasoning_efforts: [] }), {});
  assert.deepEqual(discoveredThinking({ reasoning: true, reasoning_efforts: ['custom-only'] }), { reasoning: true });
  assert.throws(() => validateThinkingLevelMap({ off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null }), /remain available/);
  assert.deepEqual(discoveredThinking({
    thinkingLevelMap: { low: '', evil: 'value' },
  }), {});
  assert.deepEqual(discoveredThinking({ supported_reasoning_efforts: 'high' }), {});
  assert.deepEqual(discoveredThinking({ reasoning_efforts: [null, 'low'] }), {});
  assert.deepEqual(discoveredThinking({ reasoning_efforts: ['bad\u001bvalue', 'low'] }), {});

  const throwingMap: Record<string, unknown> = {};
  Object.defineProperty(throwingMap, 'thinkingLevelMap', {
    get() { throw new Error('map getter'); },
    enumerable: true,
  });
  assert.deepEqual(discoveredThinking(throwingMap), {});

  const throwingReasoning: Record<string, unknown> = {};
  Object.defineProperty(throwingReasoning, 'reasoning', {
    get() { throw new Error('reasoning getter'); },
    enumerable: true,
  });
  assert.deepEqual(discoveredThinking(throwingReasoning), {});
});

test('discoveredThinking can use a valid alternate map when primary metadata is invalid', () => {
  assert.deepEqual(discoveredThinking({
    thinkingLevelMap: { low: '' },
    thinking_level_map: { medium: 'm' },
  }), {
    reasoning: true,
    thinkingLevelMap: { medium: 'm' },
  });
});
