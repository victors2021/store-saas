"use strict"

const { z } = require("zod")
const { DefaultsUtils, MedusaError } = require("@medusajs/framework/utils")
const multer = require("multer")
const unavailable = () => { throw new MedusaError(MedusaError.Types.NOT_FOUND, "Object is unavailable") }
const themeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  logo: z.string().regex(/^\/store\/media\/file_[a-f0-9]{40}$/).nullable(),
  primary_color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  seo_description: z.string().trim().max(320),
}).strict()

function mountCustomRoutes(web, { nativeApp, m2Runtime, asyncHandler, owner }) {
  const storeService = nativeApp.modules.store
  const getStore = async () => {
    const rows = await storeService.listStores({})
    if (rows.length !== 1) unavailable()
    return rows[0]
  }
  const settings = async () => {
    const row = await getStore(), value = row.metadata?.saas_theme || {}
    return { name: row.name,
      logo: typeof value.logo === "string" && /^\/store\/media\/file_[a-f0-9]{40}$/.test(value.logo) ? value.logo : null,
      primary_color: /^#[a-fA-F0-9]{6}$/.test(value.primary_color || "") ? value.primary_color : "#111827",
      seo_description: typeof value.seo_description === "string" ? value.seo_description.slice(0, 320) : "" }
  }
  web.get("/admin/feature-flags", owner, (req, res) => res.json({ feature_flags: {
    rbac: false, translation: false, view_configurations: false, saas_m3: true } }))
  web.get("/admin/saas/settings", owner, asyncHandler(async (req, res) => res.json({ settings: await settings() })))
  web.post("/admin/saas/settings", owner, asyncHandler(async (req, res) => {
    const value = themeSchema.parse(req.body), store = await getStore()
    if (value.logo) await m2Runtime.resources.file.retrieve(value.logo.split("/").at(-1), { publicOnly: true })
    const { name, ...theme } = value
    await storeService.updateStores(store.id, { name,
      metadata: { ...(store.metadata || {}), saas_theme: theme } })
    res.json({ settings: await settings() })
  }))
  web.get("/store/settings", asyncHandler(async (req, res) => res.json({ settings: await settings() })))
  // Currency names are the frozen native reference dictionary, not mutable
  // tenant business data. The currency module is not loaded or schema-generated.
  web.get("/admin/currencies", owner, asyncHandler(async (req, res) => {
    const query = z.object({ offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(0).max(200).default(200),
      q: z.string().max(100).optional(), code: z.union([z.string(), z.array(z.string())]).optional(),
      fields: z.string().optional(), order: z.string().optional() }).strict().parse(req.query)
    let rows = Object.values(DefaultsUtils.defaultCurrencies).map((row) => ({ ...row, code: row.code.toLowerCase() }))
    if (query.code) rows = rows.filter((row) => (Array.isArray(query.code) ? query.code : [query.code]).includes(row.code))
    if (query.q) rows = rows.filter((row) => `${row.code} ${row.name}`.toLowerCase().includes(query.q.toLowerCase()))
    res.json({ currencies: rows.slice(query.offset, query.offset + query.limit), count: rows.length,
      offset: query.offset, limit: query.limit })
  }))
  for (const [path, module, method, key] of [
    ["/admin/payments/payment-providers", "payment", "listPaymentProviders", "payment_providers"],
    ["/admin/fulfillment-providers", "fulfillment", "listFulfillmentProviders", "fulfillment_providers"],
    ["/admin/tax-providers", "tax", "listTaxProviders", "tax_providers"],
  ]) web.get(path, owner, asyncHandler(async (req, res) => {
    const rows = await nativeApp.modules[module][method]({})
    res.json({ [key]: rows.map((row) => ({ id: row.id, is_enabled: row.is_enabled })), count: rows.length,
      offset: 0, limit: rows.length })
  }))
  web.get("/admin/fulfillment-providers/:id/options", owner, asyncHandler(async (req, res) => {
    if (req.params.id !== "manual_manual") unavailable()
    const options = await nativeApp.modules.fulfillment.retrieveFulfillmentOptions(req.params.id)
    res.json({ fulfillment_options: options, count: options.length, offset: 0, limit: options.length })
  }))
  const upload = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: 5 * 1024 * 1024, files: 5, fields: 0, parts: 5,
  } }).array("files", 5)
  const imageType = (file) => {
    const b = file.buffer
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
    if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg"
    if (b.length >= 12 && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp"
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Only PNG, JPEG and WebP image uploads are available")
  }
  web.post("/admin/uploads", owner, upload, asyncHandler(async (req, res) => {
    if (!req.files?.length || req.files.reduce((total, file) => total + file.size, 0) > 5 * 1024 * 1024)
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Upload up to five images totalling at most 5 MiB")
    const validated = req.files.map((file) => ({ file, mimeType: imageType(file) }))
    const uploaded = []
    try {
      for (const { file, mimeType } of validated) {
        const row = await m2Runtime.resources.file.upload({ filename: file.originalname, mimeType, content: file.buffer, isPublic: true })
        uploaded.push({ id: row.id, url: `/store/media/${row.id}` })
      }
    } catch (error) {
      for (const row of uploaded) await m2Runtime.resources.file.delete(row.id)
      throw error
    }
    res.json({ files: uploaded })
  }))
  web.delete("/admin/uploads/:id", owner, asyncHandler(async (req, res) => {
    await m2Runtime.resources.file.retrieve(req.params.id)
    await m2Runtime.resources.file.delete(req.params.id)
    res.json({ id: req.params.id, object: "file", deleted: true })
  }))
  web.get("/store/media/:id", asyncHandler(async (req, res) => {
    const row = await m2Runtime.resources.file.retrieve(req.params.id, { publicOnly: true })
    if (!["image/png", "image/jpeg", "image/webp"].includes(row.mime_type)) unavailable()
    res.set("Content-Type", row.mime_type)
    res.set("Content-Disposition", "inline")
    res.set("Content-Security-Policy", "default-src 'none'; sandbox")
    res.send(row.content)
  }))
}
module.exports = { mountCustomRoutes, themeSchema }
