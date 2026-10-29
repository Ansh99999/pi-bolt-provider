import test from 'node:test';
import assert from 'node:assert/strict';
import type { Endpoint, Method } from '../src/types.ts';
import {
  displayProviderName,
  normalizeEndpoint,
  providerId,
} from '../src/endpoints.ts';

test('keeps full pasted routes usable when changing between Google and OpenAI methods', () => {
  assert.equal(normalizeEndpoint('https://example.com/Gateway/v1/responses', 'generative').baseUrl, 'https://example.com/Gateway/v1');
  assert.equal(normalizeEndpoint('https://example.com/Gateway/v1beta/models/gemini:generateContent', 'chat').baseUrl, 'https://example.com/Gateway/v1');
  assert.equal(normalizeEndpoint('https://example.com/Gateway/V1/GENERATIVECONTENT', 'responses').baseUrl, 'https://example.com/Gateway/v1');
});

function endpoint(input: string, method: Method): Endpoint {
  return normalizeEndpoint(input, method);
}

test('infers HTTPS and preserves gateway path prefixes', () => {
  assert.deepEqual(endpoint('api.openai.com/v1', 'responses'), {
    root: 'https://api.openai.com',
    baseUrl: 'https://api.openai.com/v1',
    modelsUrl: 'https://api.openai.com/v1/models',
    api: 'openai-responses',
  });

  assert.deepEqual(endpoint('https://gw.example/team/openai', 'chat'), {
    root: 'https://gw.example/team/openai',
    baseUrl: 'https://gw.example/team/openai/v1',
    modelsUrl: 'https://gw.example/team/openai/v1/models',
    api: 'openai-completions',
  });
});

test('preserves explicit HTTP for LAN hosts', () => {
  assert.deepEqual(endpoint('http://192.168.1.20:8080/gateway', 'responses'), {
    root: 'http://192.168.1.20:8080/gateway',
    baseUrl: 'http://192.168.1.20:8080/gateway/v1',
    modelsUrl: 'http://192.168.1.20:8080/gateway/v1/models',
    api: 'openai-responses',
  });
});

test('normalizes full routes after the user switches methods', () => {
  assert.deepEqual(
    endpoint('https://api.example/gateway/v1/messages', 'responses'),
    {
      root: 'https://api.example/gateway',
      baseUrl: 'https://api.example/gateway/v1',
      modelsUrl: 'https://api.example/gateway/v1/models',
      api: 'openai-responses',
    },
  );

  assert.deepEqual(
    endpoint('https://api.example/gateway/v1/chat/completions', 'messages'),
    {
      root: 'https://api.example/gateway',
      baseUrl: 'https://api.example/gateway',
      modelsUrl: 'https://api.example/gateway/v1/models',
      api: 'anthropic-messages',
    },
  );

  assert.deepEqual(
    endpoint('https://api.example/gateway/v1/responses', 'messages'),
    {
      root: 'https://api.example/gateway',
      baseUrl: 'https://api.example/gateway',
      modelsUrl: 'https://api.example/gateway/v1/models',
      api: 'anthropic-messages',
    },
  );
});

test('normalizes Google beta paths, aliases, and model routes', () => {
  assert.deepEqual(endpoint('https://ai.example/v1beta', 'generative'), {
    root: 'https://ai.example',
    baseUrl: 'https://ai.example/v1beta',
    modelsUrl: 'https://ai.example/v1beta/models',
    api: 'google-generative-ai',
  });

  assert.deepEqual(
    endpoint('https://ai.example/V1/GenerativeContent', 'generative'),
    {
      root: 'https://ai.example',
      baseUrl: 'https://ai.example/v1',
      modelsUrl: 'https://ai.example/v1/models',
      api: 'google-generative-ai',
    },
  );

  assert.deepEqual(
    endpoint(
      'https://ai.example/v1/models/gemini-2.0:generateContent',
      'generative',
    ),
    {
      root: 'https://ai.example',
      baseUrl: 'https://ai.example/v1',
      modelsUrl: 'https://ai.example/v1/models',
      api: 'google-generative-ai',
    },
  );
});

test('rejects unsafe or unsupported URL inputs', () => {
  const invalid = [
    'ftp://api.example.com',
    'https://user:key@api.example.com',
    'https://api.example.com/?query=1',
    'https://api.example.com/#fragment',
    'https://api.example.com/\u0000',
  ];

  for (const value of invalid) {
    assert.throws(() => endpoint(value, 'responses'));
  }

  assert.throws(() =>
    endpoint('https://api.example.com', 'unknown' as Method),
  );
});

test('derives display names and rejects reserved provider IDs', () => {
  assert.equal(
    displayProviderName('', 'https://www.example.com/path'),
    'www.example.com',
  );
  assert.equal(
    displayProviderName('  Example Provider  ', 'https://api.example.com'),
    'Example Provider',
  );
  assert.equal(
    providerId('Example Provider', 'https://api.example.com'),
    'example-provider',
  );
  assert.throws(() => providerId('constructor', 'https://api.example.com'));
  assert.throws(() => providerId('__proto__', 'https://api.example.com'));
});
