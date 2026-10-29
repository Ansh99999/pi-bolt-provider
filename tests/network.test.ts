import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { Method, ProviderDraft } from '../src/types.ts';
import { checkKey, fetchModels } from '../src/network.ts';

type CapturedRequest = {
  url: string;
  headers: Record<string, unknown>;
  query: URLSearchParams;
};
type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  count: number,
) => void;

function draft(
  method: Method,
  baseUrl: string,
  headers: Record<string, string> = {},
  key = 'dummy-key',
): ProviderDraft {
  return {
    name: 'Test',
    baseUrl,
    method,
    keys: [key],
    selectedKey: 0,
    skin: 'pi',
    headers,
    models: [],
    selectedModelIds: [],
  };
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify(payload));
}

async function startServer(t: TestContext, handler: Handler) {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      url: `${url.pathname}${url.search}`,
      headers: req.headers,
      query: url.searchParams,
    });
    handler(req, res, url, requests.length);
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not provide a port.');
  }
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}

async function errorMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail('Expected the request to fail.');
}

test('uses method-specific auth, normalized URLs, and custom headers', async (t) => {
  const { origin, requests } = await startServer(t, (_req, res, _url, count) => {
    if (count <= 2) return json(res, 200, { data: [{ id: 'openai' }] });
    if (count === 3) return json(res, 200, { data: [{ id: 'messages' }] });
    return json(res, 200, {
      models: [{ name: 'models/gemini', supportedGenerationMethods: ['generateContent'] }],
    });
  });

  const responses = await fetchModels(
    draft('responses', `${origin}/gateway/v1/responses`, { 'X-Custom': 'yes' }, 'openai-key'),
  );
  const chat = await fetchModels(
    draft('chat', `${origin}/gateway/v1/chat/completions`, { 'X-Custom': 'yes' }, 'openai-key'),
  );
  const messages = await fetchModels(
    draft('messages', `${origin}/gateway/v1/messages`, { 'X-Custom': 'yes' }, 'messages-key'),
  );
  const google = await fetchModels(
    draft('generative', `${origin}/gateway/v1/models/gemini:generateContent`, { 'X-Custom': 'yes' }, 'google-key'),
  );

  assert.deepEqual(responses.map((model) => model.id), ['openai']);
  assert.deepEqual(chat.map((model) => model.id), ['openai']);
  assert.deepEqual(messages.map((model) => model.id), ['messages']);
  assert.deepEqual(google.map((model) => model.id), ['gemini']);

  assert.equal(requests[0].url, '/gateway/v1/models');
  assert.equal(requests[0].headers.authorization, 'Bearer openai-key');
  assert.equal(requests[1].headers.authorization, 'Bearer openai-key');
  assert.equal(requests[2].headers['x-api-key'], 'messages-key');
  assert.equal(requests[2].headers['anthropic-version'], '2023-06-01');
  assert.equal(requests[3].headers['x-goog-api-key'], 'google-key');
  for (const request of requests) assert.equal(request.headers['x-custom'], 'yes');
});

test('follows Anthropic and Google pagination with sorted, deduplicated IDs', async (t) => {
  const { origin } = await startServer(t, (_req, res, url) => {
    if (url.pathname === '/anthropic/v1/models') {
      if (!url.searchParams.get('after_id')) {
        return json(res, 200, { data: [{ id: 'b' }], has_more: true, last_id: 'b' });
      }
      return json(res, 200, { data: [{ id: 'a' }], has_more: false, last_id: 'a' });
    }
    if (url.pathname === '/google/v1beta/models') {
      if (!url.searchParams.get('pageToken')) {
        return json(res, 200, { models: [{ name: 'models/z' }], nextPageToken: 'next' });
      }
      return json(res, 200, { models: [{ name: 'models/a' }] });
    }
    return json(res, 404, {});
  });

  const anthropic = await fetchModels(draft('messages', `${origin}/anthropic`));
  const google = await fetchModels(draft('generative', `${origin}/google/v1beta`));
  assert.deepEqual(anthropic.map((model) => model.id), ['a', 'b']);
  assert.deepEqual(google.map((model) => model.id), ['a', 'z']);
});

