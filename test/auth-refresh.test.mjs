import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import timers from "node:timers/promises";
import { refreshAnthropicToken } from "../.test-dist/auth.js";
import { AuthStorage } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";

function credential(expires = Date.now() + 60_000) {
  return { type: "oauth", access: "old-test-access", refresh: "old-test-refresh", expires };
}

test("an already-cancelled refresh neither fetches nor returns a cooldown credential", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Must not fetch");
  });
  const reason = new Error("cancelled");
  const current = { ...credential(), refreshRetryAt: Date.now() + 30_000 };
  await assert.rejects(
    refreshAnthropicToken(current, AbortSignal.abort(reason)),
    (error) => error === reason,
  );
  assert.equal(fetch.mock.callCount(), 0);
});

for (const reason of [new TypeError("cancelled"), new DOMException("refresh timed out", "TimeoutError")]) {
  test(`refresh forwards the signal and propagates ${reason.name} without grace`, async (t) => {
    const controller = new AbortController();
    const current = credential();
    const before = structuredClone(current);
    const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(init.signal, controller.signal);
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        queueMicrotask(() => controller.abort(reason));
      });
    });
    await assert.rejects(refreshAnthropicToken(current, controller.signal), (error) => error === reason);
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(current, before);
  });
}

test("cancelling a Retry-After wait stops immediately without another refresh", async (t) => {
  const controller = new AbortController();
  const reason = new Error("cancelled during backoff");
  const sleep = timers.setTimeout;
  const wait = t.mock.method(timers, "setTimeout", (delay, value, options) => {
    assert.equal(delay, 30_000);
    assert.equal(options.signal, controller.signal);
    const pending = sleep(delay, value, options);
    controller.abort(reason);
    return pending;
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("busy", {
    status: 429, headers: { "retry-after": "30" },
  }));
  await assert.rejects(refreshAnthropicToken(credential(), controller.signal), (error) => error === reason);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(wait.mock.callCount(), 1);
});

test("cooldown survives serialization, keeps the original expiry, and retries after 30 seconds", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new TypeError("offline"); });
  const current = credential(now + 100_000);
  const first = await refreshAnthropicToken(current);
  assert.equal(first.expires, current.expires);
  assert.equal(first.refreshRetryAt, now + 30_000);
  assert.equal(current.refreshRetryAt, undefined);

  const saved = JSON.parse(JSON.stringify(first));
  now += 29_999;
  assert.deepEqual(await refreshAnthropicToken(saved), saved);
  assert.equal(fetch.mock.callCount(), 1);
  now++;
  const second = await refreshAnthropicToken(saved);
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(second.expires, current.expires);
  assert.equal(second.refreshRetryAt, now + 30_000);
});

test("cooldown never keeps an expired credential alive", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new TypeError("offline"); });
  const current = credential(now + 10_000);
  const saved = await refreshAnthropicToken(current);
  assert.equal(saved.refreshRetryAt, current.expires);
  now = current.expires;
  await assert.rejects(refreshAnthropicToken(saved), /Token refresh failed: offline/);
  assert.equal(fetch.mock.callCount(), 2);
});

test("a credential expiring during refresh is not returned as a fallback", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const current = credential(now + 10_000);
  t.mock.method(globalThis, "fetch", async () => {
    now = current.expires;
    throw new TypeError("offline");
  });
  await assert.rejects(refreshAnthropicToken(current), /Token refresh failed: offline/);
});

test("successful refresh clears cooldown and retains the old refresh token if none is returned", async (t) => {
  const now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const current = { ...credential(now + 60_000), refreshRetryAt: now };
  for (const refresh of ["rotated-test-refresh", undefined]) {
    t.mock.method(globalThis, "fetch", async () => Response.json({
      access_token: "new-test-access", refresh_token: refresh, expires_in: 3600,
    }));
    const updated = await refreshAnthropicToken(current);
    assert.equal(updated.access, "new-test-access");
    assert.equal(updated.refresh, refresh ?? current.refresh);
    assert.equal(updated.expires, now + (3600 - 300) * 1000);
    assert.equal(Object.hasOwn(updated, "refreshRetryAt"), false);
  }
});

test("invalid_grant after cooldown is surfaced without extending the credential", async (t) => {
  const now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const current = { ...credential(now + 60_000), refreshRetryAt: now };
  const before = structuredClone(current);
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(
    { error: "invalid_grant" }, { status: 400 },
  ));
  await assert.rejects(refreshAnthropicToken(current), /Token refresh failed:.*400.*invalid_grant/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(current, before);
});

test("four Pi processes share cooldown and persist a single rotated credential", { timeout: 15_000 }, async (t) => {
  const dir = mkdtempSync(".test-dist/oauth-refresh-");
  const authPath = join(dir, "auth.json");
  const store = AuthStorage.create(authPath);
  const children = [];
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  const current = credential(Date.now() + 4 * 60_000);
  await store.modify("anthropic", () => current);
  let validRefresh = current.refresh;

  async function runWorkers(temporaryFailure) {
    const round = [];
    const results = [];
    let ready = 0;
    let exchanges = 0;
    const completions = Array.from({ length: 4 }, () => {
      const child = fork(new URL("./fixtures/oauth-refresh-worker.mjs", import.meta.url), [authPath], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);
      round.push(child);
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("message", (message) => {
        if (message.type === "ready") {
          if (++ready === 4) for (const worker of round) worker.send({ type: "start" });
        } else if (message.type === "refresh") {
          exchanges++;
          if (temporaryFailure) child.send({ networkError: true });
          else if (message.token !== validRefresh) {
            child.send({ status: 400, body: { error: "invalid_grant" } });
          } else {
            validRefresh = "rotated-test-refresh";
            child.send({ status: 200, body: {
              access_token: "new-test-access", refresh_token: validRefresh, expires_in: 3600,
            } });
          }
        } else results.push(message);
      });
      return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || JSON.stringify(results))));
      });
    });
    await Promise.all(completions);
    assert.equal(results.length, 4);
    assert.ok(results.every((result) => result.type === "result"));
    return { exchanges, access: results.map((result) => result.access) };
  }

  const failedRefresh = await runWorkers(true);
  assert.equal(failedRefresh.exchanges, 1);
  assert.deepEqual(failedRefresh.access, Array(4).fill(current.access));
  const saved = await store.read("anthropic");
  assert.equal(saved.expires, current.expires);
  assert.ok(saved.refreshRetryAt > Date.now());

  // New processes must honor the persisted cooldown, not process-local state.
  assert.equal((await runWorkers(true)).exchanges, 0);
  await store.modify("anthropic", async (value) => ({ ...value, refreshRetryAt: Date.now() - 1 }));
  const recovered = await runWorkers(false);
  assert.equal(recovered.exchanges, 1);
  assert.deepEqual(recovered.access, Array(4).fill("new-test-access"));
  const rotated = await store.read("anthropic");
  assert.equal(rotated.refresh, "rotated-test-refresh");
  assert.equal(Object.hasOwn(rotated, "refreshRetryAt"), false);
});
