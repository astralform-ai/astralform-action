// Runs the action's REAL script body against stubs and asserts its retry policy.
//
// The action is a composite step: the whole program is the inline `script` in
// action.yml, and the only way to test a policy like "retry 429, honour
// Retry-After, never retry 403" is to execute that text. Asserting on its shape
// would not catch an off-by-one in the attempt count or a backoff that never
// sleeps — the two ways a retry loop silently stops retrying.
//
// Usage: node scripts/check-dispatch.mjs <extracted-script.js>
// The extraction is the caller's job (`python3` + `yaml` in ci.yml), so this file
// never has to parse YAML.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scriptPath = process.argv[2];
if (!scriptPath) {
  console.error('usage: node scripts/check-dispatch.mjs <extracted-script.js>');
  process.exit(2);
}
const script = readFileSync(scriptPath, 'utf8');

// `github-script` wraps the body in an async function with `core`, `context`,
// `github` and `process` in scope. Reproduce that shape exactly, so the body runs
// as written — including its top-level `await` and bare `return`s.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * Run the script once against a scripted sequence of fetch outcomes.
 *
 * `responses` is consumed in order; the last entry repeats. An `Error` entry means
 * the fetch itself threw (a network failure).
 */
async function run({ responses, env = {} }) {
  const calls = [];
  const waits = []; // every sleep the script asked for, in ms
  const failed = [];
  const warnings = [];
  const outputs = {};
  let index = 0;

  const core = {
    setFailed: (message) => failed.push(String(message)),
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    info: () => {},
    warning: (message) => warnings.push(String(message)),
    getIDToken: async () => 'oidc-token',
  };

  const context = { repo: { owner: 'acme', repo: 'api' }, payload: {} };

  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: new Map(Object.entries(next.headers ?? {})),
      text: async () => next.body ?? '{}',
    };
  };

  // Shadowed rather than stubbed globally: the script calls `setTimeout`
  // unqualified, and a real one would make this test take as long as the backoff
  // it is asserting on.
  const setTimeoutStub = (fn, ms) => {
    waits.push(ms);
    fn();
    return 0;
  };

  const processShim = {
    env: {
      ASTRALFORM_AGENT: 'acme-reviewer',
      ASTRALFORM_API_URL: 'https://api.astralform.ai',
      ASTRALFORM_AUDIENCE: 'https://api.astralform.ai',
      ASTRALFORM_MODE: 'review',
      ...env,
    },
  };

  const body = new AsyncFunction('core', 'context', 'fetch', 'setTimeout', 'process', script);
  await body(core, context, fetchStub, setTimeoutStub, processShim);
  return { calls, waits, failed, warnings, outputs };
}

const ok = { status: 200, body: JSON.stringify({ status: 'accepted', agent: 'acme-reviewer' }) };
const throttled = (headers = {}) => ({
  status: 429,
  headers,
  body: JSON.stringify({ detail: 'Too many Astralform runs for this repository just now.' }),
});

// --- a throttle is retried, and the server's own timing is used ---------------
{
  const r = await run({ responses: [throttled({ 'retry-after': '1' }), ok] });

  assert.equal(r.calls.length, 2, 'a 429 must be retried once here');
  assert.deepEqual(r.waits, [1000], 'Retry-After must be honoured, in milliseconds');
  assert.deepEqual(r.failed, [], 'the retry succeeded, so nothing may fail');
  assert.equal(r.outputs.status, 'accepted', 'outputs come from the successful attempt');
  assert.match(r.warnings.join('\n'), /429/, 'the retry must be visible in the log');
}

// --- without Retry-After, backoff is jittered and bounded ---------------------
{
  const r = await run({ responses: [throttled(), throttled(), ok] });

  assert.equal(r.calls.length, 3);
  assert.equal(r.waits.length, 2);
  // First backoff: 500ms base, halved-to-full jitter. A constant delay here is
  // what makes a fleet of throttled workflows re-create the burst together.
  assert.ok(
    r.waits[0] >= 250 && r.waits[0] <= 500,
    `first backoff must be jittered within [250, 500]ms, got ${r.waits[0]}`,
  );
  assert.ok(
    r.waits[1] >= 500 && r.waits[1] <= 1000,
    `second backoff must double and stay jittered, got ${r.waits[1]}`,
  );
}

// --- an absurd Retry-After is capped -----------------------------------------
{
  const r = await run({ responses: [throttled({ 'retry-after': '3600' }), ok] });

  assert.equal(r.waits[0], 30000, 'Retry-After must be capped, or CI hangs for an hour');
}

// --- a refusal is NOT retried -------------------------------------------------
{
  const r = await run({
    responses: [
      { status: 403, body: JSON.stringify({ detail: 'Only people with write access.' }) },
    ],
  });

  assert.equal(r.calls.length, 1, 'a 403 is a configuration answer, not a throttle');
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0], /403/);
  assert.match(r.failed[0], /write access/, 'the server reason must reach the runner log');
  assert.doesNotMatch(r.failed[0], /attempts/);
}

// --- a 5xx is retried, and exhaustion is reported ----------------------------
{
  const r = await run({ responses: [{ status: 503, body: 'gateway' }] });

  assert.equal(r.calls.length, 4, 'a 503 must be retried up to the cap, then stop');
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0], /503/);
  assert.match(r.failed[0], /after 4 attempts/, 'an exhausted retry must say so');
}

// --- a network failure is retried, and its own error is reported --------------
{
  const r = await run({ responses: [new Error('ECONNRESET'), ok] });

  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.failed, []);

  const dead = await run({ responses: [new Error('ECONNRESET')] });
  assert.equal(dead.calls.length, 4);
  assert.match(dead.failed[0], /Could not reach Astralform/);
  assert.match(dead.failed[0], /ECONNRESET/);
}

// --- `already_queued` is passed through, not reported as failure --------------
{
  const r = await run({
    responses: [{ status: 200, body: JSON.stringify({ status: 'already_queued' }) }],
  });

  assert.deepEqual(r.failed, []);
  assert.equal(r.outputs.status, 'already_queued');
}

// --- the payload still carries mode, and the token is still a bearer header ---
{
  const r = await run({ responses: [ok] });
  const { url, init } = r.calls[0];

  assert.equal(url, 'https://api.astralform.ai/v1/github/dispatch');
  assert.equal(init.headers.Authorization, 'Bearer oidc-token');
  assert.equal(JSON.parse(init.body).mode, 'review');
}

console.log('dispatch retry policy ok');
