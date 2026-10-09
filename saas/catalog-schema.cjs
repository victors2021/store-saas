// MIT. Disposable native-schema probe; not a production migration.
// Keep the DML and link generator in sync before adopting this in the product.
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const table = value => `public.${identifier(value)}`;

async function installCatalogIsolation(client) {
  const { rows: tables } = await client.query(`
    -- This owned probe DB contains ONLY the native Product/Pricing modules
    -- and their links. Protect every business table, including native image,
    -- whose name is not prefixed with product. Exclude only migration ledgers.
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      AND tablename NOT LIKE 'mikro_orm_migrations%'
      AND tablename <> 'link_module_migrations'
    ORDER BY tablename
  `);
  if (!tables.some(t => t.tablename === 'product_variant_price_set')) {
    throw new Error('Native product_variant_price_set link has not been migrated');
  }
  const names = new Set(tables.map(t => t.tablename));
  const changes = { tables: [...names], scopedIndexes: [], compositeForeignKeys: [] };
  await client.query('BEGIN');
  try {
    for (const name of names) {
      const { rows } = await client.query(`SELECT count(*)::integer AS n FROM ${table(name)}`);
      if (rows[0].n) throw new Error(`Probe requires empty native table: ${name}`);
      await client.query(`ALTER TABLE ${table(name)} ADD COLUMN tenant_id text NOT NULL
        DEFAULT nullif(current_setting('app.tenant_id', true), '')`);
      await client.query(`ALTER TABLE ${table(name)} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${table(name)} FORCE ROW LEVEL SECURITY`);
      await client.query(`CREATE POLICY tenant_isolation ON ${table(name)}
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''))`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table(name)} TO medusa_saas_probe_app`);
    }

    // Preserve soft-delete predicates and every non-PK unique business index.
    const { rows: indexes } = await client.query(`
      SELECT t.relname AS tablename, i.relname AS indexname,
             pg_get_indexdef(x.indexrelid) AS definition
      FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND x.indisunique AND NOT x.indisprimary
        AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)
    `);
    for (const index of indexes.filter(i => names.has(i.tablename))) {
      if (!index.definition.includes(' USING btree (')) {
        throw new Error(`Review non-btree unique index: ${index.indexname}`);
      }
      await client.query(`DROP INDEX public.${identifier(index.indexname)}`);
      await client.query(index.definition.replace(' USING btree (', ' USING btree (tenant_id, '));
      changes.scopedIndexes.push(index.indexname);
    }

    // All native FK endpoints are scoped, including option and image pivots.
    const { rows: foreignKeys } = await client.query(`
      SELECT c.conname, s.relname AS source, t.relname AS target,
             array_agg(sa.attname::text ORDER BY k.ord) AS source_columns,
             array_agg(ta.attname::text ORDER BY k.ord) AS target_columns
      FROM pg_constraint c JOIN pg_class s ON s.oid = c.conrelid
      JOIN pg_class t ON t.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = s.relnamespace
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(sk, tk, ord)
      JOIN pg_attribute sa ON sa.attrelid = s.oid AND sa.attnum = k.sk
      JOIN pg_attribute ta ON ta.attrelid = t.oid AND ta.attnum = k.tk
      WHERE c.contype = 'f' AND n.nspname = 'public'
      GROUP BY c.oid, c.conname, s.relname, t.relname
    `);
    const targetKeys = new Set();
    for (const fk of foreignKeys.filter(f => names.has(f.source) && names.has(f.target))) {
      const targetKey = `${fk.target}:${fk.target_columns.join(',')}`;
      if (!targetKeys.has(targetKey)) {
        await client.query(`ALTER TABLE ${table(fk.target)} ADD UNIQUE
          (tenant_id, ${fk.target_columns.map(identifier).join(', ')})`);
        targetKeys.add(targetKey);
      }
      await client.query(`ALTER TABLE ${table(fk.source)} ADD FOREIGN KEY
        (tenant_id, ${fk.source_columns.map(identifier).join(', ')})
        REFERENCES ${table(fk.target)} (tenant_id, ${fk.target_columns.map(identifier).join(', ')})`);
      changes.compositeForeignKeys.push(`${fk.source}->${fk.target}`);
    }
    // Native migrations also omit the variant-side image FK. Native link
    // modules deliberately omit cross-module FKs. Add these missing endpoints.
    for (const [source, column, target] of [
      ['product_variant_product_image', 'variant_id', 'product_variant'],
      ['product_variant_price_set', 'variant_id', 'product_variant'],
      ['product_variant_price_set', 'price_set_id', 'price_set'],
    ]) {
      if (!targetKeys.has(`${target}:id`)) {
        await client.query(`ALTER TABLE ${table(target)} ADD UNIQUE (tenant_id, id)`);
        targetKeys.add(`${target}:id`);
      }
      await client.query(`ALTER TABLE ${table(source)} ADD FOREIGN KEY
        (tenant_id, ${identifier(column)}) REFERENCES ${table(target)} (tenant_id, id)`);
      changes.compositeForeignKeys.push(`${source}->${target}`);
    }
    await client.query('COMMIT');
    return changes;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

module.exports = { installCatalogIsolation };
