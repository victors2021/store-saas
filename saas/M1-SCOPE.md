# M1 tenant ownership and API scope

Source baseline: Medusa **2.18.0**, commit **`1014c0337027a6087410ad3cc1da9a11fd83ca8d`**, MIT root license. The inventory reads the current working files, including the earlier generic security backports and catalog fixes. Source ownership classification is a design decision, not a statement that every domain already has working isolation. Original `/workspace/medusa` is outside this implementation directory.

Regenerate the machine-readable source inventory from the fork root:

```sh
node saas/inventory-m1.cjs
```

The generator only reads TypeScript/Git metadata and writes `saas/m1-ownership.json`. It does not boot an application, migrate a database or run tests. The TypeScript AST identifies actual exported HTTP methods and actual `model.define` definitions; it does not count commented examples or barrel export files as models.

## Complete native source inventory

At the first M1 scan the native source contains:

| Source class | Count | Meaning |
|---|---:|---|
| `src/models/*.ts` and descendants | 156 | Includes barrel/index files |
| DML model definitions | 129 | Across 27 module namespaces, including the PostgreSQL locking provider |
| Physical module Link definitions | 22 | Have an explicit `databaseConfig.tableName` |
| Read-only Link definitions | 14 | Query aliases; they do not establish authorization |
| Native `route.ts` files | 322 | All route files under `packages/medusa/src/api` |
| Exported HTTP method/path pairs | 479 | Includes Auth, Admin, Store and Cloud routes |
| Business unique declarations | 58 | Explicit unique indexes plus field-level `.unique()`; excludes primary keys |
| Raw SQL / manager / transaction candidate calls | 86 | Static review list, not 86 security findings |

The JSON contains each model's entity name, physical table convention/explicit table name, primary key, relationships, indexes, uniqueness, source hash and migration evidence. It also lists every physical/read-only Link with relationship endpoints, every native route with exported methods and flags, explicit generated-pivot declarations, and SQL call sites. Indexes and fields are direct source declarations; the new `tenantScoped()` annotation is recorded separately because its runtime transformations must be verified against generated metadata and migrations. Historical migration `CREATE TABLE` evidence confirms naming where present; it is not an inventory of the current migrated database. The two workflow-engine implementations both declare `workflow_execution`, without a `src/migrations` table creation found by this scanner. The runtime migration and schema checks remain necessary.

Custom app/plugin routes, dependency-provided framework endpoints, health endpoints and mounted Admin assets are outside this native API enumeration. The runtime policy must cover the complete application mounts and future route additions, rather than treating this inventory as the allowlist itself.

## Ownership rules

| Category | Native domains | Rule |
|---|---|---|
| Tenant control | Auth, User; later API Key, RBAC, Settings | Credentials, memberships and merchant configuration need explicit tenant ownership. A merchant owner is not a global database administrator. |
| Tenant commerce, M1 pilot | Product, Pricing, Customer | All business rows, pivots and relationships belong to one tenant. M1 exposes only explicitly tested native routes. |
| Tenant commerce, M2 | Cart, Order, Payment, Fulfillment, Inventory, Stock Location, Sales Channel, Region, Promotion, Tax, Store, Notification, Translation | Keep HTTP access denied until the domain and its cross-domain relationships have isolation and transaction tests. |
| Shared read-only dictionary | Currency | Currency definitions have no tenant relationship. Public/merchant mutations remain closed. Tenant-specific choices such as `store_currency` remain tenant-owned. |
| Infrastructure requiring tenant envelope | Index, Search, workflow-engine-inmemory, workflow-engine-redis, PostgreSQL locking | Namespace state, cache/index keys and job payloads; revalidate tenant identity when a worker resumes. Not covered by request ALS alone. |
| Provider registry requiring review | Native Payment/Fulfillment/Notification provider registries | Separate process-wide provider capabilities from tenant credentials, enabled configuration and links. No automatic global-data exemption. |

**Country is tenant-owned in this native schema.** `Country` maps to `region_country`, has `iso_2` as its native primary key and has a mutable relationship to a tenant Region. Sharing it as a global country dictionary would let one merchant's region assignment affect another. M2 must deliberately resolve the country key/relationship design; adding RLS alone does not permit repeated ISO primary keys.