test('maps conservative Google metadata and filters embedding-only models', async (t) => {
  const { origin } = await startServer(t, (_req, res, url) => {
    assert.equal(url.pathname, '/google/v1beta/models');
    return json(res, 200, {
      models: [
        {
          name: 'models/gemini',
          inputTokenLimit: 100,
          outputTokenLimit: 50,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        },
        {
          name: 'models/embedding',
          inputTokenLimit: 10,
          outputTokenLimit: 5,
          supportedGenerationMethods: ['embedContent'],
        },
      ],
    });
  });

  const models = await fetchModels(draft('generative', `${origin}/google/v1beta`));
  assert.equal(models.length, 1);
  assert.equal(models[0]?.id, 'gemini');
  assert.equal(models[0]?.contextWindow, 100);
  assert.equal(models[0]?.maxTokens, 50);
});

test('rejects repeated Google page tokens without exposing response bodies', async (t) => {
  const { origin } = await startServer(t, (_req, res) => {
    return json(res, 200, {
      models: [{ name: 'models/loop' }],
      nextPageToken: 'repeat',
      body: 'LOOP-MARKER',
    });
  });

  const message = await errorMessage(
    fetchModels(draft('generative', `${origin}/loop/v1beta`)),
  );
  assert.ok(!message.includes('LOOP-MARKER'));
});

test('classifies key checks and never includes response bodies in errors', async (t) => {
  const { origin } = await startServer(t, (_req, res, url) => {
    const status = url.pathname.match(/^\/status\/(401|403|404)\/v1\/models$/);
    if (status) {
      const code = Number(status[1]);
      return json(res, code, { error: `STATUS-MARKER-${code}` });
    }
    if (url.pathname === '/valid/v1/models') {
      return json(res, 200, { data: [{ id: 'model' }] });
    }
    if (url.pathname === '/empty/v1/models') return json(res, 200, { empty: 'EMPTY-MARKER' });
    if (url.pathname === '/bad/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      return res.end('MALFORMED-MARKER');
    }
    return json(res, 404, {});
  });

  const invalid = await checkKey(draft('responses', `${origin}/status/401`));
  assert.equal(invalid.status, 'invalid');
  assert.ok(!invalid.message.includes('STATUS-MARKER-401'));

  const forbidden = await checkKey(draft('responses', `${origin}/status/403`));
  assert.equal(forbidden.status, 'unknown');
  assert.ok(!forbidden.message.includes('STATUS-MARKER-403'));

  const missing = await checkKey(draft('responses', `${origin}/status/404`));
  assert.equal(missing.status, 'unknown');
  assert.ok(!missing.message.includes('STATUS-MARKER-404'));

  const valid = await checkKey(draft('responses', `${origin}/valid`));
  assert.equal(valid.status, 'valid');

  const empty = await checkKey(draft('responses', `${origin}/empty`));
  assert.equal(empty.status, 'unknown');
  assert.ok(!empty.message.includes('EMPTY-MARKER'));

  const malformed = await errorMessage(fetchModels(draft('responses', `${origin}/bad`)));
  assert.ok(!malformed.includes('MALFORMED-MARKER'));
});

test('refuses redirects without sending the key to the target', async (t) => {
  const { origin, requests } = await startServer(t, (_req, res, url) => {
    if (url.pathname === '/redirect/v1/models') {
      res.writeHead(302, { location: '/target/v1/models?marker=REDIRECT-MARKER', connection: 'close' });
      return res.end();
    }
    return json(res, 200, { data: [] });
  });

  const message = await errorMessage(fetchModels(draft('responses', `${origin}/redirect`)));
  assert.ok(!message.includes('REDIRECT-MARKER'));
  assert.ok(!message.includes('dummy-key'));
  assert.ok(requests.every((request) => !request.url.startsWith('/target/')));
});

test('honors abort signals', async (t) => {
  const { origin } = await startServer(t, (req, res, url) => {
    if (url.pathname !== '/slow/v1/models') return json(res, 404, {});
    const timer = setTimeout(() => json(res, 200, { data: [{ id: 'late' }] }), 100);
    req.on('close', () => clearTimeout(timer));
  });

  await assert.rejects(
    fetchModels(draft('responses', `${origin}/slow`), AbortSignal.timeout(10)),
  );
});
