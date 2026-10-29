import test from "node:test";
import assert from "node:assert/strict";

import {
  SKINS,
  literalConfigValue,
  profileHeaders,
  validateHeader,
} from "../src/headers.ts";
import type { Method, Skin } from "../src/types.ts";
import { isCommandConfigValue, resolveConfigValue } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js";

const METHODS: readonly Method[] = [
  "responses",
  "messages",
  "chat",
  "generative",
];

test("exports the four ordered skins", () => {
  assert.deepEqual(
    SKINS.map((skin) => skin.id),
    ["pi", "claude-code", "codex", "opencode"],
  );

  for (const skin of SKINS) {
    assert.equal(typeof skin.label, "string");
    assert.ok(skin.label.length > 0);
    assert.equal(typeof skin.description, "string");
    assert.ok(skin.description.length > 0);
  }
});

test("Pi profile supplies no headers for every method", () => {
  for (const method of METHODS) {
    assert.deepEqual(profileHeaders("pi", method), {});
  }
});

test("Claude Code profile supplies branding on every method", () => {
  for (const method of METHODS) {
    const expected =
      method === "messages"
        ? {
            "User-Agent": "claude-cli/2.1.310",
            "x-app": "cli",
          }
        : { "User-Agent": "claude-cli/2.1.310" };

    assert.deepEqual(profileHeaders("claude-code", method), expected);
  }
});

test("Codex profile supplies branding on every method", () => {
  for (const method of METHODS) {
    assert.deepEqual(profileHeaders("codex", method), {
      "User-Agent": "codex_cli_rs/0.165.0",
    });
  }
});

test("OpenCode profile applies to every method", () => {
  for (const method of METHODS) {
    assert.deepEqual(profileHeaders("opencode", method), {
      "x-opencode-client": "opencode",
    });
  }
});

test("profile headers are valid and non-managed", () => {
  for (const skin of SKINS) {
    for (const method of METHODS) {
      for (const [name, value] of Object.entries(
        profileHeaders(skin.id as Skin, method),
      )) {
        assert.doesNotThrow(() => validateHeader(name, value));
      }
    }
  }
});

test("profile headers return a fresh object", () => {
  const first = profileHeaders("claude-code", "messages");
  first["User-Agent"] = "changed";

  const second = profileHeaders("claude-code", "messages");
  assert.notEqual(first, second);
  assert.equal(second["User-Agent"], "claude-cli/2.1.310");
});

test("valid custom headers are accepted, including the RFC token backtick", () => {
  assert.doesNotThrow(() => validateHeader("X-Custom", "value"));
  assert.doesNotThrow(() => validateHeader("user-agent", "override"));
  assert.doesNotThrow(() => validateHeader("X-Empty", ""));
  assert.doesNotThrow(() => validateHeader("X-`Token`", "value"));
});

test("invalid header names and values are rejected", () => {
  assert.throws(() => validateHeader("", "value"));
  assert.throws(() => validateHeader("Bad Name", "value"));
  assert.throws(() => validateHeader("Bad\nName", "value"));
  assert.throws(() => validateHeader("X-Custom", "bad\nvalue"));
  assert.throws(() => validateHeader("X-Custom", "bad\u0000value"));
  assert.throws(() => validateHeader("X-Custom", "bad\u007fvalue"));
  assert.throws(() => validateHeader("X-Custom", "café"));
});

test("authentication and transport headers are rejected", () => {
  const forbiddenNames = [
    "Authorization",
    "Proxy-Authorization",
    "Api-Key",
    "X-Api-Key",
    "X-Goog-Api-Key",
    "Content-Length",
    "Host",
    "Connection",
    "Transfer-Encoding",
  ];

  for (const name of forbiddenNames) {
    assert.throws(() => validateHeader(name, "value"));
  }
});

test("validation errors do not expose header values", () => {
  assert.throws(
    () => validateHeader("X-Secret", "secret\nvalue"),
    /Invalid value for header: X-Secret/,
  );
});

test("literalConfigValue escapes Pi interpolation and round-trips safely", () => {
  const cases: readonly [string, string][] = [
    ["", ""],
    ["safe", "safe"],
    ["$HOME", "$$HOME"],
    ["a$b$c", "a$$b$$c"],
    ["!command", "$!command"],
    ["!!command", "$!!command"],
    ["!$HOME", "$!$$HOME"],
    ["safe!", "safe!"],
    ["$!", "$$!"],
    ["`backtick`", "`backtick`"],
  ];

  for (const [input, expected] of cases) {
    const escaped = literalConfigValue(input);
    assert.equal(escaped, expected);
    assert.equal(isCommandConfigValue(escaped), false);
    assert.equal(resolveConfigValue(escaped), input);
  }
});
