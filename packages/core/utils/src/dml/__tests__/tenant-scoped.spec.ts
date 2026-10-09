import { MetadataStorage } from "@medusajs/deps/mikro-orm/core"
import { CustomTsMigrationGenerator } from "../../dal/mikro-orm/mikro-orm-create-connection"
import { model } from "../entity-builder"
import { mikroORMEntityBuilder } from "../helpers/create-mikro-orm-entity"
import { TENANT_ID_DEFAULT_SQL } from "../tenant-scoped"

describe("native SaaS tenant metadata", () => {
  const priorMode = process.env.MEDUSA_SAAS_MODE

  afterEach(() => {
    if (priorMode === undefined) delete process.env.MEDUSA_SAAS_MODE
    else process.env.MEDUSA_SAAS_MODE = priorMode
    MetadataStorage.clear()
    mikroORMEntityBuilder.clear()
  })

  it("preserves native schemas unless explicitly enabled", () => {
    delete process.env.MEDUSA_SAAS_MODE
    const entity = model
      .define("native_plain", {
        id: model.id().primaryKey(),
        handle: model.text(),
      })
      .tenantScoped()
    expect(entity.parse().schema.tenant_id).toBeUndefined()
  })

  it("has a database tenant default and scopes both field and model uniqueness", () => {
    process.env.MEDUSA_SAAS_MODE = "true"
    const entity = model
      .define("native_scoped", {
        id: model.id().primaryKey(),
        handle: model.text().unique(),
        code: model.text(),
      })
      .indexes([{ on: ["code"], unique: true, where: "deleted_at IS NULL" }])
      .tenantScoped()
    entity.tenantScoped() // Idempotent across native module re-registration.
    const klass = mikroORMEntityBuilder(entity)
    const metadata = MetadataStorage.getMetadataFromDecorator<any>(klass as any)
    expect(metadata.properties.tenant_id).toMatchObject({
      nullable: false,
      defaultRaw: TENANT_ID_DEFAULT_SQL,
    })
    expect(metadata.properties.tenant_id.onCreate).toBeUndefined()
    const sql = metadata.indexes
      .map((index) => index.expression || "")
      .join("\n")
    expect(sql).toMatch(/\("tenant_id", "handle"\)/)
    expect(sql).toMatch(/\("tenant_id", "code"\)/)
    expect(sql).toMatch(/\("tenant_id", "id"\)/)
  })

  it("rejects caller-defined tenant field overrides", () => {
    process.env.MEDUSA_SAAS_MODE = "true"
    expect(() =>
      model
        .define("override", {
          id: model.id().primaryKey(),
          tenant_id: model.text().nullable(),
        })
        .tenantScoped()
    ).toThrow("Cannot override tenant_id")
  })

  it("supports natural tenant primary keys without inventing an id index", () => {
    process.env.MEDUSA_SAAS_MODE = "true"
    const country = model
      .define("scoped_country", {
        iso_2: model.text().primaryKey(),
        name: model.text(),
      })
      .tenantScoped({ primaryKey: true })
    const klass = mikroORMEntityBuilder(country)
    const metadata = MetadataStorage.getMetadataFromDecorator<any>(klass as any)
    expect(metadata.properties.tenant_id).toMatchObject({
      primary: true,
      nullable: false,
      defaultRaw: TENANT_ID_DEFAULT_SQL,
    })
    expect(metadata.properties.iso_2.primary).toBe(true)
    expect(
      country.parse().indexes.some((index) => index.on.includes("id" as any))
    ).toBe(false)
  })

  it("refuses destructive SaaS ORM migrations instead of deleting owned constraints", () => {
    process.env.MEDUSA_SAAS_MODE = "true"
    const prototype = CustomTsMigrationGenerator.prototype
    for (const sql of [
      'alter table "product" drop constraint "saas_fk_example";',
      'alter table "product" drop column "tenant_id";',
      'drop index "IDX_product_handle_unique";',
      'alter table "product" alter column "tenant_id" drop not null;',
    ]) {
      expect(() =>
        prototype.generateMigrationFile.call({} as any, "SaasUnsafe", {
          up: [sql],
          down: [],
        })
      ).toThrow("SaaS destructive schema diff")
    }
  })
})
