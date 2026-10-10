"use strict"

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto")
const { execFileSync } = require("node:child_process")
const { createDevelopmentHosts } = require("./development-hosts.cjs")

function ensureLocalhostTLS(directory, baseDomain) {
  createDevelopmentHosts({baseDomain, enabled:true})
  const root = fs.lstatSync(directory)
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0 || root.uid !== process.getuid())
    throw new Error("An owned private preview directory is required")
  const keyFile = path.join(directory, "tls-localhost-key.pem"), certFile = path.join(directory, "tls-localhost-cert.pem")
  if (!fs.existsSync(keyFile) && !fs.existsSync(certFile)) {
    const temporary = fs.mkdtempSync(path.join(directory, "localhost-tls-")), mask = process.umask(0o077)
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", path.join(temporary, "key.pem"), "-out", path.join(temporary, "cert.pem"), "-days", "30",
        "-subj", "/CN=localhost", "-addext",
        `subjectAltName=DNS:localhost,DNS:shops.localhost,DNS:*.shops.localhost,DNS:${baseDomain},DNS:*.${baseDomain}`], {stdio:"ignore"})
      fs.writeFileSync(keyFile, fs.readFileSync(path.join(temporary, "key.pem")), {mode:0o600, flag:"wx"})
      fs.writeFileSync(certFile, fs.readFileSync(path.join(temporary, "cert.pem")), {mode:0o600, flag:"wx"})
    } finally { process.umask(mask); fs.rmSync(temporary, {recursive:true, force:true}) }
  }
  for (const file of [keyFile, certFile]) {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())
      throw new Error("Private regular localhost TLS files are required")
  }
  const key = fs.readFileSync(keyFile), cert = fs.readFileSync(certFile), certificate = new crypto.X509Certificate(cert)
  if (!["localhost", "shops.localhost", "preview-store.shops.localhost", baseDomain, `preview-store.${baseDomain}`].every(host => certificate.checkHost(host)) ||
      Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now() ||
      !certificate.checkPrivateKey(crypto.createPrivateKey(key)))
    throw new Error("A matching, current localhost development certificate is required; existing files were preserved")
  return {key, cert}
}

module.exports = { ensureLocalhostTLS }
