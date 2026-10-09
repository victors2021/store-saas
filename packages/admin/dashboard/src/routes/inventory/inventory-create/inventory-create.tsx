import { RouteFocusModal } from "../../../components/modals"
import { useStockLocations } from "../../../hooks/api"
import { InventoryCreateForm } from "./components/inventory-create-form"

export function InventoryCreate() {
  const { isPending, stock_locations, isError, error } = useStockLocations({
    limit: __SAAS_MODE__ ? 1000 : 9999,
    fields: "id,name",
  })
  const ready = !isPending && !!stock_locations

  if (isError) {
    throw error
  }

  return (
    <RouteFocusModal>
      {ready && <InventoryCreateForm locations={stock_locations} />}
    </RouteFocusModal>
  )
}
