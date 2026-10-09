// MIT. Native Auth/User/Customer migrations run first. The SaaS ledger owns
// versioning; mode changes never silently consume a native migration version.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { installTenantTables, verifyTenantTables } = require('./tenant-tables.cjs');
const identityTables = [
  'auth_identity', 'provider_identity', 'auth_verification',
  'auth_mfa_factor', 'auth_mfa_recovery_code', 'auth_password_reset_token',
  'user', 'invite',
  'customer', 'customer_address', 'customer_group', 'customer_group_customer',
];

async function install(client, { role }) {
  if (process.env.MEDUSA_SAAS_MODE !== 'true') throw new Error('Identity tenant migration requires MEDUSA_SAAS_MODE=true');
  return installTenantTables(client, { role, tables: identityTables });
}

async function verify(client, { role }) {
  if (process.env.MEDUSA_SAAS_MODE !== 'true') throw new Error('Identity tenant verification requires MEDUSA_SAAS_MODE=true');
  return verifyTenantTables(client, { role, tables: identityTables });
}

const checksum = crypto.createHash('sha256').update(fs.readFileSync(__filename))
  .update(fs.readFileSync(require.resolve('./tenant-tables.cjs'))).digest('hex');
module.exports = { id: '0003-identity', checksum, install, verify, identityTables };
