import type { Endpoint, Method } from './types.ts';

const reservedProviderIds = new Set(['__proto__', 'prototype', 'constructor']);

function fail(message: string): never {
  throw new Error(message);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}



function parseUrl(input: string): URL {
  const raw = input.trim();
  if (!raw) fail('Base URL is empty.');
  if (hasControlCharacters(raw)) fail('Base URL contains control characters.');

  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)
    ? raw
    : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('Unable to parse the base URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail('Only HTTP and HTTPS endpoints are supported.');
  }
  if (url.username || url.password || url.search || url.hash || raw.includes('?') || raw.includes('#')) {
    fail('Endpoint URLs cannot contain credentials, a query, or a fragment.');
  }
  if (!url.hostname) fail('Endpoint URL has no host.');

  return url;
}

function normalizePath(path: string): string {
  if (path === '' || path === '/') return '/';
  return path.endsWith('/') ? path.replace(/\/+$/, '') : path;
}

function removeSuffix(path: string, suffix: string): string {
  const lower = path.toLowerCase();
  if (lower === suffix) return '/';
  if (lower.endsWith(`${suffix}/`)) {
    return path.slice(0, path.length - suffix.length - 1) || '/';
  }
  if (lower.endsWith(suffix)) {
    return path.slice(0, path.length - suffix.length) || '/';
  }
  return path;
}

function appendPath(path: string, suffix: string): string {
  return (path === '/' ? '' : path) + suffix;
}

function urlFromPath(url: URL, path: string): string {
  return url.origin + (path === '/' ? '' : path);
}

function standardApiRoot(path: string): string {
  let result = normalizePath(path);
  result = removeSuffix(result, '/responses');
  result = removeSuffix(result, '/chat/completions');
  result = removeSuffix(result, '/messages');
  result = removeSuffix(result, '/models');
  result = removeSuffix(result, '/v1beta');
  result = removeSuffix(result, '/v1');
  return normalizePath(result);
}

function anthropicRoot(path: string): string {
  return standardApiRoot(path);
}

function stripGoogleModelPath(path: string): string {
  const marker = '/models/';
  const start = path.toLowerCase().indexOf(marker);
  if (start === -1) return path;
  const modelPart = path.slice(start + marker.length);
  const colon = modelPart.indexOf(':');
  if (colon > 0 && !modelPart.includes('/')) {
    const operation = modelPart.slice(colon + 1).toLowerCase();
    if (
      operation === 'generatecontent' ||
      operation === 'streamgeneratecontent'
    ) {
      return path.slice(0, start) || '/';
    }
  }
  return path;
}

function stripGoogleRouteAlias(path: string): string {
  const suffix = '/generativecontent';
  if (path.toLowerCase().endsWith(suffix)) {
    return path.slice(0, path.length - suffix.length) || '/';
  }
  return path;
}

function googleParts(path: string): { root: string; version: string } {
  let result = normalizePath(path);
  result = stripGoogleModelPath(result);
  result = stripGoogleRouteAlias(result);
  result = removeSuffix(result, '/models');

  const lower = result.toLowerCase();
  let version = '/v1beta';
  if (lower.endsWith('/v1beta')) {
    version = '/v1beta';
    result = normalizePath(
      result.slice(0, result.length - '/v1beta'.length) || '/',
    );
  } else if (lower.endsWith('/v1')) {
    version = '/v1';
    result = normalizePath(
      result.slice(0, result.length - '/v1'.length) || '/',
    );
  }
  return { root: normalizePath(result), version };
}

export function normalizeEndpoint(input: string, method: Method): Endpoint {
  const url = parseUrl(input);
  let path = stripGoogleRouteAlias(stripGoogleModelPath(normalizePath(url.pathname)));
  for (const suffix of ['/responses', '/chat/completions', '/messages']) path = removeSuffix(path, suffix);

  if (method === 'generative') {
    const google = googleParts(path);
    const baseUrlPath = appendPath(google.root, google.version);
    const modelsPath = appendPath(baseUrlPath, '/models');
    return {
      root: urlFromPath(url, google.root),
      baseUrl: urlFromPath(url, baseUrlPath),
      modelsUrl: urlFromPath(url, modelsPath),
      api: 'google-generative-ai',
    };
  }

  if (method === 'messages') {
    const root = anthropicRoot(path);
    const modelsPath = appendPath(root, '/v1/models');
    return {
      root: urlFromPath(url, root),
      baseUrl: urlFromPath(url, root),
      modelsUrl: urlFromPath(url, modelsPath),
      api: 'anthropic-messages',
    };
  }

  if (method !== 'responses' && method !== 'chat') {
    fail('Unsupported provider method.');
  }

  const root = standardApiRoot(path);
  const baseUrlPath = appendPath(root, '/v1');
  const modelsPath = appendPath(baseUrlPath, '/models');
  return {
    root: urlFromPath(url, root),
    baseUrl: urlFromPath(url, baseUrlPath),
    modelsUrl: urlFromPath(url, modelsPath),
    api: method === 'responses' ? 'openai-responses' : 'openai-completions',
  };
}

function hostLabel(url: URL): string {
  let host = url.hostname;
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  if (/^www\./i.test(host)) host = host.slice(4);
  const defaultPort =
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80');
  if (url.port && !defaultPort) host = `${host}:${url.port}`;
  return host;
}

export function displayProviderName(name: string, baseUrl: string): string {
  const trimmed = name.trim();
  if (trimmed) return trimmed;
  const url = parseUrl(baseUrl);
  const host = url.hostname;
  if (!host) fail('Unable to derive a provider name from the endpoint host.');
  return host;
}

function slug(value: string): string {
  const folded = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const cleaned = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return cleaned.slice(0, 64).replace(/-+$/, '');
}

export function providerId(name: string, baseUrl: string): string {
  const trimmed = name.trim();
  if (reservedProviderIds.has(trimmed.toLowerCase())) {
    fail('Provider ID is reserved and cannot be used.');
  }

  const url = parseUrl(baseUrl);
  const host = hostLabel(url);
  const display = trimmed || host;
  let id = slug(display);
  if (!id) id = slug(host);
  if (!id) fail('Unable to derive a provider ID.');
  if (reservedProviderIds.has(id)) {
    fail('Provider ID is reserved and cannot be used.');
  }
  return id;
}
