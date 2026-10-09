"use strict"
process.env.SAAS_ENABLE_PAYMENTS = "true"
process.env.SAAS_RUN_WORKER = process.env.SAAS_RUN_WORKER || "true"
require("./start-m3.cjs")
