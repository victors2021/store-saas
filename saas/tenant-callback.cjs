"use strict"
const crypto = require("node:crypto"),
  jwt = require("jsonwebtoken")
const {
  createTenantVerifier,
  runWithTenant,
  TenantSecurityError,
} = require("./tenant-context.cjs")
const { rejectAuthority } = require("./tenant-jobs.cjs")
const fail = (code, message) => {
  throw new TenantSecurityError(code, message)
}
const signatureInput = (credentialKey, timestamp, rawBody) =>
  Buffer.concat([
    Buffer.from(
      JSON.stringify([
        "medusa-saas-callback-v1",
        credentialKey,
        String(timestamp),
      ]) + "\n"
    ),
    rawBody,
  ])
function callbackSignature(secret, credentialKey, timestamp, rawBody) {
  return crypto
    .createHmac("sha256", secret)
    .update(signatureInput(credentialKey, timestamp, rawBody))
    .digest("hex")
}

// A reference HMAC ingress contract for explicitly configured providers.
// Native/vendor callback routes remain closed. Each vendor needs its own
// signature adapter and business handling before HTTP exposure in M4.
function createTenantCallbackIngress({
  lookupCredential,
  lookupAuthority,
  contextSecret,
  jobs,
}) {
  if (
    typeof lookupCredential !== "function" ||
    typeof lookupAuthority !== "function" ||
    !jobs
  )
    throw new TypeError(
      "Trusted credential registry, authority lookup and tenant jobs required"
    )
  const verify = createTenantVerifier({
    secret: contextSecret,
    issuer: "medusa-saas-callback-context",
    audience: "callback-context",
    lookupMembership: lookupAuthority,
  })
  return async function accept({
    credentialKey,
    timestamp,
    signature,
    rawBody,
  }) {
    if (
      typeof credentialKey !== "string" ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(credentialKey) ||
      !Number.isSafeInteger(timestamp) ||
      Math.abs(Date.now() / 1000 - timestamp) > 300 ||
      !Buffer.isBuffer(rawBody) ||
      rawBody.length > 1024 * 1024 ||
      typeof signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      fail(
        "TENANT_CALLBACK_SIGNATURE_INVALID",
        "Invalid callback authentication"
      )
    const binding = await lookupCredential(credentialKey)
    if (
      !binding ||
      binding.status !== "active" ||
      typeof binding.secret !== "string" ||
      Buffer.byteLength(binding.secret) < 32 ||
      typeof binding.tenantId !== "string" ||
      typeof binding.actorId !== "string" ||
      typeof binding.accountId !== "string"
    )
      fail(
        "TENANT_CALLBACK_CREDENTIAL_UNKNOWN",
        "Callback credential is unavailable"
      )
    const expected = callbackSignature(
      binding.secret,
      credentialKey,
      timestamp,
      rawBody
    )
    if (
      !crypto.timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(expected, "hex")
      )
    )
      fail(
        "TENANT_CALLBACK_SIGNATURE_INVALID",
        "Invalid callback authentication"
      )
    let event
    try {
      event = JSON.parse(rawBody.toString("utf8"))
    } catch {
      fail("TENANT_CALLBACK_PAYLOAD_INVALID", "Invalid callback payload")
    }
    rejectAuthority(event)
    if (
      !event ||
      Array.isArray(event) ||
      typeof event.event_id !== "string" ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(event.event_id) ||
      event.account_id !== binding.accountId
    )
      fail(
        "TENANT_CALLBACK_ACCOUNT_INVALID",
        "Callback account does not match its verified credential"
      )
    const context = await verify(
      jwt.sign({ tenant_id: binding.tenantId }, contextSecret, {
        algorithm: "HS256",
        subject: binding.actorId,
        issuer: "medusa-saas-callback-context",
        audience: "callback-context",
        expiresIn: "5m",
      })
    )
    return runWithTenant(context, () =>
      jobs.enqueue(
        "callback.payment",
        { credentialKey, event },
        { idempotencyKey: credentialKey + ":" + event.event_id }
      )
    )
  }
}
module.exports = { createTenantCallbackIngress, callbackSignature }
