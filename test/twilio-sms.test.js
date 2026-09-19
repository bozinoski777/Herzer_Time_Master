"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTwilioClient, TwilioRequestError } = require("../scripts/twilio-sms");

const environment = {
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
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
  const client = createTwilioClient({ ...environment, ...overrides }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      assert.ok(responses.length > 0, "Unexpected extra Twilio request");
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { client, calls };
}

test("sends through the US1 Messaging Service with the account Auth Token", async () => {
  const { client, calls } = setup([response(201, accepted)]);
  assert.deepEqual(await client.sendSms(message), accepted);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, `https://api.twilio.com/2010-04-01/Accounts/${environment.TWILIO_ACCOUNT_SID}/Messages.json`);
  assert.equal(call.method, "POST");
  assert.equal(Buffer.from(call.headers.Authorization.slice("Basic ".length), "base64").toString(),
    `${environment.TWILIO_ACCOUNT_SID}:${environment.TWILIO_AUTH_TOKEN}`);
  assert.equal(call.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(call.redirect, "error");
  assert.ok(call.signal instanceof AbortSignal);
  assert.deepEqual(Object.fromEntries(call.body), {
    To: message.to, Body: message.body, MessagingServiceSid: environment.TWILIO_MESSAGING_SERVICE_SID,
  });
});

test("trims accidental whitespace in GitHub secret values", async () => {
  const overrides = Object.fromEntries(Object.entries(environment).map(([name, value]) => [name, ` ${value}\n`]));
  const { client, calls } = setup([response(201, accepted)], overrides);
  await client.sendSms(message);
  assert.equal(Buffer.from(calls[0].headers.Authorization.slice("Basic ".length), "base64").toString(),
    `${environment.TWILIO_ACCOUNT_SID}:${environment.TWILIO_AUTH_TOKEN}`);
  assert.equal(calls[0].body.get("MessagingServiceSid"), environment.TWILIO_MESSAGING_SERVICE_SID);
});

test("validates all required configuration before any request without exposing values", () => {
  const invalid = "private-invalid-value";
  const cases = [
    [{ TWILIO_ACCOUNT_SID: "" }, /TWILIO_ACCOUNT_SID must/],
    [{ TWILIO_ACCOUNT_SID: invalid }, /TWILIO_ACCOUNT_SID must/],
    [{ TWILIO_AUTH_TOKEN: " \n" }, /TWILIO_AUTH_TOKEN is required/],
    [{ TWILIO_MESSAGING_SERVICE_SID: "" }, /TWILIO_MESSAGING_SERVICE_SID must/],
    [{ TWILIO_MESSAGING_SERVICE_SID: invalid }, /TWILIO_MESSAGING_SERVICE_SID must/],
  ];
  for (const [overrides, expected] of cases) {
    assert.throws(() => setup([], overrides), (error) => {
      assert.match(error.message, expected);
      assert.equal(error.message.includes(invalid), false);
      return true;
    });
  }
});

for (const status of [400, 401, 403, 429]) {
  test(`HTTP ${status} is a confirmed failure with no automatic retry`, async () => {
    const { client, calls } = setup([response(status, { code: 20003 })]);
    await assert.rejects(client.sendSms(message), (error) => {
      assert.ok(error instanceof TwilioRequestError);
      assert.equal(error.certainty, "failed");
      assert.match(error.message, /code 20003/);
      assert.ok(error.message.includes(`HTTP ${status}`));
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

test("server errors are uncertain and never retried", async () => {
  const { client, calls } = setup([response(500, { code: 20500 })]);
  await assert.rejects(client.sendSms(message), { certainty: "uncertain" });
  assert.equal(calls.length, 1);
});

test("network failures and response read failures are uncertain without exposing request data", async () => {
  const failure = new Error(`${message.to} ${message.body} ${environment.TWILIO_AUTH_TOKEN}`);
  for (const next of [failure, { status: 201, ok: true, text: async () => { throw failure; } }]) {
    const { client, calls } = setup([next]);
    await assert.rejects(client.sendSms(message), (error) => {
      assert.ok(error instanceof TwilioRequestError);
      assert.equal(error.certainty, "uncertain");
      assert.match(error.message, /no retry was attempted/);
      for (const privateValue of [message.to, message.body, environment.TWILIO_AUTH_TOKEN]) {
        assert.equal(error.message.includes(privateValue), false);
      }
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test("unconfirmed success responses never allow an automatic resend", async () => {
  for (const rawBody of ["", "not JSON", "null", "{}", '{"sid":123}', '{"sid":""}']) {
    const { client, calls } = setup([{ status: 201, ok: true, text: async () => rawBody }]);
    await assert.rejects(client.sendSms(message), { certainty: "uncertain" });
    assert.equal(calls.length, 1);
  }
});

test("a non-JSON rejection preserves the HTTP failure classification", async () => {
  const { client, calls } = setup([{ status: 403, ok: false, text: async () => "<html>Forbidden</html>" }]);
  await assert.rejects(client.sendSms(message), {
    certainty: "failed", message: "Twilio SMS request failed: HTTP 403.",
  });
  assert.equal(calls.length, 1);
});

test("keeps the sending rejection reason while redacting credentials and message content", async () => {
  const reason = "Primary compliance profile is not approved.";
  const encodedCredentials = Buffer.from(`${environment.TWILIO_ACCOUNT_SID}:${environment.TWILIO_AUTH_TOKEN}`).toString("base64");
  const privateValues = [
    ...Object.values(environment), encodedCredentials, message.to, message.body,
    "https://www.notion.so/private-worker", "+491709876543", `SK${"9".repeat(32)}`,
  ];
  const { client } = setup([response(401, { code: 20003, message: `${reason}\n${privateValues.join(" ")}` })]);
  await assert.rejects(client.sendSms(message), (error) => {
    assert.equal(error.certainty, "failed");
    assert.ok(error.message.includes(reason));
    assert.match(error.message, /code 20003.*HTTP 401/);
    assert.match(error.message, /\[redacted\]/);
    for (const privateValue of privateValues) assert.equal(error.message.includes(privateValue), false);
    assert.equal(error.message.includes("\n"), false);
    return true;
  });
});

test("error codes and long provider messages cannot flood logs with private data", async () => {
  const { client } = setup([response(400, {
    code: message.to,
    message: `Sending denied. ${"More detail. ".repeat(200)}`,
  })]);
  await assert.rejects(client.sendSms(message), (error) => {
    assert.equal(error.certainty, "failed");
    assert.match(error.message, /^Twilio SMS request failed: HTTP 400\. Sending denied\./);
    assert.equal(error.message.includes(message.to), false);
    assert.ok(error.message.length < 900);
    return true;
  });
});
