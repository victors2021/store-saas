"use strict"

// FORCE RLS does not restrict TRUNCATE. Reject direct, inherited and SET ROLE
// paths to non-DML privileges, and any PUBLIC business/control-table grants.
async function verifyRuntimePrivileges(
  client,
  { role, tables, schema = "public" }
) {
  const rows = (
    await client.query(
      `SELECT c.relname,
    (SELECT bool_and(has_table_privilege($1::name,c.oid,p)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p) AS allowed,
    EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role($1::name,r.oid,'MEMBER')
      AND has_table_privilege(r.oid,c.oid,'TRUNCATE,REFERENCES,TRIGGER')) AS unsafe,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) AS public_access
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$2 AND c.relname=ANY($3::text[]) AND c.relkind='r'`,
      [role, schema, tables]
    )
  ).rows
  if (rows.length !== new Set(tables).size)
    throw new Error("Runtime privilege validation is missing a required table")
  for (const row of rows)
    if (!row.allowed || row.unsafe || row.public_access)
      throw new Error(`Runtime table grant drift: ${schema}.${row.relname}`)
}
module.exports = { verifyRuntimePrivileges }
