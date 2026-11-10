import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_CODE_VERSION_ENV,
  getClaudeCodeVersion,
  makeClaudeCodeUserAgent,
} from "../.test-dist/version.js";

test("user agent uses the claude-cli form with the default version", () => {
  const version = getClaudeCodeVersion({});
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(makeClaudeCodeUserAgent({}), `claude-cli/${version} (external, sdk-cli)`);
});

test("version override is honoured and trimmed", () => {
  const env = { [CLAUDE_CODE_VERSION_ENV]: " test-version " };
  assert.equal(getClaudeCodeVersion(env), "test-version");
  assert.equal(makeClaudeCodeUserAgent(env), "claude-cli/test-version (external, sdk-cli)");
});

test("blank override falls back to the default", () => {
  assert.equal(
    getClaudeCodeVersion({ [CLAUDE_CODE_VERSION_ENV]: "  " }),
    getClaudeCodeVersion({}),
  );
});
