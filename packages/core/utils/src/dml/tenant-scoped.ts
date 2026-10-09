import { TextProperty } from "./properties/text"

/** No fallback owner: a missing verified transaction context evaluates to NULL. */
export const TENANT_ID_DEFAULT_SQL =
  "NULLIF(current_setting('app.tenant_id'::text, true), ''::text)"

export function isSaasMode(): boolean {
  return process.env.MEDUSA_SAAS_MODE === "true"
}

const TenantIdPropertyMarker = Symbol.for("medusaTenantIdProperty")

/** Internal property. HTTP DTOs must never accept this value from a caller. */
export class TenantIdProperty extends TextProperty {
  [TenantIdPropertyMarker] = true

  static isTenantIdProperty(property: unknown): boolean {
    return (
      !!property?.[TenantIdPropertyMarker] ||
      !!(property as any)?.schema?.[TenantIdPropertyMarker]
    )
  }
}
