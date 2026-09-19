"use strict";

// Keep authentication and transport shared by reminders and the read-only check.
function value(environment, name) {
  return String(environment[name] || "").trim();
}

function accountSid(environment) {
  const sid = value(environment, "TWILIO_ACCOUNT_SID");
  if (!/^AC[0-9a-f]{32}$/i.test(sid)) {
    throw new Error("TWILIO_ACCOUNT_SID must be the account's AC SID (AC followed by 32 hexadecimal characters).");
  }
  return sid;
}

function authenticationMode(environment) {
  const mode = value(environment, "TWILIO_AUTH_MODE") || "auto";
  if (!["auto", "api-key", "auth-token"].includes(mode)) {
    throw new Error("TWILIO_AUTH_MODE must be auto, api-key, or auth-token.");
  }
  return mode;
}

function twilioAuthentication(environment = process.env) {
  const sid = accountSid(environment);
  const mode = authenticationMode(environment);
  const apiKeySid = value(environment, "TWILIO_API_KEY_SID");
  const apiKeySecret = value(environment, "TWILIO_API_KEY_SECRET");
  const authToken = value(environment, "TWILIO_AUTH_TOKEN");

  if (mode === "api-key" || (mode === "auto" && (apiKeySid || apiKeySecret))) {
    if (!apiKeySid || !apiKeySecret) {
      throw new Error("Set both TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET, or neither. Select auth-token to use only TWILIO_AUTH_TOKEN.");
    }
    if (!/^SK[0-9a-f]{32}$/i.test(apiKeySid)) {
      throw new Error("TWILIO_API_KEY_SID must be an SK SID (SK followed by 32 hexadecimal characters), not an AC or MG SID.");
    }
    return { type: "api-key", username: apiKeySid, password: apiKeySecret };
  }
  if (authToken) return { type: "auth-token", username: sid, password: authToken };
  throw new Error("Missing Twilio authentication: set TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET, or TWILIO_AUTH_TOKEN for auth-token mode.");
}

function twilioSenderConfiguration(environment = process.env) {
  const messagingServiceSid = value(environment, "TWILIO_MESSAGING_SERVICE_SID");
  const fromNumber = value(environment, "TWILIO_FROM_NUMBER");
  if (messagingServiceSid) {
    if (!/^MG[0-9a-f]{32}$/i.test(messagingServiceSid)) {
      throw new Error("TWILIO_MESSAGING_SERVICE_SID must be a Twilio Messaging Service SID beginning with MG.");
    }
    return { type: "messaging-service", messagingServiceSid };
  }
  if (fromNumber) return { type: "from-number", fromNumber };
  throw new Error("Missing Twilio sender configuration: set TWILIO_MESSAGING_SERVICE_SID (recommended) or TWILIO_FROM_NUMBER.");
}

function twilioMessageParameters({ to, body }, sender = twilioSenderConfiguration()) {
  const parameters = { To: to, Body: body };
  if (sender.type === "messaging-service") {
    parameters.MessagingServiceSid = sender.messagingServiceSid;
  } else {
    parameters.From = sender.fromNumber;
  }
  return parameters;
}

class TwilioRequestError extends Error {
  constructor(message, certainty) {
    super(message);
    this.name = "TwilioRequestError";
    this.certainty = certainty;
  }
}

