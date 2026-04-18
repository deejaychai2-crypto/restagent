#!/usr/bin/env node
/**
 * Prints full tool URLs from PUBLIC_BASE_URL in .env — paste into Vapi tool server URLs.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const base = String(process.env.PUBLIC_BASE_URL || "")
  .trim()
  .replace(/\/$/, "");
if (!base) {
  console.error("Set PUBLIC_BASE_URL in .env (e.g. https://your-host.trycloudflare.com)");
  process.exit(1);
}
console.log("Use these in Vapi (POST, header x-api-key):");
console.log("");
console.log("get_menu:    ", `${base}/tools/get_menu`);
console.log("submit_order:", `${base}/tools/submit_order`);
