"use strict"
const crypto = require("node:crypto"),
  jwt = require("jsonwebtoken")
const {
  currentTenant,
  runWithTenant,
  createTenantVerifier,
  TenantSecurityError,
} = require("./tenant-context.cjs")
const { tenantSQL } = require("./tenant-sql.cjs")
const fail = (code, message) => {
  throw new TenantSecurityError(code, message)
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])])
    )
  return value
}
function rejectAuthority(value) {
  if (!value || typeof value !== "object") return
  for (const [key, item] of Object.entries(value)) {
    if (
      [
        "tenant_id",
        "tenantId",
        "envelope",
        "manager",
        "transactionManager",
      ].includes(key)
    )
      fail(
        "TENANT_JOB_AUTHORITY_FORBIDDEN",
        "Job payload cannot supply tenant authority"
      )
    rejectAuthority(item)
  }
}

function createTenantJobs({
  pool,
  secret,
  lookupMembership,
  handlers = new Map(),
  leaseSeconds = 120,
  maxAttempts = 5,
  getOperations = () => undefined,
  resolveHandler = () => undefined,
}) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32)
    throw new TypeError("Persistent worker signing secret required")
  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < 1 ||
    leaseSeconds > 240 ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 20
  )
    throw new TypeError("Bounded worker lease and attempt limits are required")
  async function contextFor(row) {
    let claims
    try {
      claims = jwt.verify(row.envelope, secret, {
        algorithms: ["HS256"],
        issuer: "medusa-saas-dispatch",
        audience: "worker-dispatch",
      })
    } catch {
      fail("TENANT_JOB_ENVELOPE_INVALID", "Invalid persisted worker envelope")
    }
    if (
      claims.job_id !== row.id ||
      claims.tenant_id !== row.tenant_id ||
      typeof claims.sub !== "string"
    )
      fail(
        "TENANT_JOB_ENVELOPE_INVALID",
        "Worker envelope does not match its dispatch"
      )
    const verifier = createTenantVerifier({secret,issuer:"medusa-saas-worker-context",audience:"worker-context",
      lookupMembership:identity=>lookupMembership(identity,{kind:claims.kind})})
    const context = await verifier(
      jwt.sign({ tenant_id: claims.tenant_id }, secret, {
        algorithm: "HS256",
        subject: claims.sub,
        issuer: "medusa-saas-worker-context",
        audience: "worker-context",
        expiresIn: "5m",
      })
    )
    return { context, claims }
  }
  const jobs = {
    handlers,
    async enqueue(
      kind,
      payload,
      { idempotencyKey, delay = 0, blocked = false, groupId = null } = {}
    ) {
      const identity = currentTenant()
      rejectAuthority(payload)
      if (!handlers.has(kind))
        fail("TENANT_JOB_HANDLER_DISABLED", "Job kind is unavailable")
      if (
        typeof idempotencyKey !== "string" ||
        !idempotencyKey ||
        idempotencyKey.length > 256 ||
        !Number.isFinite(delay) ||
        delay < 0 ||
        delay > 86400
      )
        throw new TypeError("A bounded idempotency key and delay are required")
      const data = JSON.stringify(canonical(payload)),
        fingerprint = crypto.createHash("sha256").update(data).digest("hex"),
        id = "job_" + crypto.randomUUID()
      return tenantSQL(pool, async (c) => {
        const inserted = await c.query(
          "INSERT INTO saas_job(id,kind,idempotency_key,fingerprint,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,kind,idempotency_key) DO NOTHING RETURNING *",
          [id, kind, idempotencyKey, fingerprint, data]
        )
        const job =
          inserted.rows[0] ??
          (
            await c.query(
              "SELECT * FROM saas_job WHERE kind=$1 AND idempotency_key=$2",
              [kind, idempotencyKey]
            )
          ).rows[0]
        if (job.fingerprint !== fingerprint)
          fail(
            "TENANT_IDEMPOTENCY_CONFLICT",
            "Idempotency key already has different input"
          )
        if (inserted.rowCount) {
          if(getOperations()) await getOperations().queueAdmission(c,identity,kind)
          const envelope = jwt.sign(
            { tenant_id: identity.tenantId, job_id: id, kind, fingerprint },
            secret,
            {
              algorithm: "HS256",
              subject: identity.actorId,
              issuer: "medusa-saas-dispatch",
              audience: "worker-dispatch",
              expiresIn: "30d",
            }
          )
          await c.query(
            getOperations() ? "INSERT INTO saas_control.task_dispatch(id,tenant_id,envelope,state,available_at,group_id,kind) VALUES($1,$2,$3,$4,now()+$5*interval '1 second',$6,$7)" : "INSERT INTO saas_control.task_dispatch(id,tenant_id,envelope,state,available_at,group_id) VALUES($1,$2,$3,$4,now()+$5*interval '1 second',$6)",
            [
              id,
              identity.tenantId,
              envelope,
              blocked ? "blocked" : "pending",
              delay,
              groupId,
              ...(getOperations() ? [kind] : []),
            ]
          )
        }
        return { id: job.id, state: job.state, result: job.result }
      })
    },
    async retrieve(id) {
      return tenantSQL(
        pool,
        async (c) =>
          (
            await c.query(
              "SELECT id,kind,state,attempts,result,last_error FROM saas_job WHERE id=$1",
              [id]
            )
          ).rows[0]
      )
    },
    async unblock(ids) {
      await tenantSQL(pool, async (c, identity) =>
        c.query(
          "UPDATE saas_control.task_dispatch SET state='pending' WHERE id=ANY($1::text[]) AND tenant_id=$2 AND state='blocked'",
          [ids, identity.tenantId]
        )
      )
    },
    async releaseGroup(groupId) {
      await tenantSQL(pool, async (c, identity) =>
        c.query(
          "UPDATE saas_control.task_dispatch SET state='pending' WHERE group_id=$1 AND tenant_id=$2 AND state='blocked'",
          [groupId, identity.tenantId]
        )
      )
    },
    async cancelGroup(groupId) {
      await tenantSQL(pool, async (c, identity) => {
        const cancelled = await c.query(
          "UPDATE saas_control.task_dispatch SET state='cancelled' WHERE group_id=$1 AND tenant_id=$2 AND state='blocked' RETURNING id",
          [groupId, identity.tenantId]
        )
        await c.query(
          "UPDATE saas_job SET state='cancelled',updated_at=now() WHERE id=ANY($1::text[]) AND state='pending'",
          [cancelled.rows.map((row) => row.id)]
        )
      })
    },
    async cancel(ids) {
      await tenantSQL(pool, async (c, identity) => {
        await c.query(
          "UPDATE saas_control.task_dispatch SET state='cancelled',lease_token=NULL WHERE id=ANY($1::text[]) AND tenant_id=$2 AND state IN ('pending','blocked')",
          [ids, identity.tenantId]
        )
        await c.query(
          "UPDATE saas_job SET state='cancelled',updated_at=now() WHERE id=ANY($1::text[]) AND state='pending'",
          [ids]
        )
      })
    },
    async processNext({
      simulateCrash = false,
      simulateCrashAfterHandler = false,
      jobId = null,
    } = {}) {
      const client = await pool.connect()
      let row
      try {
        await client.query("BEGIN")
        row = getOperations() ? await getOperations().claimDispatch(client,jobId) : (
          await client.query(
            "SELECT * FROM saas_control.task_dispatch WHERE ((state='pending' AND available_at<=now()) OR (state='running' AND lease_until<=now())) AND ($1::text IS NULL OR id=$1) ORDER BY attempts,available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
            [jobId]
          )
        ).rows[0]
        if (!row) {
          await client.query("COMMIT")
          return null
        }
        const lease = crypto.randomUUID()
        await client.query(
          "UPDATE saas_control.task_dispatch SET state='running',lease_token=$2,lease_until=now()+$3*interval '1 second',attempts=attempts+1 WHERE id=$1",
          [row.id, lease, leaseSeconds]
        )
        row = { ...row, lease_token: lease, attempts: row.attempts + 1 }
        await client.query("COMMIT")
      } catch (e) {
        await client.query("ROLLBACK")
        throw e
      } finally {
        client.release()
      }
      if (simulateCrash) return { id: row.id, state: "claimed" }
      let context, result, error, renewal, renewalError
      const heartbeat = setInterval(() => {
        if (renewal || renewalError) return
        renewal = pool
          .query(
            "UPDATE saas_control.task_dispatch SET lease_until=now()+$3*interval '1 second' WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING id",
            [row.id, row.lease_token, leaseSeconds]
          )
          .then((result) => {
            if (!result.rowCount)
              renewalError = new TenantSecurityError(
                "TENANT_JOB_STALE_LEASE",
                "Worker lease has changed"
              )
          })
          .catch((e) => {
            renewalError = e
          })
          .finally(() => {
            renewal = undefined
          })
      }, Math.max(100, Math.floor((leaseSeconds * 1000) / 3)))
      heartbeat.unref()
      try {
        const bound = await contextFor(row)
        context = bound.context
        result = await runWithTenant(context, async () => {
          const job = await tenantSQL(
            pool,
            async (c) =>
              (
                await c.query(
                  "UPDATE saas_job SET state='running',attempts=$2,updated_at=now() WHERE id=$1 RETURNING *",
                  [row.id, row.attempts]
                )
              ).rows[0]
          )
          if (!job) fail("TENANT_JOB_NOT_FOUND", "Persisted job is unavailable")
          if (
            job.kind !== bound.claims.kind ||
            job.fingerprint !== bound.claims.fingerprint ||
            crypto
              .createHash("sha256")
              .update(JSON.stringify(canonical(job.payload)))
              .digest("hex") !== bound.claims.fingerprint
          )
            fail(
              "TENANT_JOB_PAYLOAD_INVALID",
              "Persisted job payload does not match its signed envelope"
            )
          // Resolution occurs only after signed identity and persisted payload
          // verification. It cannot grant authority to an unknown job kind.
          const handler = handlers.get(job.kind) || resolveHandler(job.kind,job.payload)
          if (!handler)
            fail("TENANT_JOB_HANDLER_DISABLED", "Job handler is unavailable")
          rejectAuthority(job.payload)
          return (
            (await handler(job.payload, {
              jobId: job.id,
              idempotencyKey: job.idempotency_key,
              attempt: row.attempts,
            })) ?? null
          )
        })
      } catch (e) {
        error = e
      } finally {
        clearInterval(heartbeat)
        if (renewal) await renewal
      }
      if (renewalError) throw renewalError
      if (simulateCrashAfterHandler && !error)
        return { id: row.id, state: "unacknowledged", result }
      const fatal =
        error instanceof TenantSecurityError ||
        error?.name === "TenantSecurityError" ||
        row.attempts >= maxAttempts
      const finalState = error ? (fatal ? "failed" : "pending") : "done"
      // Fence old workers before acknowledging. Handlers must also use their
      // durable idempotency key because external side effects are at-least-once.
      const acknowledge = async (c) => {
        const updated = await c.query(
          "UPDATE saas_control.task_dispatch SET state=$3,lease_token=NULL,lease_until=NULL,available_at=now()+interval '1 second' WHERE id=$1 AND lease_token=$2 RETURNING id",
          [row.id, row.lease_token, finalState]
        )
        if (!updated.rowCount)
          fail("TENANT_JOB_STALE_LEASE", "Worker lease has changed")
        if (context)
          await c.query(
            "UPDATE saas_job SET state=$2,result=$3,last_error=$4,updated_at=now() WHERE id=$1",
            [
              row.id,
              finalState,
              JSON.stringify(result ?? null),
              error ? String(error.code ?? error.name).slice(0, 128) : null,
            ]
          )
      }
      if (context)
        await runWithTenant(context, () => tenantSQL(pool, acknowledge))
      else if (["TENANT_INITIALIZING","TENANT_PAUSED_JOB"].includes(error?.code)) {
        await pool.query(
          "UPDATE saas_control.task_dispatch SET state='pending',available_at=now()+interval '15 seconds',attempts=attempts-1,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",
          [row.id, row.lease_token]
        )
        return { id: row.id, state: "pending", error: error.code }
      } else
        await pool.query(
          "UPDATE saas_control.task_dispatch SET state='failed',lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",
          [row.id, row.lease_token]
        )
      return {
        id: row.id,
        state: finalState,
        error: error?.code ?? error?.name,
        result,
      }
    },
  }
  const processNext = jobs.processNext.bind(jobs)
  jobs.processNext = async (...args) => {
    const release = getOperations() ? await getOperations().sharedGate({background:true}) : undefined
    try {return await processNext(...args)} finally {if(release)await release()}
  }
  return jobs
}
module.exports = { createTenantJobs, canonical, rejectAuthority }