Classification marked `reviewed: false` in the JSON remains an explicit unresolved design/review item. It must not be activated because a model was successfully enumerated.

## M1 native entity/table map

| Module | DML entity → table |
|---|---|
| Product | `Product → product`; `ProductVariant → product_variant`; `ProductImage → image`; `ProductVariantProductImage → product_variant_product_image`; `ProductOption → product_option`; `ProductOptionValue → product_option_value`; `ProductProductOption → product_product_option`; `ProductProductOptionValue → product_product_option_value`; `ProductCategory → product_category`; `ProductCollection → product_collection`; `ProductTag → product_tag`; `ProductType → product_type` |
| Pricing | `PriceSet → price_set`; `Price → price`; `PriceRule → price_rule`; `PriceList → price_list`; `PriceListRule → price_list_rule`; `PricePreference → price_preference` |
| Customer | `Customer → customer`; `CustomerAddress → customer_address`; `CustomerGroup → customer_group`; `CustomerGroupCustomer → customer_group_customer` |
| User | `user → user`; `invite → invite` |
| Auth | `auth_identity → auth_identity`; `provider_identity → provider_identity`; `auth_mfa_factor → auth_mfa_factor`; `auth_mfa_recovery_code → auth_mfa_recovery_code`; `auth_verification → auth_verification`; `auth_password_reset_token → auth_password_reset_token` |
| Physical M1 link | `ProductVariantPriceSet → product_variant_price_set`; variant and price-set endpoints must both belong to the link's tenant |

Generated native pivots also need migration/metadata coverage. Product declares `product_tags`, `product_category_product` and `product_variant_option`; explicitly modeled option/image pivots are listed above. Other many-to-many declarations can use implicit/inverse pivot metadata, so the JSON records declared and unresolved pivot names separately. Native Pricing has six DML models and no declared many-to-many pivot in this baseline. Do not treat a successful primary-model DML update as coverage for all generated pivots or all 22 physical module Links. Empty links into inactive M2 domains must be inaccessible rather than trusted because they currently contain no rows.

Native uniqueness to preserve tenant-locally includes Product handle; Product Variant SKU/barcode/EAN/UPC; collection/category handles; option/value identity; price-rule/preference identity; User/Invite email; ProviderIdentity `(entity_id, provider)`; Customer `(email, has_account)`; Customer Group name and address flags. The complete precise index expressions and soft-delete predicates are in the JSON. Product and Pricing alone contain **13** business unique index declarations. Existing random native IDs remain global primary keys where appropriate, with `(tenant_id, id)` available as composite foreign-key targets. Existing non-random primary keys need separate design review.

New platform control-plane `tenant`, `tenant_domain` and `tenant_membership` records are M1 application models, not native Medusa records. Tenant creation must establish a native owner inside a tenant context; membership lookup must use real persisted rows rather than the catalog probe's fixture map. Platform provisioning is narrowly privileged and must not grant tenant HTTP requests a database bypass role. Provisioning should be idempotent and retain a recoverable state when a later step fails.

## HTTP opening policy

The request guard runs **before native API routing**. Unlisted method/path combinations are denied. Native `AUTHENTICATE = false` annotations do not override this guard. A route pattern cannot authorize arbitrary actor types or providers.

The candidate list in the JSON is deliberately only a proposal for the minimal native M1 surface:

| Surface | Candidate methods/paths | Required constraints |
|---|---|---|
| Native login | `POST /auth/:actor_type/:auth_provider` | Tested `user`/`customer` actor types, `emailpass` only, server-resolved tenant |
| Customer identity registration | `POST /auth/customer/emailpass/register` | Scoped identity plus subsequent native customer creation; public owner registration remains closed |
| Session | `POST` / `DELETE /auth/session` | Only if tested with tenant-bound JWT/cookie and native session behavior |
| Merchant self | `GET /admin/users/me` | Active membership, correct native actor ID, tenant-bound session/token |
| Customer account | `POST /store/customers`; `GET` / `POST /store/customers/me` | Customer actor and auth identity must belong to the same shop; creation accepts a registration identity without an existing actor |
| Merchant catalog | `GET` / `POST /admin/products`; `GET` / `POST` / `DELETE /admin/products/:id` | Active merchant role; validated writes; field/relationship restrictions; isolated native workflows |
| Public catalog | `GET /store/products`; `GET /store/products/:id` | Server-resolved active shop; only allowed public fields and active/published product semantics |

