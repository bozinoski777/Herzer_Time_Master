"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createTwilioClient, twilioAuthentication } = require("../scripts/twilio-sms");

const environment = {
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${"2".repeat(32)}`,
  TWILIO_API_KEY_SECRET: "api-key-secret",
  TWILIO_AUTH_TOKEN: "account-auth-token",
  TWILIO_MESSAGING_SERVICE_SID: `MG${"3".repeat(32)}`,
};
const message = { to: "+491701234567", body: "Private reminder" };
const accepted = { sid: `SM${"4".repeat(32)}`, status: "queued" };

function response(status, payload) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(payload) };
}

function setup(responses, overrides = {}) {
  const calls = [];
  const logs = [];
  const client = createTwilioClient({ ...environment, ...overrides }, {
    log: (message) => logs.push(message),
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      assert.ok(responses.length > 0, "Unexpected extra Twilio request");
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { client, calls, logs };
}

function credentials(call) {
  return Buffer.from(call.headers.Authorization.slice("Basic ".length), "base64").toString();
}

test("401 / 20003 falls back to the account token and reuses it for the next worker", async () => {
  const { client, calls, logs } = setup([
    response(401, { code: 20003, message: "Authentication Error" }),
    response(201, accepted),
    response(201, accepted),
  ]);
  assert.deepEqual(await client.sendSms(message), accepted);
  await client.sendSms(message);
  assert.equal(calls.length, 3);
  assert.equal(credentials(calls[0]), `${environment.TWILIO_API_KEY_SID}:api-key-secret`);
  assert.equal(credentials(calls[1]), `${environment.TWILIO_ACCOUNT_SID}:account-auth-token`);
  assert.equal(credentials(calls[2]), credentials(calls[1]));
  assert.equal(calls[0].url, `https://api.twilio.com/2010-04-01/Accounts/${environment.TWILIO_ACCOUNT_SID}/Messages.json`);
  for (const call of calls) {
    assert.equal(call.method, "POST");
    assert.equal(call.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.equal(call.redirect, "error");
    assert.ok(call.signal instanceof AbortSignal);
    assert.deepEqual(Object.fromEntries(call.body), {
      To: message.to, Body: message.body, MessagingServiceSid: environment.TWILIO_MESSAGING_SERVICE_SID,
    });
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /trying the configured Auth Token once/);
});

test("forced auth-token bypasses stale or incomplete API key settings", async () => {
  const { client, calls } = setup([response(201, accepted)], {
    TWILIO_AUTH_MODE: "auth-token", TWILIO_API_KEY_SID: "wrong", TWILIO_API_KEY_SECRET: "",
  });
  await client.sendSms(message);
  assert.equal(calls.length, 1);
  assert.equal(credentials(calls[0]), `${environment.TWILIO_ACCOUNT_SID}:account-auth-token`);
});

test("explicit api-key mode never falls back to the token", async () => {
  const { client, calls } = setup([response(401, { code: 20003 })], { TWILIO_AUTH_MODE: "api-key" });
  await assert.rejects(client.sendSms(message), { certainty: "failed" });
  assert.equal(calls.length, 1);
});

test("an API key with no configured token does not retry", async () => {
  const { client, calls } = setup([response(401, { code: 20003 })], { TWILIO_AUTH_TOKEN: "" });
  await assert.rejects(client.sendSms(message), { certainty: "failed" });
  assert.equal(calls.length, 1);
});

test("both rejected credential pairs produce an actionable error without leaking data", async () => {
  const privateError = `${message.to} ${message.body} ${environment.TWILIO_API_KEY_SECRET}`;
  const { client, calls, logs } = setup([
    response(401, { code: 20003, message: privateError }),
    response(401, { code: 20003, message: privateError }),
  ]);
  await assert.rejects(client.sendSms(message), (error) => {
    assert.equal(error.certainty, "failed");
    assert.match(error.message, /authentication=api-key then auth-token; region=us1/);
    assert.match(error.message, /same account\/subaccount and region/);
    const output = [...logs, error.message].join("\n");
    for (const secret of [...Object.values(environment), message.to, message.body]) {
      assert.equal(output.includes(secret), false);
    }
    return true;
  });
  assert.equal(calls.length, 2);
});

for (const [status, code, certainty] of [[400, 21211, "failed"], [403, 20003, "failed"], [429, 20429, "failed"], [500, 20003, "uncertain"], [401, 99999, "failed"]]) {
  test(`HTTP ${status} / code ${code} never triggers credential fallback`, async () => {
    const { client, calls } = setup([response(status, { code })]);
    await assert.rejects(client.sendSms(message), { certainty });
    assert.equal(calls.length, 1);
  });
}

