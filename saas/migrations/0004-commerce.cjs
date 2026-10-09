"use strict"
const fs = require("node:fs")
const crypto = require("node:crypto")
const schema = require("../m2-schema.json")
const {
  installTenantTables,
  verifyTenantTables,
} = require("./tenant-tables.cjs")
const { catalogTables } = require("./0002-catalog.cjs")
const { identityTables } = require("./0003-identity.cjs")
const { verifyRuntimePrivileges } = require("../runtime-privileges.cjs")
const ident = (s) => '"' + s.replaceAll('"', '""') + '"'

// Explicit logical cross-module references that native Medusa leaves as text.
const logical = [
  ["cart", "region_id", "region"],
  ["cart", "customer_id", "customer"],
  ["cart", "sales_channel_id", "sales_channel"],
  ["cart_line_item", "variant_id", "product_variant"],
  ["cart_line_item", "product_id", "product"],
  ["cart_shipping_method", "shipping_option_id", "shipping_option"],
  ["order", "region_id", "region"],
  ["order", "customer_id", "customer"],
  ["order", "sales_channel_id", "sales_channel"],
  ["order_line_item", "variant_id", "product_variant"],
  ["order_line_item", "product_id", "product"],
  ["order_shipping_method", "shipping_option_id", "shipping_option"],
  ["inventory_level", "location_id", "stock_location"],
  ["reservation_item", "location_id", "stock_location"],
  ["reservation_item", "line_item_id", "order_line_item"],
  ["shipping_option", "shipping_profile_id", "shipping_profile"],
]
const sharedReferences = [
  ["payment_session", "provider_id", "payment_provider"],
  ["payment", "provider_id", "payment_provider"],
  ["account_holder", "provider_id", "payment_provider"],
  ["tax_region", "provider_id", "tax_provider"],
  ["shipping_option", "provider_id", "fulfillment_provider"],
  ["fulfillment", "provider_id", "fulfillment_provider"],
  [
    "location_fulfillment_provider",
    "fulfillment_provider_id",
    "fulfillment_provider",
  ],
  ["region_payment_provider", "payment_provider_id", "payment_provider"],
]
const sharedKey = (source, column, target) =>
  "saas_fk_shared_" +
  crypto
    .createHash("sha256")
    .update([source, column, target].join(":"))
    .digest("hex")
    .slice(0, 20)

async function options(client, role) {
  const links = (
    await client.query("SELECT table_name FROM public.link_module_migrations")
  ).rows.map((r) => r.table_name)
  const knownLinks = schema.links.map((l) => l.table)
  const requiredLinks = knownLinks.filter(
    (name) =>
      ![
        "order_claim_payment_collection",
        "order_exchange_payment_collection",
      ].includes(name)
  )
  if (
    requiredLinks.some((name) => !links.includes(name)) ||
    links.some((name) => !knownLinks.includes(name))
  )
    throw new Error("Native Link ledger differs from the reviewed M2 manifest")
  const all = [
    ...new Set([
      ...catalogTables,
      ...identityTables,
      ...schema.tables,
      ...links,
    ]),
  ]
  const extra = logical.map(([source, column, target]) => ({
    source,
    target,
    source_columns: [column],
    target_columns: ["id"],
  }))
  // Physical Link definitions have no native FK. Both ends must be enforced.
  const mapping = schema.links.filter((l) => links.includes(l.table))
  for (const link of mapping)
    for (const rel of link.relationships) {
      if (all.includes(rel.target))
        extra.push({
          source: link.table,
          target: rel.target,
          source_columns: [rel.sourceColumn],
          target_columns: [rel.targetColumn],
        })
    }
  // Implicit many-to-many tables are reviewed from actual native migrated schema.
  const pivots = [
    "payment_collection_payment_providers",
    "promotion_promotion_rule",
    "application_method_buy_rules",
    "application_method_target_rules",
  ]
  return { role, tables: [...all, ...pivots], extraForeignKeys: extra }
}

