// Native Medusa Product/Pricing/Link/Graph/Workflow isolation experiment.
// Only creates/resets the explicitly marked disposable localhost probe DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const DB = 'medusa_saas_catalog_probe';
const MARKER = 'medusa-saas-disposable-catalog-probe-v1';
const ROLE = 'medusa_saas_probe_app';
const adminUrl = `postgres://postgres@localhost:5432/${DB}`;
const appUrl = `postgres://${ROLE}@localhost:5432/${DB}`;
const output = process.env.SAAS_PROBE_RESULT || path.join(__dirname, 'native-catalog-results.json');
const checks = [];
let app, connection;

async function check(name, task) {
  await task();
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function prepareDatabase() {
  const admin = new Client({ connectionString: 'postgres://postgres@localhost:5432/postgres' });
  await admin.connect();
  try {
    const existing = (await admin.query(`SELECT shobj_description(oid, 'pg_database') AS marker
      FROM pg_database WHERE datname = $1`, [DB])).rows[0];
    if (existing) {
      if (!process.argv.includes('--reset') || existing.marker !== MARKER) {
        throw new Error('Probe DB exists. Only --reset of the marked disposable probe DB is permitted.');
      }
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [DB]);
      await admin.query(`DROP DATABASE ${DB}`);
    }
    await admin.query(`CREATE DATABASE ${DB}`);
    await admin.query(`COMMENT ON DATABASE ${DB} IS '${MARKER}'`);
    if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE])).rowCount) {
      await admin.query(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    }
    const role = (await admin.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [ROLE])).rows[0];
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
  } finally { await admin.end(); }
}

async function boot(url) {
  const { MedusaApp } = require('@medusajs/framework/modules-sdk');
  const { createPgConnection, ContainerRegistrationKeys, Modules } = require('@medusajs/framework/utils');
  const MockEventBus = require('@medusajs/test-utils/dist/mock-event-bus-service').default;
  connection = createPgConnection({ clientUrl: url, schema: 'public', pool: { min: 0, max: 2 } });
  const modules = { product: { resolve: '@medusajs/product' }, pricing: { resolve: '@medusajs/pricing' } };
  app = await MedusaApp({
    modulesConfig: modules,
    sharedResourcesConfig: { database: { clientUrl: url, schema: 'public' } },
    injectedDependencies: {
      [ContainerRegistrationKeys.PG_CONNECTION]: connection,
      [ContainerRegistrationKeys.LOGGER]: console,
      [ContainerRegistrationKeys.CONFIG_MODULE]: { modules },
      [Modules.EVENT_BUS]: new MockEventBus(),
    },
  });
  return app;
}

async function shutdown() {
  if (app) {
    await app.onApplicationPrepareShutdown();
    await app.onApplicationShutdown();
    app = undefined;
  }
  if (connection) { await connection.destroy(); connection = undefined; }
  require('@medusajs/framework/modules-sdk').MedusaModule.clearInstances();
}

