import { HttpTypes } from "@medusajs/types"
import { listProducts } from "@lib/data/products"
import ProductPreview from "@modules/products/components/product-preview"
import ProductRail from "@modules/home/components/featured-products/product-rail"

export default async function FeaturedProducts({
  collections,
  region,
}: {
  collections: HttpTypes.StoreCollection[]
  region: HttpTypes.StoreRegion
}) {
  if (!collections.length) {
    const { response: { products } } = await listProducts({ regionId: region.id, queryParams: { limit: 6 } })
    return <li className="content-container"><ul className="grid grid-cols-2 small:grid-cols-3 gap-6">
      {products.map((product) => <li key={product.id}><ProductPreview product={product} region={region} isFeatured /></li>)}
    </ul></li>
  }
  return collections.map((collection) => (
    <li key={collection.id}>
      <ProductRail collection={collection} region={region} />
    </li>
  ))
}
