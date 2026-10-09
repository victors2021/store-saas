// MIT. Reproducible M1 catalog migration test; only the marked local DB is reset.
process.env.MEDUSA_SAAS_MODE = 'true';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { MedusaApp, MedusaModule } = require('@medusajs/framework/modules-sdk');
const { createPgConnection, ContainerRegistrationKeys, Modules, TENANT_ID_DEFAULT_SQL } = require('@medusajs/framework/utils');
const MockEventBus = require('@medusajs/test-utils/dist/mock-event-bus-service').default;
const migration = require('./migrations/0002-catalog.cjs');
const DB = 'medusa_m1_catalog_migration_probe';
const MARKER = 'medusa-m1-catalog-migration-disposable-v1';
const ROLE = 'medusa_m1_catalog_probe_app';
const url = `postgres://postgres@localhost:5432/${DB}`;
const checks = [];
let app, connection, schema;
const check = async (name, task) => { await task(); checks.push(name); console.log(`PASS ${name}`); };
async function prepare() {
  const client = new Client({ connectionString: 'postgres://postgres@localhost:5432/postgres' });
  await client.connect();
  try {
    const old = (await client.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [DB])).rows[0];
    if (old) {
      if (!process.argv.includes('--reset') || old.marker !== MARKER) throw new Error('Only the marked disposable catalog migration DB may be reset');
      await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [DB]);
      await client.query(`DROP DATABASE ${DB}`);
    }
    await client.query(`CREATE DATABASE ${DB}`);
    await client.query(`COMMENT ON DATABASE ${DB} IS '${MARKER}'`);
    if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [ROLE])).rowCount) {
      await client.query(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    }
  } finally { await client.end(); }
}
async function boot() {
  connection = createPgConnection({ clientUrl: url, schema: 'public', pool: { min: 0, max: 2 } });
  const modules = { product: { resolve: '@medusajs/product' }, pricing: { resolve: '@medusajs/pricing' } };
  app = await MedusaApp({ modulesConfig: modules, sharedResourcesConfig: { database: { clientUrl: url, schema: 'public' } },
    injectedDependencies: {
      [ContainerRegistrationKeys.PG_CONNECTION]: connection,
      [ContainerRegistrationKeys.LOGGER]: console,
      [ContainerRegistrationKeys.CONFIG_MODULE]: { modules },
      [Modules.EVENT_BUS]: new MockEventBus(),
    } });
}
async function apply(client) {
  await client.query('BEGIN');
  try { const result = await migration.install(client, { role: ROLE }); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function main() {
  await prepare(); await boot(); await app.runMigrations();
  const planner = app.linkMigrationExecutionPlanner();
  await planner.executePlan(await planner.createPlan());
  const client = new Client({ connectionString: url }); await client.connect();
  try {
    await check('versioned catalog tenant migration installs after native schema', async () => { schema = await apply(client); assert.equal(schema.tables.length, 41); });
    await check('tenant migration rerun is idempotent and preserves policies/FKs', async () => {
      const before = (await client.query("SELECT conname FROM pg_constraint WHERE conname LIKE 'saas_%' ORDER BY conname")).rows;
      assert.deepEqual(await apply(client), schema);
      assert.deepEqual((await client.query("SELECT conname FROM pg_constraint WHERE conname LIKE 'saas_%' ORDER BY conname")).rows, before);
      assert.deepEqual(await migration.verify(client, { role: ROLE }), { verifiedTables: 41 });
      await app.runMigrations();
    });
    await check('all scoped native tables have mandatory trusted SQL tenant default and forced RLS', async () => {
      const rows = (await client.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_sql
        FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id'
        JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE c.relname=ANY($1::text[])`, [schema.tables])).rows;
      assert.equal(rows.length, schema.tables.length);
      for (const row of rows) { assert.equal(row.relrowsecurity,true); assert.equal(row.relforcerowsecurity,true); assert.equal(row.attnotnull,true); assert.match(row.default_sql,/current_setting\('app\.tenant_id'/); }
    });
    await check('DML metadata includes tenant default on Product/Pricing and all implicit pivots', async () => {
      for (const name of ['product','pricing']) {
        const manager = app.modules[name].baseRepository_.getFreshManager();
        const metadata = manager.getDriver().getMetadata();
        for (const meta of Object.values(metadata.getAll())) {
          if (meta.abstract || meta.embeddable) continue;
          assert.equal(meta.properties.tenant_id?.defaultRaw, TENANT_ID_DEFAULT_SQL, `${meta.tableName} tenant metadata`);
          assert.equal(meta.properties.tenant_id.nullable, false);
        }
      }
    });
    await check('repeated native Link schema plan preserves tenant FKs and returns noop', async () => {
      const plan = await planner.createPlan();
      if (plan.some(action => action.action !== 'noop')) console.error(JSON.stringify(plan.filter(action => action.action !== 'noop'), null, 2));
      assert.ok(plan.length > 0);
      assert.deepEqual([...new Set(plan.map(action => action.action))], ['noop']);
      await planner.executePlan(plan);
      const fkCount = (await client.query("SELECT count(*)::integer AS n FROM pg_constraint WHERE conname LIKE 'saas_fk_%'")).rows[0].n;
      assert.equal(fkCount, 24);
    });
    await check('empty context runtime inserts fail closed; native tenant handle uniqueness works', async () => {
      const runtime = new Client({ connectionString: `postgres://${ROLE}@localhost:5432/${DB}` }); await runtime.connect();
      try {
        await assert.rejects(runtime.query("INSERT INTO product(id,title,handle) VALUES('missing','Missing','missing')"), error => ['42501','23502'].includes(error.code));
        for (const tenant of ['tenant_a','tenant_b']) {
          await runtime.query('BEGIN');
          await runtime.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
          await runtime.query('INSERT INTO product(id,title,handle) VALUES($1,$2,$3)', [tenant+'product', tenant, 'same-handle']);
          await runtime.query('INSERT INTO product_variant(id,title,product_id) VALUES($1,$2,$3)', [tenant+'variant', tenant, tenant+'product']);
          await runtime.query('INSERT INTO price_set(id) VALUES($1)', [tenant+'priceset']);
          const result = await runtime.query('SELECT id FROM product'); assert.deepEqual(result.rows, [{ id: tenant+'product' }]);
          await runtime.query('COMMIT');
        }
        await runtime.query('BEGIN'); await runtime.query("SELECT set_config('app.tenant_id','tenant_a',true)");
        await assert.rejects(runtime.query("INSERT INTO product(id,title,handle) VALUES('dup','Dup','same-handle')"), error => error.code === '23505'); await runtime.query('ROLLBACK');
        await runtime.query('BEGIN'); await runtime.query("SELECT set_config('app.tenant_id','tenant_a',true)");
        await assert.rejects(runtime.query("INSERT INTO product_variant(id,title,product_id) VALUES('foreign','Foreign','tenant_bproduct')"), error => error.code === '23503'); await runtime.query('ROLLBACK');
        for (const [variant, priceSet] of [['tenant_avariant','tenant_bpriceset'],['tenant_bvariant','tenant_apriceset']]) {
          await runtime.query('BEGIN'); await runtime.query("SELECT set_config('app.tenant_id','tenant_a',true)");
          await assert.rejects(runtime.query('INSERT INTO product_variant_price_set(id,variant_id,price_set_id) VALUES($1,$2,$3)', ['foreign-'+variant,variant,priceSet]), error => error.code === '23503');
          await runtime.query('ROLLBACK');
        }
        assert.equal((await runtime.query('SELECT count(*)::integer AS n FROM product')).rows[0].n,0);
      } finally { await runtime.end(); }
    });
    await check('read-only startup verifier detects removed FK, altered policy and unsafe role', async () => {
      const fk = (await client.query("SELECT conname FROM pg_constraint WHERE conrelid='public.product_variant_price_set'::regclass AND conname LIKE 'saas_fk_%' ORDER BY conname LIMIT 1")).rows[0].conname;
      await client.query('BEGIN');
      try {
        await client.query(`ALTER TABLE product_variant_price_set DROP CONSTRAINT "${fk}"`);
        await assert.rejects(migration.verify(client, { role: ROLE }), /Composite tenant FK missing/);
      } finally { await client.query('ROLLBACK'); }
      await client.query('BEGIN');
      try {
        await client.query('ALTER POLICY tenant_isolation ON product USING (true)');
        await assert.rejects(migration.verify(client, { role: ROLE }), /Tenant RLS policy drift/);
      } finally { await client.query('ROLLBACK'); }
      await assert.rejects(migration.verify(client, { role: 'postgres' }), /Unsafe runtime role/);
      await client.query('BEGIN');
      try {
        await client.query('CREATE ROLE medusa_m1_catalog_probe_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE');
        await client.query('ALTER TABLE product OWNER TO medusa_m1_catalog_probe_owner');
        await client.query(`GRANT medusa_m1_catalog_probe_owner TO ${ROLE}`);
        await assert.rejects(migration.verify(client, { role: ROLE }), /Tenant table security metadata drift/);
        await assert.rejects(migration.install(client, { role: ROLE }), /must not own or switch to owner/);
      } finally { await client.query('ROLLBACK'); }
      await migration.verify(client, { role: ROLE });
    });
    await check('unowned existing native rows require explicit ownership migration', async () => {
      await client.query('BEGIN');
      try {
        await client.query('CREATE TABLE public.m1_unowned_probe(id text PRIMARY KEY)');
        await client.query("INSERT INTO public.m1_unowned_probe VALUES('preexisting')");
        await assert.rejects(require('./migrations/tenant-tables.cjs').installTenantTables(client, { role: ROLE, tables: ['m1_unowned_probe'] }), /audited tenant ownership migration/);
      } finally { await client.query('ROLLBACK'); }
    });
  } finally { await client.end(); }
}
main().then(() => {
  const output = process.env.SAAS_CATALOG_MIGRATION_RESULT || path.join(__dirname,'catalog-migration-results.json');
  fs.writeFileSync(output, JSON.stringify({ success:true,passed:checks.length,checks,schema,migrationId:migration.id,migrationChecksum:migration.checksum },null,2)+'\n');
}).catch(error => { console.error(error); process.exitCode=1; }).finally(async () => {
  if (app) { await app.onApplicationPrepareShutdown(); await app.onApplicationShutdown(); }
  if (connection) await connection.destroy(); MedusaModule.clearInstances();
});
