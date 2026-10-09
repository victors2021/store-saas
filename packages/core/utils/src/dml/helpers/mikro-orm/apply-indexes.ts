import {
  EntityConstructor,
  EntityIndex,
  PropertyMetadata,
} from "@medusajs/types"
import { createPsqlIndexStatementHelper } from "../../../common"
import { validateIndexFields } from "../mikro-orm/build-indexes"
import { MetadataStorage } from "@medusajs/deps/mikro-orm/core"

/**
 * Creates indexes for a given field
 */
export function applyIndexes(
  MikroORMEntity: EntityConstructor<any>,
  tableName: string,
  field: PropertyMetadata
) {
  const tenantScoped = !!MetadataStorage.getMetadataFromDecorator<any>(
    MikroORMEntity
  ).properties.tenant_id
  field.indexes.forEach((index) => {
    const providerEntityIdIndexStatement = createPsqlIndexStatementHelper({
      name: index.name,
      tableName,
      columns:
        tenantScoped && index.type === "unique"
          ? ["tenant_id", field.fieldName]
          : [field.fieldName],
      unique: index.type === "unique",
      where: "deleted_at IS NULL",
    })

    providerEntityIdIndexStatement.MikroORMIndex()(MikroORMEntity)
  })
}

/**
 * Creates indexes for a MikroORM entity
 *
 * Default Indexes:
 *  - Foreign key indexes will be applied to all manyToOne relationships.
 */
export function applyEntityIndexes(
  MikroORMEntity: EntityConstructor<any>,
  tableName: string,
  entityIndexes: EntityIndex[] = []
) {
  const indexes = [...entityIndexes]
  const tenantScoped = !!MetadataStorage.getMetadataFromDecorator<any>(
    MikroORMEntity
  ).properties.tenant_id

  indexes.forEach((index) => {
    validateIndexFields(MikroORMEntity, index)

    const entityIndexStatement = createPsqlIndexStatementHelper({
      tableName,
      name: index.name,
      columns:
        tenantScoped && index.unique && !index.on.includes("tenant_id")
          ? ["tenant_id", ...(index.on as string[])]
          : (index.on as string[]),
      unique: index.unique,
      where: index.where,
      type: index.type,
    })

    entityIndexStatement.MikroORMIndex()(MikroORMEntity)
  })
}
