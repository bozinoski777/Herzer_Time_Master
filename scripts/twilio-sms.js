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

function safeDiagnosticText(text, environment) {
  let result = String(text || "");
  for (const [name, secret] of Object.entries(environment)) {
    if (/TWILIO/.test(name) && String(secret || "").trim()) {
      result = result.split(String(secret).trim()).join("[redacted]");
    }
  }
  return result
    .replace(/https?:\/\/[^\s<>"']+/gi, "[URL]")
    .replace(/\b[A-Z]{2}[0-9a-f]{32}\b/gi, "[SID]")
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, "[redacted]")
    .replace(/(?:\+|\b)\d[\d\s().-]{5,}\d\b/g, "[number]")
    .replace(/[\r\n\t]+/g, " ").slice(0, 800);
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

  async function request(method, body, {
    requestUrl = method === "GET" ? `${url}?PageSize=1` : url,
    operation = method === "GET" ? "credential check" : "SMS request",
    allowFallback = true,
  } = {}) {
    const attempted = [];
    while (authenticationIndex < authentications.length) {
      const authentication = authentications[authenticationIndex];
      attempted.push(authentication.type);
      const authorization = Buffer.from(`${authentication.username}:${authentication.password}`).toString("base64");
      let response;
      let rawBody;
      try {
        response = await fetchImpl(requestUrl, {
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
        if (allowFallback && response.status === 401 && Number(payload?.code) === 20003 && authenticationIndex + 1 < authentications.length) {
          log("Twilio rejected api-key authentication (HTTP 401 / code 20003); trying the configured Auth Token once.");
          authenticationIndex += 1;
          continue;
        }
        // Never include Twilio's raw message: it may echo numbers or secrets.
        const code = /^\d{1,6}$/.test(String(payload?.code)) ? ` (code ${payload.code})` : "";
        let message = `Twilio ${operation} failed${code}: HTTP ${response.status}; authentication=${attempted.join(" then ")}; region=${region}.`;
        if (operation === "Messaging Service check" && [401, 403, 404].includes(response.status)) {
          message += " Messages authentication passed, but the configured Messaging Service is inaccessible. Check TWILIO_MESSAGING_SERVICE_SID in the same account and region; a restricted key also needs Services read permission. Do not replace working credentials solely because of this result.";
        } else if (response.status === 401 || Number(payload?.code) === 20003) {
          message += " Check that TWILIO_ACCOUNT_SID and the selected live credentials belong to the same account/subaccount and region.";
          if (authentication.type === "api-key") {
            message += " TWILIO_API_KEY_SECRET must be the key's own secret, not the account Auth Token. Select auth-token to bypass the API key.";
          }
          if (method === "POST") {
            message += " If the credential check passes, sending is still being denied: run check_credentials_only to inspect account status and Messaging Service ownership, then check Twilio's Debugger for sending restrictions.";
          }
        } else if (response.status === 403 && method === "GET") {
          message += operation === "credential check"
            ? " The credential check needs Messages read permission; a send-only restricted key may still send SMS."
            : " This check requires read permission for the requested resource.";
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
    async checkConfiguration() {
      const result = await this.checkCredentials();
      // Account metadata is unavailable to Standard API keys. Only use the
      // already selected Auth Token; never widen access for a diagnostic read.
      if (result.authentication === "auth-token") {
        const account = await request("GET", undefined, {
          requestUrl: `https://${host}/2010-04-01/Accounts/${sid}.json`,
          operation: "account status check",
          allowFallback: false,
        });
        if (account?.sid !== sid || !["active", "suspended", "closed"].includes(account?.status)) {
          throw new TwilioRequestError("Twilio account status check returned an unexpected response; no SMS sent.", "uncertain");
        }
        if (account.status !== "active") {
          throw new TwilioRequestError(`Twilio account status is ${account.status}. Resolve the account restriction with Twilio before sending; no SMS sent.`, "failed");
        }
        log("Twilio account status: active. This does not rule out product-specific sending restrictions.");
      } else {
        log("Account status check skipped for API-key authentication; Standard keys cannot read Accounts.");
      }

      if (value(environment, "TWILIO_MESSAGING_SERVICE_SID")) {
        const sender = twilioSenderConfiguration(environment);
        const messagingHost = region === "ie1" ? "messaging.dublin.ie1.twilio.com" : "messaging.twilio.com";
        const service = await request("GET", undefined, {
          requestUrl: `https://${messagingHost}/v1/Services/${sender.messagingServiceSid}`,
          operation: "Messaging Service check",
          allowFallback: false,
        });
        if (service?.sid !== sender.messagingServiceSid || !/^AC[0-9a-f]{32}$/i.test(service?.account_sid || "")) {
          throw new TwilioRequestError("Twilio Messaging Service check returned an unexpected response; no SMS sent.", "uncertain");
        }
        if (service.account_sid !== sid) {
          throw new TwilioRequestError("TWILIO_MESSAGING_SERVICE_SID belongs to a different account than TWILIO_ACCOUNT_SID. Use a Messaging Service owned by the configured account; no SMS sent.", "failed");
        }
        log("Messaging Service is accessible and belongs to the configured account.");
      } else {
        log("Messaging Service ownership check skipped: no TWILIO_MESSAGING_SERVICE_SID configured.");
      }
      log("Twilio configuration checks passed; no SMS sent. Sender-pool readiness, send permission, and delivery remain unverified.");
      return result;
    },
    async checkRecentSendErrors() {
      if (region !== "us1") {
        log("Recent error lookup skipped outside US1; inspect the regional Twilio Debugger.");
        return;
      }
      const parameters = new URLSearchParams({
        StartDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        LogLevel: "error",
        PageSize: "100",
      });
      const payload = await request("GET", undefined, {
        requestUrl: `https://monitor.twilio.com/v1/Alerts?${parameters}`,
        operation: "recent error lookup",
        allowFallback: false,
      });
      if (!Array.isArray(payload?.alerts)) {
        throw new TwilioRequestError("Twilio recent error lookup returned an unexpected response; no SMS sent.", "uncertain");
      }
      const failures = payload.alerts.filter((alert) => {
        if (alert.account_sid !== sid || alert.request_method !== "POST" || Number(alert.error_code) !== 20003) return false;
        try {
          return new URL(alert.request_url).pathname.replace(/\/$/, "").replace(/\.json$/, "") === `/2010-04-01/Accounts/${sid}/Messages`;
        } catch { return false; }
      }).slice(0, 5);
      if (failures.length === 0) {
        log("Twilio recent send errors: no matching 20003 Message POST errors found in the latest 100 error records from the last 24 hours.");
      }
      for (const failure of failures) {
        log(`Twilio recorded send error 20003 (historical): ${safeDiagnosticText(failure.alert_text, environment) || "No description recorded; inspect Twilio's Debugger."}`);
      }
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
  Promise.resolve().then(async () => {
    const client = createTwilioClient();
    await client.checkConfiguration();
    try {
      await client.checkRecentSendErrors();
    } catch (failure) {
      console.log(`Optional error-history lookup unavailable: ${failure.message}`);
    }
  }).catch((failure) => {
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