The implementation's actual middleware and executed acceptance tests are authoritative. Optional session methods and catalog mutation methods stay closed until their tests pass. Nested product options/variants, price-list APIs and broader customer management are not opened automatically by prefix matching. Native MFA, OAuth callbacks, reset/verification, token refresh, Cloud APIs, user management/invites, RBAC and all M2 transaction routes are closed until explicitly implemented and validated.

Public tenant resolution comes from a trusted platform domain/subdomain lookup, not from a body/header `tenant_id`. A signed tenant-bound token is also checked against the resolved shop and persisted membership/customer identity. Body/query tenant fields and forged relationship targets cannot override the server context. Login/registration must establish context before native Auth repositories run, so the same email can exist in different shops without retrieving or overwriting another shop's provider identity.

Queries need a separate field allowlist. Restrict `fields`, wildcard/expansion syntax and default selections to reviewed M1 relationships; otherwise a permitted Product route can pivot through module Links into unprotected Sales Channel, Inventory, Shipping Profile, Order, Search or other M2 modules. Graph cache/index-engine paths remain disabled until their tenant keying is reviewed. Full native Admin UI navigation is not equivalent to passing the merchant-self/catalog APIs; the closed native sidebar routes require later expansion.

## Raw SQL and transaction review

`rawSqlCandidates` includes calls to `raw`, `execute`, `getKnex`, `getTransactionContext`, `createQueryBuilder` and `createNamedQueryBuilder` in native runtime module source. Transaction-context calls are frequently safeguards, so the list must be read at the call site.

Known M1 concerns are Product repository option/image/deep-update paths and Product module service query helpers; Pricing price calculation and rule-attribute lookup; and Link repositories. Each must use the verified tenant context on its own native transaction manager. Request ALS without transaction-local PostgreSQL settings is insufficient. The existing Pricing fix deliberately uses `manager.getTransactionContext() ?? manager.getKnex()` and no process-global cross-tenant rule-attribute cache. The earlier Product variant image fix preserves `sharedContext` and serializes DTOs before replacing image arrays.

RLS is enforced using a non-superuser/non-`BYPASSRLS` application role, with `FORCE ROW LEVEL SECURITY`; no tenant setting means no tenant business rows. Tenant-local uniqueness, `WITH CHECK`, generated pivots and same-tenant composite foreign keys enforce writes as well as reads. Pool release and reuse must clear transaction-local settings. Schema regeneration/diff, a fresh migration replay and native Link regeneration must retain the protection; the earlier `catalog-schema.cjs` remains a disposable probe, not a production migration.

## M2 domain coverage and independent release gates

| Domain group | Required M2 work |
|---|---|
| Customer extensions / merchant control | Addresses/groups beyond opened M1 routes, invitations, API keys, settings, role/policy review, cross-domain graph restrictions |
| Cart / Order | Line items, adjustments, totals, returns/exchanges/claims, draft orders, customer/product snapshots and links |
| Payment | Collections, sessions, captures/refunds/account holders, provider credentials and replay-safe webhook tenant resolution |
| Inventory / Stock Location / Sales Channel | Reservations, levels, decrement/release, tenant-specific channels and locations, cross-module same-tenant links |
| Fulfillment / Tax / Region / Store | Shipping options/profiles/sets, provider credentials, currency selections, country ownership, tax rules and store settings |
| Promotion / Notification / Translation | Tenant codes and campaigns, templates/recipients/idempotency, locales/translations and graph links |
| Workflows / event bus / cache / locks / files / search | Durable tenant envelopes, retries and compensation, namespaced keys and file paths, worker validation, tenant-scoped indexing |

M1 HTTP acceptance must include two real tenants and persisted memberships, same-email accounts in both shops, correct login/account creation, own-tenant CRUD/list/count, foreign ID and relationship attempts, rejected tenant/token tampering, restricted field expansions, pooled-connection reuse, concurrent alternating reads/writes and unchanged permitted native behavior.

Security and distribution clearance are independent of the ownership inventory. Complete Store field hardening, dependency advisory verification/fixed versions, the full dependency/distribution license/NOTICE review, and MFA/OAuth hardening before enabling those features remain release gates. This document does not declare M0 complete or the complete SaaS MVP production-ready.
