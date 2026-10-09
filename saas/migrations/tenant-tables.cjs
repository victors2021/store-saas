// MIT. Security DDL shared by reviewed, independently versioned SaaS migrations.
// The caller owns the transaction and migration ledger; this helper never commits.
const crypto = require('node:crypto');
const ident = name => '"' + String(name).replaceAll('"', '""') + '"';
const table = name => `public.${ident(name)}`;
const nameFor = (prefix, value) => prefix + crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
const tenantDefault = "NULLIF(current_setting('app.tenant_id'::text, true), ''::text)";

async function installTenantTables(client, { role, tables, requiredTables = tables, extraForeignKeys = [] }) {
  if (!role || !Array.isArray(tables) || !tables.length) throw new Error('Explicit role and owned table list required');
  const migrationRole = (await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  if (!migrationRole || (!migrationRole.rolsuper && !migrationRole.rolbypassrls)) {
    throw new Error('Tenant ownership validation requires an administrative migration role with RLS bypass');
  }
  const runtimeRole = (await client.query('SELECT oid, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname=$1', [role])).rows[0];
  if (!runtimeRole || runtimeRole.rolsuper || runtimeRole.rolbypassrls || runtimeRole.rolcreaterole || runtimeRole.rolcreatedb) {
    throw new Error('SaaS runtime role must exist without superuser, RLS bypass or role/database creation');
  }
  if ((await client.query(`SELECT 1 FROM pg_roles privileged
    WHERE (privileged.rolsuper OR privileged.rolbypassrls OR privileged.rolcreaterole)
      AND pg_has_role($1::name,privileged.oid,'MEMBER') LIMIT 1`, [role])).rowCount) {
    throw new Error('SaaS runtime role must not inherit or switch to a privileged role');
  }
  const available = new Map((await client.query(`SELECT c.relname, c.relowner FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'`)).rows.map(row => [row.relname, row]));
  for (const required of requiredTables) if (!available.has(required)) throw new Error(`Missing required native table: ${required}`);
  const names = new Set(tables.filter(name => available.has(name)));
  const changes = { tables: [...names].sort(), scopedIndexes: [], compositeForeignKeys: [] };
  for (const name of names) {
    if ((await client.query("SELECT pg_has_role($1::name,$2::oid,'MEMBER') AS member", [role, available.get(name).relowner])).rows[0].member) {
      throw new Error(`Runtime role must not own or switch to owner of tenant table: ${name}`);
    }
    if ((await client.query(`SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=$1
      AND policyname<>'tenant_isolation' LIMIT 1`, [name])).rowCount) {
      throw new Error(`Review additional RLS policies before tenant installation: ${name}`);
    }
    const column = (await client.query(`SELECT data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name='tenant_id'`, [name])).rows[0];
    if (!column) {
      if ((await client.query(`SELECT 1 FROM ${table(name)} LIMIT 1`)).rowCount) {
        throw new Error(`Existing data requires an audited tenant ownership migration: ${name}`);
      }
      await client.query(`ALTER TABLE ${table(name)} ADD COLUMN tenant_id text NOT NULL DEFAULT ${tenantDefault}`);
    } else {
      if (column.data_type !== 'text') throw new Error(`Unexpected tenant_id type on ${name}`);
      // A migration user must be an administrator: FORCE RLS must not hide orphan rows.
      if ((await client.query(`SELECT 1 FROM ${table(name)} WHERE tenant_id IS NULL OR tenant_id='' LIMIT 1`)).rowCount) {
        throw new Error(`Existing data requires an audited tenant ownership migration: ${name}`);
      }
      await client.query(`ALTER TABLE ${table(name)} ALTER COLUMN tenant_id SET NOT NULL,
        ALTER COLUMN tenant_id SET DEFAULT ${tenantDefault}`);
    }
    await client.query(`ALTER TABLE ${table(name)} ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE ${table(name)} FORCE ROW LEVEL SECURITY`);
    await client.query(`DROP POLICY IF EXISTS tenant_isolation ON ${table(name)}`);
    await client.query(`CREATE POLICY tenant_isolation ON ${table(name)}
      USING (tenant_id=${tenantDefault}) WITH CHECK (tenant_id=${tenantDefault})`);
    // PUBLIC never receives a business-table grant from SaaS installation.
    await client.query(`REVOKE ALL ON ${table(name)} FROM PUBLIC`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table(name)} TO ${ident(role)}`);
  }
  await client.query(`GRANT USAGE ON SCHEMA public TO ${ident(role)}`);

  const indexes = (await client.query(`SELECT t.relname AS tablename, i.relname AS indexname,
    pg_get_indexdef(x.indexrelid) AS definition,
    EXISTS (SELECT 1 FROM unnest(x.indkey) key JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=key WHERE a.attname='tenant_id') AS scoped
    FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND x.indisunique AND NOT x.indisprimary
    AND NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conindid=x.indexrelid)`)).rows;
  for (const index of indexes.filter(index => names.has(index.tablename))) {
    if (!index.scoped) {
      if (!index.definition.includes(' USING btree (')) throw new Error(`Review non-btree unique index: ${index.indexname}`);
      await client.query(`DROP INDEX public.${ident(index.indexname)}`);
      await client.query(index.definition.replace(' USING btree (', ' USING btree (tenant_id, '));
    }
    changes.scopedIndexes.push(index.indexname);
  }

  const foreignKeys = (await client.query(`SELECT c.conname, s.relname AS source, t.relname AS target,
    c.confdeltype, c.confupdtype, c.condeferrable, c.condeferred,
    array_agg(sa.attname::text ORDER BY k.ord) AS source_columns,
    array_agg(ta.attname::text ORDER BY k.ord) AS target_columns
    FROM pg_constraint c JOIN pg_class s ON s.oid=c.conrelid JOIN pg_class t ON t.oid=c.confrelid
    JOIN pg_namespace n ON n.oid=s.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY k(sk,tk,ord)
    JOIN pg_attribute sa ON sa.attrelid=s.oid AND sa.attnum=k.sk
    JOIN pg_attribute ta ON ta.attrelid=t.oid AND ta.attnum=k.tk
    WHERE c.contype='f' AND n.nspname='public'
    GROUP BY c.oid,c.conname,s.relname,t.relname`)).rows;
  const action = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
  for (const fk of [...foreignKeys, ...extraForeignKeys]) {
    if (!names.has(fk.source) || !names.has(fk.target) || fk.source_columns.includes('tenant_id')) continue;
    // PostgreSQL 15+ permits a delete SET NULL/DEFAULT column list: preserve
    // native detach behavior while never changing tenant ownership.
    const del = ['n', 'd'].includes(fk.confdeltype)
      ? `${action[fk.confdeltype]} (${fk.source_columns.map(ident).join(',')})`
      : action[fk.confdeltype] || 'NO ACTION';
    if (['n', 'd'].includes(fk.confupdtype)) throw new Error(`Review tenant FK update action: ${fk.conname}`);
    const upd = action[fk.confupdtype] || 'NO ACTION';
    const key = `${fk.target}:${fk.target_columns.join(',')}`;
    const uniqueName = nameFor('saas_uk_', key);
    if (!(await client.query('SELECT 1 FROM pg_constraint WHERE conname=$1 AND conrelid=$2::regclass', [uniqueName, table(fk.target)])).rowCount) {
      await client.query(`ALTER TABLE ${table(fk.target)} ADD CONSTRAINT ${ident(uniqueName)} UNIQUE(tenant_id,${fk.target_columns.map(ident).join(',')})`);
    }
    const fkName = nameFor('saas_fk_', `${fk.source}:${fk.source_columns.join(',')}:${key}`);
    if (!(await client.query('SELECT 1 FROM pg_constraint WHERE conname=$1 AND conrelid=$2::regclass', [fkName, table(fk.source)])).rowCount) {
      await client.query(`ALTER TABLE ${table(fk.source)} ADD CONSTRAINT ${ident(fkName)}
        FOREIGN KEY(tenant_id,${fk.source_columns.map(ident).join(',')})
        REFERENCES ${table(fk.target)}(tenant_id,${fk.target_columns.map(ident).join(',')})
        ON UPDATE ${upd} ON DELETE ${del}
        ${fk.condeferrable ? `DEFERRABLE INITIALLY ${fk.condeferred ? 'DEFERRED' : 'IMMEDIATE'}` : ''}`);
    }
    changes.compositeForeignKeys.push(`${fk.source}->${fk.target}`);
  }
  changes.scopedIndexes.sort();
  changes.compositeForeignKeys.sort();
  return changes;
}

const normalizedExpression = expression => String(expression || '').replace(/::text|\s|[()]/g, '').toLowerCase();

async function verifyTenantTables(client, { role, tables, extraForeignKeys = [] }) {
  const expected = new Set(tables);
  const rows = (await client.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relowner,
    a.attnotnull,format_type(a.atttypid,a.atttypmod) AS type,pg_get_expr(d.adbin,d.adrelid) AS default_sql
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relname=ANY($1::text[])`, [tables])).rows;
  if (rows.length !== expected.size) throw new Error('A required tenant table is missing');
  const runtime = (await client.query('SELECT oid,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=$1', [role])).rows[0];
  if (!runtime || runtime.rolsuper || runtime.rolbypassrls || runtime.rolcreaterole || runtime.rolcreatedb) throw new Error('Unsafe runtime role');
  if ((await client.query(`SELECT 1 FROM pg_roles privileged
    WHERE (privileged.rolsuper OR privileged.rolbypassrls OR privileged.rolcreaterole)
    AND pg_has_role($1::name,privileged.oid,'MEMBER') LIMIT 1`, [role])).rowCount) throw new Error('Unsafe runtime role membership');
  const policies = (await client.query('SELECT tablename,policyname,permissive,cmd,qual,with_check FROM pg_policies WHERE schemaname=$1 AND tablename=ANY($2::text[])', ['public', tables])).rows;
  for (const row of rows) {
    if (!row.relrowsecurity || !row.relforcerowsecurity || !row.attnotnull || row.type !== 'text'
      || normalizedExpression(row.default_sql) !== normalizedExpression(tenantDefault)
      || (await client.query("SELECT pg_has_role($1::name,$2::oid,'MEMBER') AS member", [role,row.relowner])).rows[0].member) throw new Error(`Tenant table security metadata drift: ${row.relname}`);
    const own = policies.filter(policy => policy.tablename === row.relname);
    const expression = normalizedExpression('tenant_id=' + tenantDefault);
    if (own.length !== 1 || own[0].policyname !== 'tenant_isolation' || own[0].cmd !== 'ALL'
      || normalizedExpression(own[0].qual) !== expression || normalizedExpression(own[0].with_check) !== expression) {
      throw new Error(`Tenant RLS policy drift: ${row.relname}`);
    }
  }
  const unscoped = (await client.query(`SELECT t.relname,i.relname AS indexname FROM pg_index x
    JOIN pg_class t ON t.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname=ANY($1::text[]) AND x.indisunique AND NOT x.indisprimary
    AND NOT EXISTS (SELECT 1 FROM unnest(x.indkey) key JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=key WHERE a.attname='tenant_id')`, [tables])).rows;
  if (unscoped.length) throw new Error(`Unscoped tenant uniqueness: ${unscoped[0].indexname}`);
  const foreignKeys = (await client.query(`SELECT s.relname AS source,t.relname AS target,c.conname,
    array_agg(sa.attname::text ORDER BY k.ord) AS source_columns,array_agg(ta.attname::text ORDER BY k.ord) AS target_columns
    FROM pg_constraint c JOIN pg_class s ON s.oid=c.conrelid JOIN pg_class t ON t.oid=c.confrelid
    JOIN pg_namespace n ON n.oid=s.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY k(sk,tk,ord)
    JOIN pg_attribute sa ON sa.attrelid=s.oid AND sa.attnum=k.sk JOIN pg_attribute ta ON ta.attrelid=t.oid AND ta.attnum=k.tk
    WHERE c.contype='f' AND n.nspname='public' GROUP BY c.oid,s.relname,t.relname,c.conname`)).rows;
  for (const fk of [...foreignKeys, ...extraForeignKeys]) {
    if (!expected.has(fk.source) || !expected.has(fk.target) || fk.source_columns.includes('tenant_id')) continue;
    if (!foreignKeys.some(candidate => candidate.source === fk.source && candidate.target === fk.target
      && JSON.stringify(candidate.source_columns) === JSON.stringify(['tenant_id', ...fk.source_columns])
      && JSON.stringify(candidate.target_columns) === JSON.stringify(['tenant_id', ...fk.target_columns]))) {
      throw new Error(`Composite tenant FK missing: ${fk.source}->${fk.target}`);
    }
  }
  return { verifiedTables: rows.length };
}

module.exports = { installTenantTables, verifyTenantTables, tenantDefault };
