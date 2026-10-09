"use strict"
// Additive platform authentication only; historical tenant migrations stay immutable.
const fs = require("node:fs"), crypto = require("node:crypto")
const tables = ["platform_credential", "platform_login_session"]
async function fingerprint(client) {
  const names = tables.map(name => `saas_control.${name}`)
  const columns = (await client.query(`SELECT c.relname,a.attname,a.attnotnull,
    format_type(a.atttypid,a.atttypmod) AS type,pg_get_expr(d.adbin,d.adrelid) AS default_sql
    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE c.oid=ANY(SELECT unnest($1::text[])::regclass) AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum`, [names])).rows
  const constraints = (await client.query(`SELECT c.conname,c.convalidated,pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c WHERE c.conrelid=ANY(SELECT unnest($1::text[])::regclass) ORDER BY c.conname`, [names])).rows
  const indexes = (await client.query(`SELECT indexname,indexdef FROM pg_indexes
    WHERE schemaname='saas_control' AND tablename=ANY($1::text[]) ORDER BY indexname`, [tables])).rows
  return crypto.createHash("sha256").update(JSON.stringify({columns,constraints,indexes})).digest("hex")
}
async function install(client, {role}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error("Valid application role required")
  await client.query(`CREATE TABLE saas_control.platform_credential (
    actor_id text PRIMARY KEY REFERENCES saas_control.platform_identity(actor_id),
    email text NOT NULL UNIQUE CHECK (length(email)<=254 AND email=lower(btrim(email)) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
    password_hash text NOT NULL CHECK (password_hash ~ '^scrypt\\$32768\\$8\\$1\\$[a-f0-9]{32}\\$[a-f0-9]{64}$'),
    version integer NOT NULL DEFAULT 1 CHECK (version>0),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE saas_control.platform_login_session (
    id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
    actor_id text NOT NULL REFERENCES saas_control.platform_identity(actor_id),
    credential_version integer NOT NULL CHECK (credential_version>0),
    csrf_secret text NOT NULL CHECK (csrf_secret ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX platform_login_session_expiry ON saas_control.platform_login_session(expires_at);
  CREATE INDEX platform_login_session_actor ON saas_control.platform_login_session(actor_id);
  REVOKE ALL ON saas_control.platform_credential,saas_control.platform_login_session FROM PUBLIC;
  REVOKE ALL ON saas_control.platform_credential,saas_control.platform_login_session FROM "${role}";
  GRANT SELECT ON saas_control.platform_credential TO "${role}";
  GRANT SELECT,INSERT,DELETE ON saas_control.platform_login_session TO "${role}";`)
  return {controlTables:2,schemaFingerprint:await fingerprint(client)}
}
async function verify(client, {role,expectedFingerprint}) {
  if (!expectedFingerprint || await fingerprint(client)!==expectedFingerprint)
    throw new Error("Platform login schema drift")
  for (const name of tables) {
    const relation=`saas_control.${name}`
    const row=(await client.query(`SELECT pg_has_role($1::name,c.relowner,'MEMBER') AS owner,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) AS public_access
      FROM pg_class c WHERE c.oid=to_regclass($2)`,[role,relation])).rows[0]
    if (!row || row.owner || row.public_access) throw new Error("Platform login table authority drift")
    const allowed=name==="platform_credential"?["SELECT"]:["SELECT","INSERT","DELETE"]
    for (const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"])
      if ((await client.query("SELECT has_table_privilege($1::name,$2,$3) ok",[role,relation,privilege])).rows[0].ok!==allowed.includes(privilege))
        throw new Error(`Platform login privilege drift: ${name}.${privilege}`)
  }
}
module.exports={id:"0008-platform-login",checksum:crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),install,verify}
