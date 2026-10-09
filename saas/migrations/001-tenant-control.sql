-- MIT. Global server-only SaaS control plane. Never register these tables with
-- native Medusa Query/Graph or expose the underlying database pool to clients.
CREATE TABLE saas_control.tenant (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,46}[a-z0-9]$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  owner_actor_id text NOT NULL,
  public_key text NOT NULL UNIQUE,
  request_key text NOT NULL,
  input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed', 'suspended')),
  initialization_version integer NOT NULL DEFAULT 1 CHECK (initialization_version > 0),
  initialization_attempts integer NOT NULL DEFAULT 0 CHECK (initialization_attempts >= 0),
  initialization_token text,
  initialization_lease_until timestamptz,
  initialization_error_code text,
  initialized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_actor_id, request_key)
);

CREATE TABLE saas_control.membership (
  tenant_id text NOT NULL REFERENCES saas_control.tenant(id),
  actor_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_id)
);
CREATE UNIQUE INDEX membership_one_owner ON saas_control.membership (tenant_id) WHERE role = 'owner';

CREATE TABLE saas_control.domain (
  hostname text PRIMARY KEY,
  tenant_id text NOT NULL UNIQUE REFERENCES saas_control.tenant(id),
  kind text NOT NULL DEFAULT 'platform_subdomain' CHECK (kind = 'platform_subdomain'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Offline provisioned operator identities, independent of tenant memberships.
-- The application role receives SELECT only on this table.
CREATE TABLE saas_control.platform_identity (
  actor_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saas_control.audit_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id text NOT NULL,
  tenant_id text REFERENCES saas_control.tenant(id),
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_event_tenant_time ON saas_control.audit_event (tenant_id, created_at DESC);

-- Immutable ownership, idempotency and domain identity survive implementation
-- mistakes in subsequent administrative paths. No owner-transfer feature in M1.
CREATE FUNCTION saas_control.reject_tenant_identity_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.slug, NEW.owner_actor_id, NEW.public_key, NEW.request_key, NEW.input_fingerprint,
      NEW.initialization_version) IS DISTINCT FROM
     (OLD.id, OLD.slug, OLD.owner_actor_id, OLD.public_key, OLD.request_key, OLD.input_fingerprint,
      OLD.initialization_version) THEN
    RAISE EXCEPTION 'Tenant identity and initialization input are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tenant_identity_immutable BEFORE UPDATE ON saas_control.tenant
FOR EACH ROW EXECUTE FUNCTION saas_control.reject_tenant_identity_change();

CREATE FUNCTION saas_control.reject_owner_membership_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'DELETE' AND OLD.role = 'owner') OR
     (TG_OP = 'UPDATE' AND OLD.role = 'owner' AND
      (NEW.tenant_id, NEW.actor_id, NEW.role, NEW.status) IS DISTINCT FROM
      (OLD.tenant_id, OLD.actor_id, OLD.role, OLD.status)) THEN
    RAISE EXCEPTION 'Tenant owner membership is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tenant_owner_immutable BEFORE UPDATE OR DELETE ON saas_control.membership
FOR EACH ROW EXECUTE FUNCTION saas_control.reject_owner_membership_change();
