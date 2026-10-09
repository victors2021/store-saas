"use strict"
const fs = require("node:fs"),
  crypto = require("node:crypto")
const {
  installTenantTables,
  verifyTenantTables,
} = require("./tenant-tables.cjs")
const { verifyRuntimePrivileges } = require("../runtime-privileges.cjs")
const tables = ["saas_job", "saas_cache", "saas_lock", "saas_file"]
async function install(client, { role }) {
  await client.query(`CREATE TABLE IF NOT EXISTS saas_job (
    id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id',true),''),
    kind text NOT NULL, idempotency_key text NOT NULL, fingerprint text NOT NULL, payload jsonb NOT NULL,
    result jsonb, state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
    last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,kind,idempotency_key),UNIQUE(tenant_id,id)
  );
  CREATE TABLE IF NOT EXISTS saas_cache (
    id text PRIMARY KEY,tenant_id text NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id',true),''),
    value jsonb NOT NULL,expires_at timestamptz NOT NULL,UNIQUE(tenant_id,id)
  );
  CREATE TABLE IF NOT EXISTS saas_lock (
    id text PRIMARY KEY,tenant_id text NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id',true),''),
    owner_id text NOT NULL,expires_at timestamptz NOT NULL,UNIQUE(tenant_id,id)
  );
  CREATE TABLE IF NOT EXISTS saas_file (
    id text PRIMARY KEY,tenant_id text NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id',true),''),
    storage_key text NOT NULL,filename text NOT NULL,mime_type text NOT NULL,
    is_public boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
  );
  CREATE TABLE IF NOT EXISTS saas_control.task_dispatch (
    id text PRIMARY KEY,tenant_id text NOT NULL REFERENCES saas_control.tenant(id), envelope text NOT NULL,
    state text NOT NULL DEFAULT 'pending',group_id text,available_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz,lease_token text,attempts integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS saas_dispatch_ready ON saas_control.task_dispatch(state,available_at,lease_until);
  CREATE TABLE IF NOT EXISTS saas_control.http_session (
    id text PRIMARY KEY,ciphertext text NOT NULL,expires_at timestamptz NOT NULL
  );`)
  const result = await installTenantTables(client, { role, tables })
  // Composite PKs allow identical cache/lock keys in different tenants.
  for (const name of ["saas_cache", "saas_lock"]) {
    await client.query(
      `ALTER TABLE ${name} DROP CONSTRAINT IF EXISTS ${name}_pkey`
    )
    await client.query(`ALTER TABLE ${name} ADD PRIMARY KEY(tenant_id,id)`)
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(role))
    throw new Error("Invalid runtime role")
  await client.query(`REVOKE ALL ON saas_control.task_dispatch,saas_control.http_session FROM PUBLIC;
    GRANT SELECT,INSERT,UPDATE,DELETE ON saas_control.task_dispatch,saas_control.http_session TO "${role}"`)
  return result
}
async function verify(client, { role }) {
  const result = await verifyTenantTables(client, { role, tables })
  await verifyRuntimePrivileges(client, { role, tables })
  await verifyRuntimePrivileges(client, {
    role,
    tables: ["task_dispatch", "http_session"],
    schema: "saas_control",
  })
  for (const name of ["saas_cache", "saas_lock"]) {
    const primary = (
      await client.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND contype='p'",
        [name]
      )
    ).rows[0]
    if (primary?.definition !== "PRIMARY KEY (tenant_id, id)")
      throw new Error(`Runtime tenant primary key drift: ${name}`)
  }
  const required = {
    task_dispatch: {
      id: "text",
      tenant_id: "text",
      envelope: "text",
      state: "text",
      attempts: "integer",
      available_at: "timestamp with time zone",
      created_at: "timestamp with time zone",
    },
    http_session: {
      id: "text",
      ciphertext: "text",
      expires_at: "timestamp with time zone",
    },
  }
  for (const [name, columns] of Object.entries(required)) {
    const relation = (
      await client.query(
        "SELECT oid,relowner FROM pg_class WHERE oid=to_regclass($1)",
        [`saas_control.${name}`]
      )
    ).rows[0]
    if (
      !relation ||
      (
        await client.query(
          "SELECT pg_has_role($1::name,$2::oid,'MEMBER') AS member",
          [role, relation.relowner]
        )
      ).rows[0].member
    )
      throw new Error(`Unsafe runtime control table owner: ${name}`)
    const actual = (
      await client.query(
        "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='saas_control' AND table_name=$1",
        [name]
      )
    ).rows
    for (const [column, type] of Object.entries(columns))
      if (
        !actual.some(
          (row) =>
            row.column_name === column &&
            row.data_type === type &&
            row.is_nullable === "NO"
        )
      )
        throw new Error(`Runtime control table column drift: ${name}.${column}`)
    const primary = (
      await client.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::oid AND contype='p'",
        [relation.oid]
      )
    ).rows[0]
    if (primary?.definition !== "PRIMARY KEY (id)")
      throw new Error(`Runtime control table primary key drift: ${name}`)
  }
  const foreign = (
    await client.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='saas_control.task_dispatch'::regclass AND contype='f'"
    )
  ).rows
  if (
    !foreign.some(
      (row) =>
        row.definition ===
        "FOREIGN KEY (tenant_id) REFERENCES saas_control.tenant(id)"
    )
  )
    throw new Error("Runtime task tenant foreign key drift")
  const ready = (
    await client.query(
      "SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid=to_regclass('saas_control.saas_dispatch_ready') AND indisvalid"
    )
  ).rows[0]
  if (!ready?.definition.includes("(state, available_at, lease_until)"))
    throw new Error("Runtime task ready index drift")
  return { ...result, verifiedControlTables: 2 }
}
const checksum = crypto
  .createHash("sha256")
  .update(fs.readFileSync(__filename))
  .update(fs.readFileSync(require.resolve("./tenant-tables.cjs")))
  .update(fs.readFileSync(require.resolve("../runtime-privileges.cjs")))
  .digest("hex")
module.exports = { id: "0005-runtime", checksum, install, verify, tables }