async function main() {
  await prepareDatabase();
  console.log('Building native module schema with administrator, then switching to the application role');
  await boot(adminUrl);
  await app.runMigrations();
  const planner = app.linkMigrationExecutionPlanner();
  await planner.executePlan(await planner.createPlan());
  await shutdown();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  let schema;
  try { schema = await require('./catalog-schema.cjs').installCatalogIsolation(admin); }
  finally { await admin.end(); }

  await boot(appUrl);
  const { wrapTenantModule } = require('./tenant-module.cjs');
  const { createTenantVerifier, runWithTenant } = require('./tenant-context.cjs');
  const { MedusaModule } = require('@medusajs/framework/modules-sdk');
  for (const [name, service] of Object.entries(app.modules)) wrapTenantModule(service, { name });
  // Link modules live in the module registry, outside app.modules.
  for (const loaded of MedusaModule.getLoadedModules()) {
    for (const [name, service] of Object.entries(loaded)) {
      if (service?.baseRepository_) wrapTenantModule(service, { name });
    }
  }
  await app.onApplicationStart();
  const secret = crypto.randomBytes(48).toString('hex');
  const verify = createTenantVerifier({
    secret, issuer: 'medusa-saas-probe', audience: 'tenant-owner',
    lookupMembership: async ({ tenantId, actorId }) =>
      ({ tenant_a: 'owner_a', tenant_b: 'owner_b' })[tenantId] === actorId,
  });
  const issue = (tenantId, actorId) => jwt.sign({ tenant_id: tenantId }, secret, {
    subject: actorId, algorithm: 'HS256', issuer: 'medusa-saas-probe', audience: 'tenant-owner', expiresIn: '5m',
  });
  const A = await verify(issue('tenant_a', 'owner_a'));
  const B = await verify(issue('tenant_b', 'owner_b'));
  const as = (context, task) => runWithTenant(context, task);
  const product = app.modules.product;
  const pricing = app.modules.pricing;
  let pa, pb, psa, psb, deepA, deepB;

  await check('application role has no RLS bypass', async () => {
    const client = new Client({ connectionString: appUrl }); await client.connect();
    try {
      const r = (await client.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
      assert.equal(r.rolsuper, false); assert.equal(r.rolbypassrls, false);
    } finally { await client.end(); }
  });
  await check('native Product/Variant permits same handle and SKU in two tenants', async () => {
    const data = title => ({ title, handle: 'shared-handle', variants: [{ title: 'Default', sku: 'SHARED-SKU', manage_inventory: false }] });
    pa = await as(A, () => product.createProducts(data('Tenant A')));
    pb = await as(B, () => product.createProducts(data('Tenant B')));
    assert.notEqual(pa.id, pb.id); assert.equal(pa.handle, pb.handle);
    assert.equal(pa.variants[0].sku, pb.variants[0].sku);
  });
  await check('native Product list/count/retrieve and relation population isolate tenants', async () => {
    for (const [ctx, own, other] of [[A, pa, pb], [B, pb, pa]]) {
      const [items, count] = await as(ctx, () => product.listAndCountProducts({}, { relations: ['variants'] }));
      assert.equal(count, 1); assert.deepEqual(items.map(x => x.id), [own.id]);
      assert.equal(items[0].variants[0].id, own.variants[0].id);
      await assert.rejects(as(ctx, () => product.retrieveProduct(other.id)), e => e.type === 'not_found');
    }
  });
  await check('native Product updates cannot affect another tenant', async () => {
    await assert.rejects(as(A, () => product.updateProducts(pb.id, { title: 'ATTACK' })), e => e.type === 'not_found');
    assert.equal((await as(B, () => product.retrieveProduct(pb.id))).title, 'Tenant B');
  });
  await check('native Product delete cannot remove another tenant', async () => {
    await as(A, () => product.deleteProducts([pb.id]));
    assert.equal((await as(B, () => product.retrieveProduct(pb.id))).id, pb.id);
    assert.equal((await as(A, () => product.listProducts())).length, 1);
  });
  await check('forged input tenant and native cross-tenant variant FK are rejected', async () => {
    await assert.rejects(as(A, () => product.createProducts({ title: 'Forged', tenant_id: 'tenant_b' })), e => e.code === 'TENANT_FIELD_FORBIDDEN');
    await assert.rejects(as(A, () => product.createProductVariants({ title: 'Foreign', product_id: pb.id })), e => e.type === 'not_found' || e.type === 'invalid_data');
    assert.equal((await as(A, () => product.listProducts())).length, 1);
  });
  await check('same tenant duplicate handle remains rejected', async () => {
    await assert.rejects(as(A, () => product.createProducts({ title: 'Duplicate', handle: 'shared-handle' })), e =>
      (e.code === '23505' || e.constructor.name === 'UniqueConstraintViolationException') && e.message.includes('IDX_product_handle_unique'));
  });
  await check('native PriceSet/Price rule creation and transaction-bound calculations', async () => {
    psa = await as(A, () => pricing.createPriceSets({ prices: [{ currency_code: 'cny', amount: 129, rules: { region_id: 'region-a' } }] }));
    psb = await as(B, () => pricing.createPriceSets({ prices: [{ currency_code: 'cny', amount: 229, rules: { customer_id: 'customer-b' } }] }));
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`ignored_${i}`, 'ignored']));
    const a = await as(A, () => pricing.calculatePrices({ id: [psa.id, psb.id] }, { context: { ...many, currency_code: 'cny', region_id: 'region-a' } }));
    const b = await as(B, () => pricing.calculatePrices({ id: [psa.id, psb.id] }, { context: { ...many, currency_code: 'cny', customer_id: 'customer-b' } }));
    assert.equal(a.length, 1); assert.equal(a[0].calculated_amount, 129);
    assert.equal(b.length, 1); assert.equal(b[0].calculated_amount, 229);
  });
  await check('native cross-module Link creation and composite FK enforcement', async () => {
    // Try the foreign price before creating valid links. Otherwise native
    // one-to-one validation could mask a missing tenant FK.
    await assert.rejects(as(A, () => app.link.create({ product: { variant_id: pa.variants[0].id }, pricing: { price_set_id: psb.id } })), e =>
      e.code === '23503' || e.constructor.name === 'ForeignKeyConstraintViolationException' ||
      e.message === 'You tried to set relationship undefined, but such entity does not exist');
    await as(A, () => app.link.create({ product: { variant_id: pa.variants[0].id }, pricing: { price_set_id: psa.id } }));
    await as(B, () => app.link.create({ product: { variant_id: pb.variants[0].id }, pricing: { price_set_id: psb.id } }));
  });
  await check('native Query Graph expands only same-tenant variants and prices', async () => {
    for (const [ctx, own, priceSet] of [[A, pa, psa], [B, pb, psb]]) {
      const result = await as(ctx, () => app.query.graph({ entity: 'product', fields: ['id', 'handle', 'variants.id', 'variants.price_set.id', 'variants.price_set.prices.amount'] }, { cache: { enable: false } }));
      assert.equal(result.data.length, 1); assert.equal(result.data[0].id, own.id);
      assert.equal(result.data[0].variants[0].price_set.id, priceSet.id);
    }
  });
  await check('native Workflow module calls retain tenant identity', async () => {
    const { createWorkflow, createStep, StepResponse, WorkflowResponse } = require('@medusajs/framework/workflows-sdk');
    const step = createStep('saas-probe-products', async (_, { container }) =>
      new StepResponse(await container.resolve('product').listProducts()));
    const workflow = createWorkflow('saas-native-tenant-probe', () => new WorkflowResponse(step({})));
    for (const [ctx, own] of [[A, pa], [B, pb]]) {
      const { result } = await as(ctx, () => workflow(app.sharedContainer).run({ input: {} }));
      assert.deepEqual(result.map(x => x.id), [own.id]);
    }
  });
  await check('40 concurrent native calls keep transaction-local tenant context', async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => as(i % 2 ? A : B, async () => {
      const rows = await product.listProducts();
      assert.deepEqual(rows.map(x => x.id), [i % 2 ? pa.id : pb.id]);
    })));
  });
  await check('missing tenant context is denied after connection-pool reuse', async () => {
    await assert.rejects(product.listProducts(), e => e.code === 'TENANT_CONTEXT_REQUIRED');
    // Use the actual native ORM pool that just handled the alternating calls,
    // not merely a new connection, to catch leaked session-level settings.
    const nativeManager = product.baseRepository_.getFreshManager();
    assert.equal((await nativeManager.execute('SELECT count(*)::integer AS n FROM product'))[0].n, 0);
    const client = new Client({ connectionString: appUrl }); await client.connect();
    try {
      assert.equal((await client.query('SELECT count(*)::integer AS n FROM product')).rows[0].n, 0);
      await assert.rejects(client.query(`INSERT INTO product (id, title, handle) VALUES ('no-context', 'No', 'no')`), e => e.code === '42501' || e.code === '23502');
    } finally { await client.end(); }
  });
  await check('authenticated tenant membership rejects forged tenant selection', async () => {
    await assert.rejects(verify(issue('tenant_b', 'owner_a')), e => e.code === 'TENANT_MEMBERSHIP_REQUIRED');
    await assert.rejects(verify(jwt.sign({ tenant_id: 'tenant_b' }, crypto.randomBytes(48).toString('hex'), { subject: 'owner_b' })), e => e.code === 'TENANT_AUTHENTICATION_FAILED');
  });
  await check('raw application SQL rejects cross-tenant native product and price links', async () => {
    const client = new Client({ connectionString: appUrl }); await client.connect();
    try {
      for (const [sql, values] of [
        ['INSERT INTO product_variant (id, title, product_id) VALUES ($1,$2,$3)', ['foreign-variant', 'Foreign', pb.id]],
        ['INSERT INTO product_variant_price_set (id, variant_id, price_set_id) VALUES ($1,$2,$3)', ['foreign-link', pa.variants[0].id, psb.id]],
      ]) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", ['tenant_a']);
        await assert.rejects(client.query(sql, values), error => error.code === '23503');
        await client.query('ROLLBACK');
      }
    } finally { await client.end(); }
  });
  await check('native deep product creation isolates options, values and images', async () => {
    const data = title => ({ title, handle: 'options-handle',
      options: [{ title: 'Color', values: ['Blue', 'Red'] }],
      variants: [{ title: 'Blue', sku: 'COLOR-SKU', options: { Color: 'Blue' }, manage_inventory: false }],
      images: [{ url: 'https://images.example.test/local-fixture.png' }],
    });
    const da = await as(A, () => product.createProducts(data('Deep A')));
    const db = await as(B, () => product.createProducts(data('Deep B')));
    deepA = da; deepB = db;
    assert.equal(da.images.length, 1); assert.equal(db.images.length, 1);
    assert.equal(da.options[0].title, db.options[0].title);
    assert.notEqual(da.images[0].id, db.images[0].id);
    for (const [ctx, own, other] of [[A, da, db], [B, db, da]]) {
      const result = await as(ctx, () => product.retrieveProduct(own.id, { relations: ['images', 'options', 'options.values', 'variants', 'variants.options'] }));
      assert.deepEqual(result.images.map(x => x.id), own.images.map(x => x.id));
      assert.deepEqual(result.options.map(x => x.id), own.options.map(x => x.id));
      assert.deepEqual(result.options[0].values.map(x => x.value).sort(), ['Blue', 'Red']);
      assert.ok(result.options[0].values.every(x => x.option_id === own.options[0].id));
      assert.ok(result.variants[0].options.length > 0);
      assert.ok(result.variants[0].options.every(o => o.option_id === own.options[0].id));
      assert.ok(!result.images.some(x => x.id === other.images[0].id));
    }
  });
  await check('native image pivot rejects both foreign variant and foreign image', async () => {
    const client = new Client({ connectionString: appUrl }); await client.connect();
    try {
      for (const [id, variant, image] of [
        ['foreign-variant-image', pb.variants[0].id, deepA.images[0].id],
        ['foreign-image-variant', pa.variants[0].id, deepB.images[0].id],
      ]) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", ['tenant_a']);
        await assert.rejects(client.query(
          'INSERT INTO product_variant_product_image (id, variant_id, image_id) VALUES ($1,$2,$3)', [id, variant, image]),
          e => e.code === '23503');
        await client.query('ROLLBACK');
      }
    } finally { await client.end(); }
  });
  await check('native variant image add/remove works without affecting another tenant', async () => {
    const pair = p => [{ variant_id: p.variants[0].id, image_id: p.images[0].id }];
    for (const [ctx, own] of [[A, deepA], [B, deepB]]) {
      const created = await as(ctx, () => product.addImageToVariant(pair(own)));
      assert.equal(created.length, 1);
      const read = await as(ctx, () => product.retrieveProductVariant(own.variants[0].id, { relations: ['images'] }));
      assert.deepEqual(read.images.map(i => i.id), own.images.map(i => i.id));
      const listed = await as(ctx, () => product.listProductVariants({ id: own.variants[0].id }, { relations: ['images'] }));
      assert.equal(listed.length, 1);
      assert.deepEqual(listed[0].images.map(i => i.id), own.images.map(i => i.id));
      const [counted, count] = await as(ctx, () => product.listAndCountProductVariants({ id: own.variants[0].id }, { relations: ['images'] }));
      assert.equal(count, 1);
      assert.deepEqual(counted[0].images.map(i => i.id), own.images.map(i => i.id));
    }
    const pivotCount = async (tenantId, own) => {
      const client = new Client({ connectionString: appUrl }); await client.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        const result = await client.query('SELECT count(*)::integer AS n FROM product_variant_product_image WHERE variant_id=$1 AND deleted_at IS NULL', [own.variants[0].id]);
        await client.query('ROLLBACK');
        return result.rows[0].n;
      } finally { await client.end(); }
    };
    await as(A, () => product.removeImageFromVariant(pair(deepB)));
    assert.equal(await pivotCount('tenant_b', deepB), 1);
    await as(A, () => product.removeImageFromVariant(pair(deepA)));
    assert.equal(await pivotCount('tenant_a', deepA), 0);
    await as(B, () => product.removeImageFromVariant(pair(deepB)));
    assert.equal(await pivotCount('tenant_b', deepB), 0);
  });
  await check('both native pool connections clear tenant settings after transactions', async () => {
    const knex = product.baseRepository_.getFreshManager().getKnex();
    const leased = [];
    try {
      leased.push(await knex.client.acquireConnection());
      leased.push(await knex.client.acquireConnection());
      const rows = await Promise.all(leased.map(connection => connection.query(
        "SELECT pg_backend_pid() AS pid, current_setting('app.tenant_id', true) AS tenant, (SELECT count(*)::integer FROM product) AS n")));
      assert.notEqual(rows[0].rows[0].pid, rows[1].rows[0].pid);
      for (const result of rows) {
        assert.ok(result.rows[0].tenant === null || result.rows[0].tenant === '');
        assert.equal(result.rows[0].n, 0);
      }
    } finally {
      await Promise.all(leased.map(connection => knex.client.releaseConnection(connection)));
    }
  });
  await check('40 concurrent native writes preserve tenant-local uniqueness and counts', async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => as(i % 2 ? A : B, () =>
      product.createProducts({ title: i % 2 ? 'Concurrent A' : 'Concurrent B', handle: `concurrent-${Math.floor(i / 2)}` }))));
    for (const [ctx, title] of [[A, 'Concurrent A'], [B, 'Concurrent B']]) {
      const [items, count] = await as(ctx, () => product.listAndCountProducts({ title }, { take: 30 }));
      assert.equal(count, 20); assert.equal(items.length, 20);
      assert.ok(items.every(p => p.title === title));
    }
    assert.equal((await product.baseRepository_.getFreshManager().execute('SELECT count(*)::integer AS n FROM product'))[0].n, 0);
  });
  return { success: true, passed: checks.length, checks, schema,
    scope: 'Actual native Product/Pricing/Link/Query Graph and synchronous Workflow; not full SaaS isolation, production HTTP or persistent worker acceptance',
    sourceCommit: '1014c0337027a6087410ad3cc1da9a11fd83ca8d',
    schemaCaveat: 'Tenant columns are an experiment against native migrated tables; DML/link generator synchronization is a remaining adoption gate',
  };
}

(async () => {
  let result;
  try { result = await main(); }
  catch (error) {
    result = { passed: checks.length, checks, success: false, error: error.message };
    console.error(error.stack); process.exitCode = 1;
  } finally {
    try { await shutdown(); } catch (error) { console.error(error.message); process.exitCode = 1; }
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  }
})();