test("a network failure or unreadable response is uncertain and is never retried", async () => {
  for (const result of [
    new Error("socket disconnected with private data"),
    { status: 201, ok: true, text: async () => { throw new Error("connection lost"); } },
  ]) {
    const { client, calls } = setup([result]);
    await assert.rejects(client.sendSms(message), (error) => {
      assert.equal(error.certainty, "uncertain");
      assert.match(error.message, /no retry was attempted/);
      assert.doesNotMatch(error.message, /private data|connection lost/);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test("a success without a Message SID is uncertain and is never retried", async () => {
  const { client, calls } = setup([response(201, { status: "queued" })]);
  await assert.rejects(client.sendSms(message), { certainty: "uncertain" });
  assert.equal(calls.length, 1);
});

test("a malformed authentication response does not authorize another send", async () => {
  const { client, calls } = setup([{ status: 401, ok: false, text: async () => "not JSON" }]);
  await assert.rejects(client.sendSms(message), { certainty: "failed" });
  assert.equal(calls.length, 1);
});

test("credential check reads Messages with the same authentication fallback and never prints records", async () => {
  const { client, calls, logs } = setup([
    response(401, { code: 20003 }),
    response(200, { messages: [{ to: message.to, body: message.body }] }),
  ], { TWILIO_MESSAGING_SERVICE_SID: "", TWILIO_FROM_NUMBER: "" });
  assert.deepEqual(await client.checkCredentials(), { authentication: "auth-token", region: "us1" });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.method, "GET");
    assert.match(call.url, /\/Messages.json\?PageSize=1$/);
    assert.equal(call.body, undefined);
  }
  assert.match(logs.at(-1), /no SMS sent/);
  assert.equal(logs.join("\n").includes(message.to), false);
  assert.equal(logs.join("\n").includes(message.body), false);
});

test("a restricted key read-permission failure does not fall back to broader credentials", async () => {
  const { client, calls } = setup([response(403, { code: 20403 })]);
  await assert.rejects(client.checkCredentials(), /Messages read permission/);
  assert.equal(calls.length, 1);
});

test("credential check rejects unexpected success responses", async () => {
  const { client } = setup([response(200, {})]);
  await assert.rejects(client.checkCredentials(), /unexpected response/);
});

test("IE1 uses the regional host for both checks and sends", async () => {
  const { client, calls } = setup([response(200, { messages: [] }), response(201, accepted)], { TWILIO_REGION: " IE1 " });
  await client.checkCredentials();
  await client.sendSms(message);
  for (const call of calls) assert.equal(new URL(call.url).hostname, "api.dublin.ie1.twilio.com");
});

test("invalid credential configuration fails before any request without echoing values", () => {
  for (const [overrides, expected] of [
    [{ TWILIO_ACCOUNT_SID: "private-invalid-account" }, /TWILIO_ACCOUNT_SID must/],
    [{ TWILIO_API_KEY_SID: "private-invalid-key" }, /TWILIO_API_KEY_SID must/],
    [{ TWILIO_API_KEY_SECRET: "" }, /Set both/],
    [{ TWILIO_AUTH_MODE: "private-invalid-mode" }, /TWILIO_AUTH_MODE must/],
    [{ TWILIO_REGION: "private-invalid-region" }, /TWILIO_REGION must/],
    [{ TWILIO_REGION: "constructor" }, /TWILIO_REGION must/],
    [{ TWILIO_AUTH_MODE: "auth-token", TWILIO_AUTH_TOKEN: "" }, /Missing Twilio authentication/],
  ]) {
    assert.throws(() => createTwilioClient({ ...environment, ...overrides }), (error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private-invalid/);
      return true;
    });
  }
});

test("authentication trims pasted whitespace and uses the supplied account, not process state", () => {
  assert.deepEqual(twilioAuthentication({
    ...environment, TWILIO_AUTH_MODE: "auth-token", TWILIO_ACCOUNT_SID: ` ${environment.TWILIO_ACCOUNT_SID}\n`, TWILIO_AUTH_TOKEN: " token\n",
  }), { type: "auth-token", username: environment.TWILIO_ACCOUNT_SID, password: "token" });
});

test("the credential-check command works without Notion, a sender, or a reminder date", () => {
  const script = `
    globalThis.fetch = async (url, options) => {
      if (options.method !== "GET") throw new Error("Unexpected side effect");
      const payload = url.endsWith("/Messages.json?PageSize=1")
        ? { messages: [] }
        : { sid: process.env.TWILIO_ACCOUNT_SID, status: "active" };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
    process.argv[1] = require.resolve("./scripts/twilio-sms.js");
    require("node:module").runMain();
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: require("node:path").resolve(__dirname, ".."),
    env: { TWILIO_ACCOUNT_SID: environment.TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN: environment.TWILIO_AUTH_TOKEN },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /credential check passed/);
  assert.match(result.stdout, /no SMS sent/);
});

const activeAccount = { sid: environment.TWILIO_ACCOUNT_SID, status: "active", auth_token: "private-account-token" };
const matchingService = { sid: environment.TWILIO_MESSAGING_SERVICE_SID, account_sid: environment.TWILIO_ACCOUNT_SID };

test("configuration check verifies account and service ownership with reads only", async () => {
  const { client, calls, logs } = setup([
    response(200, { messages: [] }), response(200, activeAccount), response(200, matchingService),
  ], { TWILIO_AUTH_MODE: "auth-token" });
  await client.checkConfiguration();
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, `https://api.twilio.com/2010-04-01/Accounts/${environment.TWILIO_ACCOUNT_SID}.json`);
  assert.equal(calls[2].url, `https://messaging.twilio.com/v1/Services/${environment.TWILIO_MESSAGING_SERVICE_SID}`);
  for (const call of calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.body, undefined);
    assert.equal(credentials(call), `${environment.TWILIO_ACCOUNT_SID}:account-auth-token`);
  }
  assert.match(logs.join("\n"), /account status: active/);
  assert.match(logs.join("\n"), /belongs to the configured account/);
  for (const secret of [...Object.values(environment), activeAccount.auth_token]) {
    assert.equal(logs.join("\n").includes(secret), false);
  }
});

test("a service belonging to another account fails the check without exposing either account", async () => {
  const otherAccount = `AC${"9".repeat(32)}`;
  const { client, calls } = setup([
    response(200, { messages: [] }), response(200, activeAccount),
    response(200, { ...matchingService, account_sid: otherAccount }),
  ], { TWILIO_AUTH_MODE: "auth-token" });
  await assert.rejects(client.checkConfiguration(), (error) => {
    assert.equal(error.certainty, "failed");
    assert.match(error.message, /belongs to a different account/);
    assert.equal(error.message.includes(otherAccount), false);
    assert.equal(error.message.includes(environment.TWILIO_ACCOUNT_SID), false);
    return true;
  });
  assert.ok(calls.every((call) => call.method === "GET"));
});

for (const status of ["suspended", "closed"]) {
  test(`configuration check identifies an account that is ${status}`, async () => {
    const { client, calls } = setup([
      response(200, { messages: [] }), response(200, { ...activeAccount, status }),
    ], { TWILIO_AUTH_MODE: "auth-token" });
    await assert.rejects(client.checkConfiguration(), new RegExp(`account status is ${status}`));
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.method === "GET"));
  });
}