function createTwilioClient(environment = process.env, { fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const sid = accountSid(environment);
  const mode = authenticationMode(environment);
  const authentications = [twilioAuthentication(environment)];
  if (mode === "auto" && authentications[0].type === "api-key" && value(environment, "TWILIO_AUTH_TOKEN")) {
    authentications.push(twilioAuthentication({ ...environment, TWILIO_AUTH_MODE: "auth-token" }));
  }
  const region = value(environment, "TWILIO_REGION").toLowerCase() || "us1";
  if (!["us1", "ie1"].includes(region)) {
    throw new Error("TWILIO_REGION must be us1 or ie1 for SMS reminders.");
  }
  const host = region === "ie1" ? "api.dublin.ie1.twilio.com" : "api.twilio.com";
  const url = `https://${host}/2010-04-01/Accounts/${sid}/Messages.json`;
  let authenticationIndex = 0;

  async function request(method, body) {
    const attempted = [];
    while (authenticationIndex < authentications.length) {
      const authentication = authentications[authenticationIndex];
      attempted.push(authentication.type);
      const authorization = Buffer.from(`${authentication.username}:${authentication.password}`).toString("base64");
      let response;
      let rawBody;
      try {
        response = await fetchImpl(method === "GET" ? `${url}?PageSize=1` : url, {
          method,
          headers: {
            Authorization: `Basic ${authorization}`,
            ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          },
          ...(body ? { body } : {}),
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        });
        rawBody = await response.text();
      } catch {
        // A POST may already have been accepted. Never retry a network failure.
        throw new TwilioRequestError(
          method === "POST"
            ? "Twilio request outcome is unknown because the network request did not complete; no retry was attempted."
            : "Twilio credential check did not complete; no SMS was sent.",
          "uncertain",
        );
      }
      let payload;
      try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch { payload = {}; }

      if (!response.ok) {
        // Fall back only when Twilio explicitly rejected authentication. There
        // is no Message to duplicate after this particular 401 / 20003 result.
        if (response.status === 401 && Number(payload?.code) === 20003 && authenticationIndex + 1 < authentications.length) {
          log("Twilio rejected api-key authentication (HTTP 401 / code 20003); trying the configured Auth Token once.");
          authenticationIndex += 1;
          continue;
        }
        // Never include Twilio's raw message: it may echo numbers or secrets.
        const code = /^\d{1,6}$/.test(String(payload?.code)) ? ` (code ${payload.code})` : "";
        let message = `Twilio ${method === "GET" ? "credential check" : "SMS request"} failed${code}: HTTP ${response.status}; authentication=${attempted.join(" then ")}; region=${region}.`;
        if (response.status === 401 || Number(payload?.code) === 20003) {
          message += " Check that TWILIO_ACCOUNT_SID and the selected live credentials belong to the same account/subaccount and region. TWILIO_API_KEY_SECRET must be the key's own secret, not the account Auth Token. Select auth-token to bypass the API key.";
        } else if (response.status === 403 && method === "GET") {
          message += " The credential check needs Messages read permission; a send-only restricted key may still send SMS.";
        }
        throw new TwilioRequestError(message, response.status >= 400 && response.status < 500 ? "failed" : "uncertain");
      }
      return payload;
    }
  }

  return {
    async checkCredentials() {
      // Use Messages, not Accounts: Standard API keys cannot read Accounts.
      const payload = await request("GET");
      if (!Array.isArray(payload?.messages)) {
        throw new TwilioRequestError("Twilio credential check returned an unexpected response; no SMS was sent.", "uncertain");
      }
      const authentication = authentications[authenticationIndex].type;
      log(`Twilio credential check passed: authentication=${authentication}; region=${region}. Messages read access confirmed; no SMS sent. This does not verify sender setup or delivery.`);
      return { authentication, region };
    },
    async sendSms(message) {
      const sender = twilioSenderConfiguration(environment);
      const payload = await request("POST", new URLSearchParams(twilioMessageParameters(message, sender)));
      if (!payload?.sid) {
        throw new TwilioRequestError("Twilio accepted the request but did not return a Message SID; outcome is unknown", "uncertain");
      }
      return payload;
    },
  };
}

if (require.main === module) {
  Promise.resolve().then(() => createTwilioClient().checkCredentials()).catch((failure) => {
    console.error(failure.message);
    process.exitCode = 1;
  });
}

module.exports = {
  TwilioRequestError,
  createTwilioClient,
  twilioAuthentication,
  twilioMessageParameters,
  twilioSenderConfiguration,
};
