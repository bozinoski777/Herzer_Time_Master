"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
function encryptReport(report, publicKey) {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(report), "utf8"), cipher.final()]);
  return { version: 1, algorithm: "RSA-OAEP-SHA256/AES-256-GCM", wrappedKey: crypto.publicEncrypt({ key: publicKey, oaepHash: "sha256" }, key).toString("base64"),
    iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}
function decryptReport(envelope, privateKey) {
  if (envelope.version !== 1 || envelope.algorithm !== "RSA-OAEP-SHA256/AES-256-GCM") throw new Error("Unsupported audit encryption format");
  const key = crypto.privateDecrypt({ key: privateKey, oaepHash: "sha256" }, Buffer.from(envelope.wrappedKey, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
}
if (require.main === module) {
  const [mode, input, key, output] = process.argv.slice(2);
  if (mode !== "--decrypt" || !input || !key || !output) throw new Error("Usage: node scripts/audit-crypto.js --decrypt encrypted.json private-key.pem output.json");
  fs.writeFileSync(output, JSON.stringify(decryptReport(JSON.parse(fs.readFileSync(input)), fs.readFileSync(key)), null, 2), { mode: 0o600 });
  console.log("Decrypted audit saved locally.");
}
module.exports = { encryptReport, decryptReport };
