"use strict"
const fs=require("node:fs"),crypto=require("node:crypto")
const grants={portal_account:["SELECT","INSERT"],portal_session:["SELECT","INSERT","DELETE"],portal_shop:["SELECT","INSERT"],portal_demo_product:["SELECT","INSERT","DELETE"]}
async function fingerprint(c){
  const names=Object.keys(grants),relations=names.map(n=>`saas_control.${n}`)
  const columns=(await c.query(`SELECT c.relname,a.attname,a.attnotnull,format_type(a.atttypid,a.atttypmod) type,pg_get_expr(d.adbin,d.adrelid) default_sql
    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE c.oid=ANY(SELECT unnest($1::text[])::regclass) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,[relations])).rows
  const constraints=(await c.query(`SELECT conname,convalidated,pg_get_constraintdef(oid) definition FROM pg_constraint
    WHERE conrelid=ANY(SELECT unnest($1::text[])::regclass) ORDER BY conname`,[relations])).rows
  const indexes=(await c.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='saas_control' AND tablename=ANY($1::text[]) ORDER BY indexname",[names])).rows
  return crypto.createHash("sha256").update(JSON.stringify({columns,constraints,indexes})).digest("hex")
}
async function install(c,{role}){
  if(!/^[a-z_][a-z0-9_]{0,62}$/.test(role))throw new Error("Valid runtime role required")
  await c.query(`CREATE TABLE saas_control.portal_account(
    id text PRIMARY KEY CHECK(id ~ '^acct_[a-f0-9]{32}$'),
    email text NOT NULL UNIQUE CHECK(length(email)<=254 AND email=lower(btrim(email)) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
    password_hash text NOT NULL CHECK(password_hash ~ '^scrypt\\$32768\\$8\\$1\\$[a-f0-9]{32}\\$[a-f0-9]{64}$'),
    status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
    version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE saas_control.portal_session(
    id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),account_id text NOT NULL REFERENCES saas_control.portal_account(id),
    account_version integer NOT NULL CHECK(account_version>0),csrf_secret text NOT NULL CHECK(csrf_secret ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL);
  CREATE INDEX portal_session_expiry ON saas_control.portal_session(expires_at);
  CREATE TABLE saas_control.portal_shop(
    account_id text NOT NULL REFERENCES saas_control.portal_account(id),request_key text NOT NULL CHECK(request_key ~ '^[A-Za-z0-9_-]{8,128}$'),
    owner_actor_id text NOT NULL UNIQUE CHECK(owner_actor_id ~ '^usr_[a-f0-9]{26}$'),
    slug text NOT NULL,name text NOT NULL,input_fingerprint text NOT NULL CHECK(input_fingerprint ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account_id,request_key));
  CREATE TABLE saas_control.portal_demo_product(
    tenant_id text NOT NULL REFERENCES saas_control.tenant(id),template_key text NOT NULL CHECK(template_key IN ('shirt','mug','bag')),
    product_id text NOT NULL UNIQUE CHECK(product_id ~ '^prod_[a-f0-9]{26}$'),
    created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,template_key));`)
  for(const [name,allowed]of Object.entries(grants))await c.query(`REVOKE ALL ON saas_control.${name} FROM PUBLIC,"${role}"; GRANT ${allowed.join(",")} ON saas_control.${name} TO "${role}"`)
  return {controlTables:4,schemaFingerprint:await fingerprint(c)}
}
async function verify(c,{role,expectedFingerprint}){
  if(!expectedFingerprint||await fingerprint(c)!==expectedFingerprint)throw new Error("Self-service schema drift")
  for(const [name,allowed]of Object.entries(grants)){
    const relation=`saas_control.${name}`,row=(await c.query(`SELECT pg_has_role($1::name,c.relowner,'MEMBER') owner,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) public_access
      FROM pg_class c WHERE c.oid=to_regclass($2)`,[role,relation])).rows[0]
    if(!row||row.owner||row.public_access)throw new Error("Self-service table authority drift")
    for(const p of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"])
      if((await c.query("SELECT has_table_privilege($1::name,$2,$3) ok",[role,relation,p])).rows[0].ok!==allowed.includes(p))throw new Error("Self-service privilege drift")
  }
}
module.exports={id:"0009-self-service",checksum:crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),install,verify}