const refundDefaults = [
  {
    label: "Shipping Issue",
    code: "shipping_issue",
    description: "Refund due to lost, delayed, or misdelivered shipment",
  },
  {
    label: "Customer Care Adjustment",
    code: "customer_care_adjustment",
    description: "Refund given as goodwill or compensation for inconvenience",
  },
  {
    label: "Pricing Error",
    code: "pricing_error",
    description:
      "Refund to correct an overcharge, missing discount, or incorrect price",
  },
]
async function install(client, { role, allowNativeReferenceSeeds = false }) {
  if (process.env.MEDUSA_SAAS_MODE !== "true")
    throw new Error("M2 requires SaaS mode")
  const column = (
    await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='refund_reason' AND column_name='tenant_id'"
    )
  ).rowCount
  let seedCount = 0
  if (!column) {
    const seeds = (
      await client.query(
        "SELECT id,label,code,description,metadata,deleted_at FROM refund_reason"
      )
    ).rows
    if (seeds.length) {
      if (!allowNativeReferenceSeeds)
        throw new Error(
          "Native reference seed conversion requires explicit allowNativeReferenceSeeds after review"
        )
      if (
        seeds.length !== 3 ||
        seeds.some(
          (row) =>
            !/^refr_[A-Z0-9]{26}$/.test(row.id) ||
            row.metadata !== null ||
            row.deleted_at !== null ||
            !refundDefaults.some(
              (r) =>
                r.label === row.label &&
                r.code === row.code &&
                r.description === row.description
            )
        ) ||
        (await client.query("SELECT 1 FROM refund LIMIT 1")).rowCount
      )
        throw new Error(
          "Existing refund reason data is not the untouched native seed; reviewed ownership migration required"
        )
      await client.query("DELETE FROM refund_reason")
      seedCount = 3
    }
  }
  // No global country reassignment: loader has been disabled in SaaS mode.
  // Existing unowned country data is rejected by the shared ownership validator.
  const opts = await options(client, role)
  const result = await installTenantTables(client, opts)
  for (const [name, keys] of [
    ["region_country", ["tenant_id", "iso_2"]],
    [
      "workflow_execution",
      ["tenant_id", "workflow_id", "transaction_id", "run_id"],
    ],
  ]) {
    const pkey = (
      await client.query(
        "SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype='p'",
        [name]
      )
    ).rows[0]
    if (pkey)
      await client.query(
        `ALTER TABLE public.${ident(name)} DROP CONSTRAINT ${ident(
          pkey.conname
        )}`
      )
    await client.query(
      `ALTER TABLE public.${ident(name)} ADD PRIMARY KEY (${keys
        .map(ident)
        .join(",")})`
    )
  }
  for (const [name, ids] of [
    ["payment_provider", ["pp_system_default"]],
    ["tax_provider", ["tp_system"]],
    ["fulfillment_provider", ["manual_manual"]],
  ]) {
    await client.query(
      `INSERT INTO public.${ident(
        name
      )} (id,is_enabled) SELECT unnest($1::text[]),true ON CONFLICT(id) DO NOTHING`,
      [ids]
    )
    await client.query(
      `REVOKE ALL ON public.${ident(name)} FROM PUBLIC,${ident(role)}`
    )
    await client.query(
      `GRANT SELECT ON public.${ident(name)} TO ${ident(role)}`
    )
  }
  for (const [source, column, target] of sharedReferences) {
    const name = sharedKey(source, column, target)
    if (
      !(
        await client.query(
          "SELECT 1 FROM pg_constraint WHERE conname=$1 AND conrelid=$2::regclass",
          [name, source]
        )
      ).rowCount
    )
      await client.query(
        `ALTER TABLE public.${ident(source)} ADD CONSTRAINT ${ident(
          name
        )} FOREIGN KEY(${ident(column)}) REFERENCES public.${ident(target)}(id)`
      )
  }
  // Native order display IDs remain a shared, non-authoritative sequence.
  const sequences = (
    await client.query(
      "SELECT sequencename FROM pg_sequences WHERE schemaname='public' AND sequencename LIKE 'order%display_id%'"
    )
  ).rows
  for (const seq of sequences)
    await client.query(
      `GRANT USAGE,SELECT ON SEQUENCE public.${ident(
        seq.sequencename
      )} TO ${ident(role)}`
    )
  await verify(client, { role })
  return { ...result, nativeReferenceSeedRowsConverted: seedCount }
}
async function verify(client, { role }) {
  const opts = await options(client, role)
  const result = await verifyTenantTables(client, opts)
  await verifyRuntimePrivileges(client, opts)
  for (const name of schema.sharedProviderCatalogs) {
    const permissions = (
      await client.query(
        "SELECT has_table_privilege($1,$2,'SELECT') AS read, has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') AS write",
        [role, `public.${name}`]
      )
    ).rows[0]
    if (!permissions.read || permissions.write)
      throw new Error(`Runtime provider catalog privilege drift: ${name}`)
    if (
      (
        await client.query(
          "SELECT 1 FROM pg_roles r WHERE pg_has_role($1::name,r.oid,'MEMBER') AND has_table_privilege(r.oid,$2::text,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') LIMIT 1",
          [role, `public.${name}`]
        )
      ).rowCount
    )
      throw new Error(
        `Runtime can switch to a mutable provider catalog role: ${name}`
      )
  }
  for (const name of ["region_country", "workflow_execution"]) {
    const row = (
      await client.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND contype='p'",
        [name]
      )
    ).rows[0]
    if (!row?.definition.includes("tenant_id"))
      throw new Error(`Tenant primary key drift: ${name}`)
  }
  for (const [source, column, target] of sharedReferences) {
    const row = (
      await client.query(
        "SELECT pg_get_constraintdef(oid) AS definition,confrelid::regclass::text AS target FROM pg_constraint WHERE conname=$1 AND conrelid=$2::regclass AND contype='f'",
        [sharedKey(source, column, target), source]
      )
    ).rows[0]
    if (
      row?.target !== target ||
      !row.definition.includes(`FOREIGN KEY (${column})`) ||
      !row.definition.includes("REFERENCES " + target + "(id)")
    )
      throw new Error(`Shared provider reference drift: ${source}`)
  }
  return result
}
const checksum = crypto
  .createHash("sha256")
  .update(fs.readFileSync(__filename))
  .update(fs.readFileSync(require.resolve("../m2-schema.json")))
  .update(fs.readFileSync(require.resolve("./tenant-tables.cjs")))
  .update(fs.readFileSync(require.resolve("../runtime-privileges.cjs")))
  .digest("hex")
module.exports = {
  id: "0004-commerce",
  checksum,
  install,
  verify,
  options,
  logical,
  refundDefaults,
}
