import inject from "@medusajs/admin-vite-plugin"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import inspect from "vite-plugin-inspect"

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())

  const BASE = env.VITE_MEDUSA_BASE || "/"
  const SAAS_MODE = env.VITE_MEDUSA_SAAS_MODE === "true" || process.env.VITE_MEDUSA_SAAS_MODE === "true"
  const BACKEND_URL = env.VITE_MEDUSA_BACKEND_URL || (SAAS_MODE ? "/" : "http://localhost:9000")
  const STOREFRONT_URL =
    env.VITE_MEDUSA_STOREFRONT_URL || (SAAS_MODE ? "/" : "http://localhost:8000")

  /**
   * Add this to your .env file to specify the project to load admin extensions from.
   */
  const MEDUSA_PROJECT = env.VITE_MEDUSA_PROJECT || null
  const sources = MEDUSA_PROJECT ? [`${MEDUSA_PROJECT}/src/admin`] : []

  return {
    base: BASE.endsWith("/") ? BASE : `${BASE}/`,
    plugins: [
      inspect(),
      react(),
      inject({
        sources,
      }),
    ],
    define: {
      __BASE__: JSON.stringify(BASE),
      __BACKEND_URL__: JSON.stringify(BACKEND_URL),
      __STOREFRONT_URL__: JSON.stringify(STOREFRONT_URL),
      __AUTH_TYPE__: JSON.stringify("session"),
      __JWT_TOKEN_STORAGE_KEY__: "undefined",
      __MAX_UPLOAD_FILE_SIZE__: JSON.stringify(5 * 1024 * 1024),
      __SAAS_MODE__: JSON.stringify(SAAS_MODE),
    },
    server: {
      open: true,
    },
  }
})
