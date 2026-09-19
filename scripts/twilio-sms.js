"use strict";

function value(environment, name) {
  return String(environment[name] || "").trim();
}

function safeErrorText(text, privateValues) {
  let result = String(text || "");
  for (const privateValue of privateValues.filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(privateValue).join("[redacted]");
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

function createTwilioClient(environment = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const accountSid = value(environment, "TWILIO_ACCOUNT_SID");
  const authToken = value(environment, "TWILIO_AUTH_TOKEN");
  const messagingServiceSid = value(environment, "TWILIO_MESSAGING_SERVICE_SID");
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) {
    throw new Error("TWILIO_ACCOUNT_SID must be the account's AC SID (AC followed by 32 hexadecimal characters).");
  }
  if (!authToken) {
    throw new Error("TWILIO_AUTH_TOKEN is required.");
  }
  if (!/^MG[0-9a-f]{32}$/i.test(messagingServiceSid)) {
    throw new Error("TWILIO_MESSAGING_SERVICE_SID must be a Twilio Messaging Service SID beginning with MG.");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const authorization = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  return {
    async sendSms({ to, body }) {
      let response;
      let rawBody;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Basic ${authorization}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: to, Body: body, MessagingServiceSid: messagingServiceSid }),
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        });
        rawBody = await response.text();
      } catch {
        // Twilio may already have accepted the message. Never retry automatically.
        throw new TwilioRequestError(
          "Twilio request outcome is unknown because the network request did not complete; no retry was attempted.",
          "uncertain",
        );
      }

      let payload;
      try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch { payload = {}; }
      if (!response.ok) {
        const code = /^\d{1,6}$/.test(String(payload?.code)) ? ` (code ${payload.code})` : "";
        let message = `Twilio SMS request failed${code}: HTTP ${response.status}.`;
        if (typeof payload?.message === "string") {
          const detail = safeErrorText(payload.message, [accountSid, authToken, messagingServiceSid, authorization, to, body]);
          if (detail) message += ` ${detail}`;
        }
        throw new TwilioRequestError(message, response.status >= 400 && response.status < 500 ? "failed" : "uncertain");
      }
      if (typeof payload?.sid !== "string" || !payload.sid) {
        throw new TwilioRequestError("Twilio accepted the request but did not return a Message SID; outcome is unknown", "uncertain");
      }
      return payload;
    },
  };
}

module.exports = { TwilioRequestError, createTwilioClient };
