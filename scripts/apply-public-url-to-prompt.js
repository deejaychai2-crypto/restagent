#!/usr/bin/env node
/**
 * Rewrites POST lines for get_menu / submit_order in config/vapi-system-prompt.txt
 * from PUBLIC_BASE_URL in .env (single place to update when the tunnel changes).
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const base = String(process.env.PUBLIC_BASE_URL || "")
  .trim()
  .replace(/\/$/, "");
if (!base) {
  console.error("Set PUBLIC_BASE_URL in .env first.");
  process.exit(1);
}

const promptPath = path.join(__dirname, "..", "config", "vapi-system-prompt.txt");
let text = fs.readFileSync(promptPath, "utf8");
text = text.replace(/POST https:\/\/[^\s]+\/tools\/get_menu/gi, `POST ${base}/tools/get_menu`);
text = text.replace(/POST https:\/\/[^\s]+\/tools\/submit_order/gi, `POST ${base}/tools/submit_order`);
fs.writeFileSync(promptPath, text);
console.log("Updated", promptPath);
console.log(`${base}/tools/get_menu`);
console.log(`${base}/tools/submit_order`);