for (const status of [401, 403, 404]) {
  test(`service HTTP ${status} after a successful credential check does not switch credentials`, async () => {
    const { client, calls } = setup([
      response(200, { messages: [] }), response(status, { code: status === 404 ? 20404 : 20003 }),
    ]);
    await assert.rejects(client.checkConfiguration(), /Messages authentication passed, but the configured Messaging Service is inaccessible/);
    assert.equal(calls.length, 2);
    assert.equal(credentials(calls[0]), credentials(calls[1]));
    assert.ok(calls.every((call) => call.method === "GET"));
  });
}

test("API-key configuration checks skip Accounts and keep service requests in IE1", async () => {
  const { client, calls, logs } = setup([
    response(200, { messages: [] }), response(200, matchingService),
  ], { TWILIO_REGION: "ie1" });
  await client.checkConfiguration();
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).hostname, "messaging.dublin.ie1.twilio.com");
  assert.match(logs.join("\n"), /Account status check skipped/);
});

test("auth-token send denial points to account and sender checks instead of selecting auth-token again", async () => {
  const { client, calls } = setup([response(401, { code: 20003 })], { TWILIO_AUTH_MODE: "auth-token" });
  await assert.rejects(client.sendSms(message), (error) => {
    assert.match(error.message, /account status and Messaging Service ownership/);
    assert.doesNotMatch(error.message, /Select auth-token|TWILIO_API_KEY_SECRET/);
    return true;
  });
  assert.equal(calls.length, 1);
});
