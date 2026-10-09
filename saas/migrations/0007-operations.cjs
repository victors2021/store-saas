"use strict"
// Additive M5 operations schema. Earlier migration files and shared checksum
// dependencies remain immutable. Quotas are enforced in native SQL commits.
const fs = require("node:fs")
const crypto = require("node:crypto")
const { installTenantTables, verifyTenantTables } = require("./tenant-tables.cjs")
const tables = ["saas_ops_audit"]
async function schemaFingerprint(client) {
  const names=["public.saas_ops_audit","public.saas_file",...['tenant_usage','plan_assignment','queue_schedule','rate_window','worker_heartbeat','backup_receipt'].map(x=>'saas_control.'+x)]
  const columns=(await client.query(`SELECT n.nspname AS schema,c.relname AS relation,a.attname,a.attnotnull,
    format_type(a.atttypid,a.atttypmod) AS type,pg_get_expr(d.adbin,d.adrelid) AS default_sql
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE c.oid=ANY(SELECT unnest($1::text[])::regclass) AND a.attnum>0 AND NOT a.attisdropped ORDER BY n.nspname,c.relname,a.attnum`,[names])).rows
  const constraints=(await client.query(`SELECT c.conname,c.convalidated,pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c WHERE c.conrelid=ANY(SELECT unnest($1::text[])::regclass) ORDER BY c.conname`,[names])).rows
  const triggers=(await client.query("SELECT tgname,tgenabled,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgname LIKE 'saas_m5_%' ORDER BY tgname")).rows
  const indexes=(await client.query(`SELECT c.relname,i.indisvalid,pg_get_indexdef(c.oid) AS definition FROM pg_index i
    JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=ANY(SELECT unnest($1::text[])::regclass) ORDER BY c.relname`,[names])).rows
  return crypto.createHash('sha256').update(JSON.stringify({columns,constraints,triggers,indexes})).digest('hex')
}
const functions = {
  initialize_usage: `CREATE FUNCTION saas_control.initialize_usage() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
      INSERT INTO saas_control.tenant_usage(tenant_id) VALUES(NEW.id);
      INSERT INTO saas_control.plan_assignment(tenant_id) VALUES(NEW.id);
      INSERT INTO saas_control.queue_schedule(tenant_id) VALUES(NEW.id);
      RETURN NEW; END $$`,
  enforce_quota: `CREATE FUNCTION saas_control.enforce_quota() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE tid text; delta bigint; used bigint; cap bigint;
    BEGIN
      tid := CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
      IF TG_OP='UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
        RAISE EXCEPTION 'Immutable quota tenant' USING ERRCODE='23514'; END IF;
      -- The usage row serializes inserts, restores, deletion and cap changes.
      PERFORM 1 FROM saas_control.tenant_usage WHERE tenant_id=tid FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Missing tenant quota' USING ERRCODE='23514'; END IF;
      IF TG_TABLE_NAME='product' THEN
        delta := (CASE WHEN TG_OP<>'DELETE' AND NEW.deleted_at IS NULL THEN 1 ELSE 0 END)
          - (CASE WHEN TG_OP<>'INSERT' AND OLD.deleted_at IS NULL THEN 1 ELSE 0 END);
        SELECT product_count+delta INTO used FROM saas_control.tenant_usage WHERE tenant_id=tid;
        SELECT product_limit INTO cap FROM saas_control.plan_assignment WHERE tenant_id=tid;
        IF delta>0 AND used>cap THEN RAISE EXCEPTION 'Product quota exceeded' USING ERRCODE='P5001'; END IF;
        UPDATE saas_control.tenant_usage SET product_count=used WHERE tenant_id=tid;
      ELSE
        IF TG_OP='INSERT' AND (NEW.storage_state<>'pending' OR NEW.content_hash !~ '^[a-f0-9]{64}$') THEN
          RAISE EXCEPTION 'M5 upload reservation and digest required' USING ERRCODE='23514'; END IF;
        IF TG_OP='UPDATE' AND (NEW.byte_size,NEW.content_hash,NEW.storage_key) IS DISTINCT FROM
          (OLD.byte_size,OLD.content_hash,OLD.storage_key) THEN
          RAISE EXCEPTION 'Object size, digest and path are immutable' USING ERRCODE='23514'; END IF;
        delta := (CASE WHEN TG_OP<>'DELETE' THEN NEW.byte_size ELSE 0 END)
          - (CASE WHEN TG_OP<>'INSERT' THEN OLD.byte_size ELSE 0 END);
        SELECT upload_bytes+delta INTO used FROM saas_control.tenant_usage WHERE tenant_id=tid;
        SELECT upload_limit_bytes INTO cap FROM saas_control.plan_assignment WHERE tenant_id=tid;
        IF delta>0 AND used>cap THEN RAISE EXCEPTION 'Upload quota exceeded' USING ERRCODE='P5001'; END IF;
        UPDATE saas_control.tenant_usage SET upload_bytes=used WHERE tenant_id=tid;
      END IF;
      IF used<0 THEN RAISE EXCEPTION 'Quota accounting underflow' USING ERRCODE='23514'; END IF;
      RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
    END $$`,
  validate_plan: `CREATE FUNCTION saas_control.validate_plan() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE usage saas_control.tenant_usage;
    BEGIN
      SELECT * INTO usage FROM saas_control.tenant_usage WHERE tenant_id=NEW.tenant_id FOR UPDATE;
      IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NOT FOUND OR
        NEW.product_limit<usage.product_count OR NEW.upload_limit_bytes<usage.upload_bytes THEN
        RAISE EXCEPTION 'Plan caps cannot be below usage' USING ERRCODE='P5001'; END IF;
      RETURN NEW;
    END $$`,
  clean_ephemeral: `CREATE FUNCTION saas_control.clean_ephemeral() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE sessions integer; rates integer;
    BEGIN
      DELETE FROM saas_control.http_session WHERE id IN
        (SELECT id FROM saas_control.http_session WHERE expires_at<now() ORDER BY expires_at LIMIT 1000);
      GET DIAGNOSTICS sessions = ROW_COUNT;
      DELETE FROM saas_control.rate_window WHERE (scope,bucket) IN
        (SELECT scope,bucket FROM saas_control.rate_window WHERE bucket<date_trunc('minute',now())-interval '2 hours' LIMIT 1000);
      GET DIAGNOSTICS rates = ROW_COUNT;
      DELETE FROM saas_control.worker_heartbeat WHERE id IN
        (SELECT id FROM saas_control.worker_heartbeat WHERE state='stopped' AND last_seen<now()-interval '7 days' ORDER BY last_seen LIMIT 1000);
      RETURN jsonb_build_object('sessions',sessions,'rate_windows',rates);
    END $$`,
  clean_tenant_ephemeral: `CREATE FUNCTION saas_control.clean_tenant_ephemeral() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE tid text; caches integer; locks integer; audits integer; events integer;
    BEGIN
      tid := NULLIF(current_setting('app.tenant_id',true),'');
      IF tid IS NULL THEN RAISE EXCEPTION 'Tenant context required' USING ERRCODE='23514'; END IF;
      DELETE FROM public.saas_cache WHERE tenant_id=tid AND id IN
        (SELECT id FROM public.saas_cache WHERE tenant_id=tid AND expires_at<now() ORDER BY expires_at LIMIT 1000);
      GET DIAGNOSTICS caches=ROW_COUNT;
      DELETE FROM public.saas_lock WHERE tenant_id=tid AND id IN
        (SELECT id FROM public.saas_lock WHERE tenant_id=tid AND expires_at<now() ORDER BY expires_at LIMIT 1000);
      GET DIAGNOSTICS locks=ROW_COUNT;
      DELETE FROM public.saas_ops_audit WHERE id IN(SELECT id FROM public.saas_ops_audit
        WHERE tenant_id=tid AND created_at<now()-interval '90 days' ORDER BY created_at LIMIT 1000);
      GET DIAGNOSTICS audits=ROW_COUNT;
      -- Payment/cart ledgers and all native workflow checkpoints are retained.
      WITH expired AS (SELECT j.id FROM public.saas_job j JOIN saas_control.task_dispatch d ON d.id=j.id AND d.tenant_id=j.tenant_id
        WHERE j.tenant_id=tid AND j.kind LIKE 'event:%' AND j.state='done' AND d.state='done'
        AND j.updated_at<now()-interval '30 days' ORDER BY j.updated_at LIMIT 1000),
        removed AS (DELETE FROM saas_control.task_dispatch d USING expired e WHERE d.id=e.id RETURNING d.id)
        DELETE FROM public.saas_job j USING removed r WHERE j.tenant_id=tid AND j.id=r.id;
      GET DIAGNOSTICS events=ROW_COUNT;
      RETURN jsonb_build_object('caches',caches,'locks',locks,'audits',audits,'events',events);
    END $$`,
}
async function install(client, { role, legacyFiles = [] }) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role)) throw new Error("Invalid application role")
  await client.query(`CREATE TABLE saas_control.tenant_usage (
    tenant_id text PRIMARY KEY REFERENCES saas_control.tenant(id),
    product_count bigint NOT NULL DEFAULT 0 CHECK(product_count>=0),
    upload_bytes bigint NOT NULL DEFAULT 0 CHECK(upload_bytes>=0));
    CREATE TABLE saas_control.plan_assignment (
    tenant_id text PRIMARY KEY REFERENCES saas_control.tenant(id),
    plan_id text NOT NULL DEFAULT 'pilot' CHECK(plan_id='pilot'),
    product_limit integer NOT NULL DEFAULT 1000 CHECK(product_limit BETWEEN 1 AND 100000),
    upload_limit_bytes bigint NOT NULL DEFAULT 104857600 CHECK(upload_limit_bytes BETWEEN 1 AND 1099511627776),
    requests_per_minute integer NOT NULL DEFAULT 1200 CHECK(requests_per_minute BETWEEN 10 AND 10000),
    version integer NOT NULL DEFAULT 1 CHECK(version>0),
    manual_reference text NOT NULL DEFAULT '' CHECK(length(manual_reference)<=120),
    updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE saas_control.queue_schedule (
    tenant_id text PRIMARY KEY REFERENCES saas_control.tenant(id), last_served_at timestamptz);
    CREATE TABLE saas_control.rate_window (
    scope text NOT NULL, bucket timestamptz NOT NULL, hits integer NOT NULL CHECK(hits>0), PRIMARY KEY(scope,bucket));
    CREATE TABLE saas_control.worker_heartbeat (
    id text PRIMARY KEY, last_seen timestamptz NOT NULL DEFAULT now(), state text NOT NULL CHECK(state IN ('running','stopped')));
    CREATE TABLE saas_control.backup_receipt (
    id text PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT now(),
    sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), byte_size bigint NOT NULL CHECK(byte_size>0),
    object_count integer NOT NULL CHECK(object_count>=0));
    CREATE TABLE saas_ops_audit (
    id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id',true),''),
    actor_id text NOT NULL, request_id text NOT NULL, action text NOT NULL,
    route text NOT NULL, method text NOT NULL, status integer NOT NULL CHECK(status BETWEEN 0 AND 599),
    error_code text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id));
    CREATE INDEX saas_ops_audit_tenant_time ON saas_ops_audit(tenant_id,created_at DESC);
    ALTER TABLE saas_file ADD COLUMN byte_size bigint NOT NULL DEFAULT 0 CHECK(byte_size BETWEEN 0 AND 5242880),
      ADD COLUMN content_hash text NOT NULL DEFAULT '' CHECK(content_hash='' OR content_hash ~ '^[a-f0-9]{64}$'),
      ADD COLUMN storage_state text NOT NULL DEFAULT 'ready' CHECK(storage_state IN ('pending','ready','deleting'));
    ALTER TABLE saas_control.task_dispatch ADD COLUMN kind text NOT NULL DEFAULT 'legacy';
    UPDATE saas_control.task_dispatch d SET kind=j.kind FROM public.saas_job j WHERE j.id=d.id AND j.tenant_id=d.tenant_id;
    INSERT INTO saas_control.tenant_usage(tenant_id,product_count)
      SELECT t.id,(SELECT count(*) FROM public.product p WHERE p.tenant_id=t.id AND p.deleted_at IS NULL) FROM saas_control.tenant t;
    INSERT INTO saas_control.plan_assignment(tenant_id,product_limit)
      SELECT tenant_id,greatest(1000,product_count)::integer FROM saas_control.tenant_usage;
    INSERT INTO saas_control.queue_schedule(tenant_id) SELECT id FROM saas_control.tenant;`)
  if ((await client.query("SELECT count(*)::int n FROM saas_file")).rows[0].n !== legacyFiles.length)
    throw new Error("Existing files require validated local sizes and hashes before M5 migration")
  for (const row of legacyFiles) {
    const updated = await client.query("UPDATE saas_file SET byte_size=$2,content_hash=$3 WHERE id=$1 AND storage_key=$4",
      [row.id,row.byteSize,row.hash,row.storage_key])
    if (updated.rowCount !== 1) throw new Error("Legacy object manifest changed during migration")
  }
  await client.query(`ALTER TABLE saas_file ADD CONSTRAINT saas_m5_file_namespace CHECK(
    id ~ '^file_[a-f0-9]{40}$' AND storage_key=encode(sha256(convert_to(tenant_id,'UTF8')),'hex')||'/'||id)`)
  await client.query(`UPDATE saas_control.tenant_usage u SET upload_bytes=(SELECT coalesce(sum(byte_size),0) FROM saas_file f WHERE f.tenant_id=u.tenant_id);
    UPDATE saas_control.plan_assignment p SET upload_limit_bytes=greatest(p.upload_limit_bytes,u.upload_bytes) FROM saas_control.tenant_usage u WHERE u.tenant_id=p.tenant_id;`)
  const result = await installTenantTables(client,{role,tables})
  for (const sql of Object.values(functions)) await client.query(sql)
  await client.query(`CREATE TRIGGER saas_m5_initialize AFTER INSERT ON saas_control.tenant FOR EACH ROW EXECUTE FUNCTION saas_control.initialize_usage();
    CREATE TRIGGER saas_m5_product_quota BEFORE INSERT OR UPDATE OR DELETE ON public.product FOR EACH ROW EXECUTE FUNCTION saas_control.enforce_quota();
    CREATE TRIGGER saas_m5_file_quota BEFORE INSERT OR UPDATE OR DELETE ON public.saas_file FOR EACH ROW EXECUTE FUNCTION saas_control.enforce_quota();
    CREATE TRIGGER saas_m5_plan_caps BEFORE UPDATE ON saas_control.plan_assignment FOR EACH ROW EXECUTE FUNCTION saas_control.validate_plan();
    REVOKE ALL ON saas_control.tenant_usage,saas_control.plan_assignment,saas_control.queue_schedule,
      saas_control.rate_window,saas_control.worker_heartbeat,saas_control.backup_receipt FROM PUBLIC;
    GRANT SELECT ON saas_control.tenant_usage,saas_control.backup_receipt TO "${role}";
    GRANT SELECT,UPDATE ON saas_control.plan_assignment,saas_control.queue_schedule TO "${role}";
    GRANT SELECT,INSERT,UPDATE,DELETE ON saas_control.rate_window,saas_control.worker_heartbeat TO "${role}";
    REVOKE UPDATE,DELETE ON public.saas_ops_audit FROM "${role}";`)
  for (const name of Object.keys(functions)) await client.query(`REVOKE ALL ON FUNCTION saas_control.${name}() FROM PUBLIC`)
  await client.query(`GRANT EXECUTE ON FUNCTION saas_control.clean_ephemeral(),saas_control.clean_tenant_ephemeral() TO "${role}"`)
  return {...result,controlTables:6,quotaTriggers:4,schemaFingerprint:await schemaFingerprint(client)}
}
async function verify(client,{role,expectedFingerprint}) {
  if(expectedFingerprint&&await schemaFingerprint(client)!==expectedFingerprint)throw new Error("M5 schema constraints, columns or indexes drifted")
  await verifyTenantTables(client,{role,tables})
  const grants={tenant_usage:["SELECT"],backup_receipt:["SELECT"],plan_assignment:["SELECT","UPDATE"],queue_schedule:["SELECT","UPDATE"],
    rate_window:["SELECT","INSERT","UPDATE","DELETE"],worker_heartbeat:["SELECT","INSERT","UPDATE","DELETE"],"public.saas_ops_audit":["SELECT","INSERT"]}
  for (const [name,allowed] of Object.entries(grants)) {
    const relation=name.includes(".")?name:`saas_control.${name}`
    const row=(await client.query(`SELECT c.relowner,pg_has_role($1::name,c.relowner,'MEMBER') AS owner,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) AS public_access
      FROM pg_class c WHERE c.oid=to_regclass($2)`,[role,relation])).rows[0]
    if (!row||row.owner||row.public_access) throw new Error(`M5 table security drift: ${relation}`)
    for(const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"])
      if((await client.query("SELECT has_table_privilege($1::name,$2,$3) ok",[role,relation,privilege])).rows[0].ok!==allowed.includes(privilege))
        throw new Error(`M5 privilege drift: ${relation}.${privilege}`)
  }
  for(const [name,table,fn] of [["saas_m5_initialize","saas_control.tenant","initialize_usage"],
    ["saas_m5_product_quota","public.product","enforce_quota"],["saas_m5_file_quota","public.saas_file","enforce_quota"],
    ["saas_m5_plan_caps","saas_control.plan_assignment","validate_plan"]]) {
    if(!(await client.query(`SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE t.tgname=$1 AND t.tgrelid=$2::regclass AND t.tgenabled='O' AND n.nspname='saas_control' AND p.proname=$3`,[name,table,fn])).rowCount)
      throw new Error(`M5 quota trigger missing or disabled: ${name}`)
  }
  for(const name of Object.keys(functions)) {
    const row=(await client.query(`SELECT p.prosecdef,p.proconfig,p.prosrc,pg_has_role($1::name,p.proowner,'MEMBER') AS owner,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) AS public_access,
      has_function_privilege($1::name,p.oid,'EXECUTE') AS execute FROM pg_proc p WHERE p.oid=to_regprocedure($2)`,[role,`saas_control.${name}()`])).rows[0]
    if(!row?.prosecdef||row.owner||row.public_access||row.proconfig?.join()!=="search_path=pg_catalog"||row.execute!==name.startsWith("clean_")||
      row.prosrc.trim()!==functions[name].match(/\$\$([\s\S]+)\$\$/)[1].trim())
      throw new Error(`M5 function security drift: ${name}`)
  }
  for (const [table,column,type] of [["saas_file","byte_size","bigint"],["saas_file","content_hash","text"],["saas_file","storage_state","text"],["task_dispatch","kind","text"]])
    if(!(await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3 AND data_type=$4 AND is_nullable='NO'",[table==="task_dispatch"?"saas_control":"public",table,column,type])).rowCount)
      throw new Error(`M5 required column drift: ${table}.${column}`)
  return {verifiedTables:1,verifiedQuotaTriggers:4}
}
const checksum=crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex")
module.exports={id:"0007-operations",checksum,tables,install,verify}
