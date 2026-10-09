// MIT. Native migrations run first; this version is recorded in the SaaS ledger.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { installTenantTables, verifyTenantTables } = require('./tenant-tables.cjs');
const catalogTables = [
  'product', 'product_category', 'product_category_product', 'product_collection',
  'image', 'product_option', 'product_option_value', 'product_product_option',
  'product_product_option_value', 'product_tag', 'product_tags', 'product_type',
  'product_variant', 'product_variant_option', 'product_variant_product_image',
  'price', 'price_list', 'price_list_rule', 'price_preference', 'price_rule', 'price_set',
];

async function options(client, { role }) {
  if (process.env.MEDUSA_SAAS_MODE !== 'true') throw new Error('Catalog tenant migration requires MEDUSA_SAAS_MODE=true');
  const links = (await client.query('SELECT table_name FROM public.link_module_migrations')).rows.map(row => row.table_name);
  if (!links.includes('product_variant_price_set')) throw new Error('Required native Product/Pricing link missing');
  return {
    role,
    tables: [...new Set([...catalogTables, ...links])],
    requiredTables: [...catalogTables, 'product_variant_price_set'],
    extraForeignKeys: [
      { source: 'product_variant_product_image', source_columns: ['variant_id'], target: 'product_variant', target_columns: ['id'] },
      { source: 'product_variant_price_set', source_columns: ['variant_id'], target: 'product_variant', target_columns: ['id'] },
      { source: 'product_variant_price_set', source_columns: ['price_set_id'], target: 'price_set', target_columns: ['id'] },
    ],
  };
}

async function install(client, context) { return installTenantTables(client, await options(client, context)); }
async function verify(client, context) { return verifyTenantTables(client, await options(client, context)); }

const checksum = crypto.createHash('sha256').update(fs.readFileSync(__filename))
  .update(fs.readFileSync(require.resolve('./tenant-tables.cjs'))).digest('hex');
module.exports = { id: '0002-catalog', checksum, install, verify, catalogTables };
