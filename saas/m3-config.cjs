"use strict"
function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
function port(name, fallback) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${name}`)
  return value
}
function runtimeConfig() {
  return {
    databaseUrl: required("SAAS_DATABASE_URL"), baseDomain: required("SAAS_BASE_DOMAIN"),
    platformActorId: required("SAAS_PLATFORM_ACTOR_ID"), jwtSecret: required("SAAS_JWT_SECRET"),
    contextSecret: required("SAAS_CONTEXT_SECRET"), namespaceSecret: required("SAAS_IDENTITY_SECRET"),
    platformKey: required("SAAS_PLATFORM_KEY"), objectRoot: required("SAAS_OBJECT_ROOT"),
    commerce: true, browser: true, secureCookies: true,
    trustedProxy: process.env.SAAS_TRUSTED_PROXY ? process.env.SAAS_TRUSTED_PROXY.split(",").map((value) => value.trim()) : false,
  }
}
module.exports = { runtimeConfig, port }
