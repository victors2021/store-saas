"use strict"
// Additive migration. Never changes the M0–M3 migration checksums.
const fs = require("node:fs"),
  crypto = require("node:crypto")
const {
  installTenantTables,
  verifyTenantTables,
} = require("./tenant-tables.cjs")
const { verifyRuntimePrivileges } = require("../runtime-privileges.cjs")
const tables = [
  "saas_payment_credential",
  "saas_payment_binding",
  "saas_payment_operation",
  "saas_payment_effect",
  "saas_payment_webhook",
]
const providerId = "pp_stripe_saas"
async function install(client, { role }) {
  await client.query(`CREATE TABLE saas_payment_credential (
    id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id',true),''),
    account_id text NOT NULL, publishable_key text NOT NULL, ciphertext text NOT NULL,
    mode text NOT NULL CHECK(mode='test'), active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
  );
  CREATE UNIQUE INDEX saas_payment_active_credential ON saas_payment_credential(tenant_id) WHERE active;
  CREATE TABLE saas_payment_binding (
    id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id',true),''),
    credential_id text NOT NULL, intent_id text, amount numeric NOT NULL, currency_code text NOT NULL,
    update_revision integer NOT NULL DEFAULT 0, update_amount numeric,
    state text NOT NULL DEFAULT 'creating', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,intent_id),
    FOREIGN KEY(tenant_id,credential_id) REFERENCES saas_payment_credential(tenant_id,id)
  );
  CREATE TABLE saas_payment_operation (
    id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id',true),''),
    kind text NOT NULL, resource_id text NOT NULL, idempotency_key text NOT NULL, fingerprint text NOT NULL,
    payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','failed')),
    result jsonb, attempts integer NOT NULL DEFAULT 0, error_code text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,kind,idempotency_key), UNIQUE(tenant_id,id)
  );
  CREATE TABLE saas_payment_effect (
    id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id',true),''),
    fingerprint text NOT NULL, binding_id text NOT NULL, operation_id text, remote_id text, result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,binding_id) REFERENCES saas_payment_binding(tenant_id,id),
    FOREIGN KEY(tenant_id,operation_id) REFERENCES saas_payment_operation(tenant_id,id)
  );
  CREATE TABLE saas_payment_webhook (
    id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id',true),''),
    credential_id text NOT NULL, event_id text NOT NULL, fingerprint text NOT NULL,
    state text NOT NULL DEFAULT 'pending', result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,credential_id,event_id), UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,credential_id) REFERENCES saas_payment_credential(tenant_id,id)
  );
  CREATE TABLE saas_control.payment_account (
    account_id text PRIMARY KEY, tenant_id text NOT NULL UNIQUE REFERENCES saas_control.tenant(id), UNIQUE(account_id,tenant_id)
  );
  CREATE TABLE saas_control.payment_endpoint (
    id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES saas_control.tenant(id), credential_id text NOT NULL,
    account_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,credential_id),
    CONSTRAINT payment_endpoint_credential_fk FOREIGN KEY(tenant_id,credential_id) REFERENCES saas_payment_credential(tenant_id,id),
    CONSTRAINT payment_endpoint_account_fk FOREIGN KEY(account_id,tenant_id) REFERENCES saas_control.payment_account(account_id,tenant_id)
  );`)
  const result = await installTenantTables(client, { role, tables })
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(role))
    throw new Error("Invalid runtime role")
  await client.query(`REVOKE ALL ON saas_control.payment_endpoint,saas_control.payment_account FROM PUBLIC;
    GRANT SELECT,INSERT ON saas_control.payment_endpoint,saas_control.payment_account TO "${role}"`)
  await client.query(
    "INSERT INTO payment_provider(id,is_enabled) VALUES($1,true) ON CONFLICT(id) DO NOTHING",
    [providerId]
  )
  await client.query(
    `GRANT USAGE ON SEQUENCE order_change_action_ordering_seq TO "${role}"`
  )
  return result
}
async function verify(client, { role }) {
  const result = await verifyTenantTables(client, { role, tables })
  await verifyRuntimePrivileges(client, { role, tables })
  const directory = (
    await client.query(
      `SELECT c.relname,
    has_table_privilege($1::name,c.oid,'SELECT') AND has_table_privilege($1::name,c.oid,'INSERT') AS allowed,
    has_table_privilege($1::name,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS unsafe,
    pg_has_role($1::name,c.relowner,'MEMBER') AS owner,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) AS public_access
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='saas_control' AND c.relname=ANY($2::text[])`,
      [role, ["payment_endpoint", "payment_account"]]
    )
  ).rows
  if (
    directory.length !== 2 ||
    directory.some(
      (row) => !row.allowed || row.unsafe || row.owner || row.public_access
    )
  )
    throw new Error("M4 immutable payment directory grant drift")
  for (const [table, expected] of [
    [
      "payment_account",
      [
        "PRIMARY KEY (account_id)",
        "UNIQUE (tenant_id)",
        "UNIQUE (account_id, tenant_id)",
      ],
    ],
    [
      "payment_endpoint",
      ["PRIMARY KEY (id)", "UNIQUE (tenant_id, credential_id)"],
    ],
  ]) {
    const keys = (
      await client.query(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid=$1::regclass AND contype IN ('p','u')`,
        [`saas_control.${table}`]
      )
    ).rows
    if (
      expected.some(
        (definition) => !keys.some((row) => row.definition === definition)
      )
    )
      throw new Error("M4 immutable payment directory key drift")
  }
  const endpointFKs = (
    await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='saas_control.payment_endpoint'::regclass AND contype='f' AND convalidated`)
  ).rows
  for (const definition of [
    "FOREIGN KEY (tenant_id, credential_id) REFERENCES saas_payment_credential(tenant_id, id)",
    "FOREIGN KEY (account_id, tenant_id) REFERENCES saas_control.payment_account(account_id, tenant_id)",
  ])
    if (!endpointFKs.some((row) => row.definition === definition))
      throw new Error("M4 payment endpoint ownership FK drift")
  const activeIndex = (
    await client.query(`SELECT i.indisunique AND i.indisvalid AS valid,pg_get_indexdef(c.oid) AS definition
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.oid=to_regclass('saas_payment_active_credential')`)
  ).rows[0]
  if (
    !activeIndex?.valid ||
    activeIndex.definition !==
      "CREATE UNIQUE INDEX saas_payment_active_credential ON public.saas_payment_credential USING btree (tenant_id) WHERE active"
  )
    throw new Error("M4 active credential uniqueness drift")
  const catalog = (
    await client.query("SELECT is_enabled FROM payment_provider WHERE id=$1", [
      providerId,
    ])
  ).rows[0]
  if (!catalog?.is_enabled)
    throw new Error("M4 reviewed Stripe provider directory is missing")
  const sequence = (
    await client.query(
      `SELECT has_sequence_privilege($1::name,'order_change_action_ordering_seq','USAGE') AS allowed,
    has_sequence_privilege($1::name,'order_change_action_ordering_seq','UPDATE') AS unsafe`,
      [role]
    )
  ).rows[0]
  if (!sequence?.allowed || sequence.unsafe)
    throw new Error("M4 native order change sequence privilege drift")
  for (const name of ["saas_payment_binding", "saas_payment_webhook"]) {
    const fk = (
      await client.query(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid=$1::regclass AND contype='f'`,
        [name]
      )
    ).rows
    if (
      !fk.some((row) =>
        row.definition.startsWith(
          "FOREIGN KEY (tenant_id, credential_id) REFERENCES saas_payment_credential(tenant_id, id)"
        )
      )
    )
      throw new Error(`M4 credential ownership FK drift: ${name}`)
  }
  const columns = {
    saas_payment_credential: {
      id: "text",
      account_id: "text",
      publishable_key: "text",
      ciphertext: "text",
      mode: "text",
      active: "boolean",
    },
    saas_payment_binding: {
      id: "text",
      credential_id: "text",
      amount: "numeric",
      currency_code: "text",
      state: "text",
      update_revision: "integer",
    },
    saas_payment_operation: {
      id: "text",
      kind: "text",
      resource_id: "text",
      idempotency_key: "text",
      fingerprint: "text",
      payload: "jsonb",
      state: "text",
      attempts: "integer",
    },
    saas_payment_effect: {
      id: "text",
      binding_id: "text",
      fingerprint: "text",
    },
    saas_payment_webhook: {
      id: "text",
      credential_id: "text",
      event_id: "text",
      fingerprint: "text",
      state: "text",
    },
  }
  for (const [name, expected] of Object.entries(columns)) {
    const rows = (
      await client.query(
        "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
        [name]
      )
    ).rows
    for (const [column, type] of Object.entries(expected))
      if (
        !rows.some(
          (row) =>
            row.column_name === column &&
            row.data_type === type &&
            row.is_nullable === "NO"
        )
      )
        throw new Error(`M4 required column drift: ${name}.${column}`)
  }
  return result
}
module.exports = {
  id: "0006-payments",
  checksum: crypto
    .createHash("sha256")
    .update(fs.readFileSync(__filename))
    .digest("hex"),
  tables,
  providerId,
  install,
  verify,
}
