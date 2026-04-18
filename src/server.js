const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const dotenv = require("dotenv");
const axios = require("axios");
const pino = require("pino");
const pinoHttp = require("pino-http");
const { z } = require("zod");

dotenv.config();

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => req.headers["x-request-id"] || crypto.randomUUID(),
  }),
);

const TOAST_BASE_URL = process.env.TOAST_BASE_URL || "https://ws-sandbox-api.eng.toasttab.com";
const ORDER_MODE = process.env.ORDER_MODE || "test";
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY || "";
const MENU_CACHE_TTL_MS = Number(process.env.MENU_CACHE_TTL_MS || 60_000);
const RESTAURANT_TIMEZONE = process.env.RESTAURANT_TIMEZONE || "America/New_York";
const BUSINESS_HOURS_OPEN = process.env.BUSINESS_HOURS_OPEN || "11:00";
const BUSINESS_HOURS_CLOSE = process.env.BUSINESS_HOURS_CLOSE || "23:00";

const requiredWhenLive = ["TOAST_CLIENT_ID", "TOAST_CLIENT_SECRET", "TOAST_RESTAURANT_GUID"];
if (ORDER_MODE === "live") {
  for (const key of requiredWhenLive) {
    if (!process.env[key]) throw new Error(`Missing required env var in live mode: ${key}`);
  }
}

const menuPath = path.join(__dirname, "..", "data", "menu.test.json");
const idempotencyPath = path.join(__dirname, "..", "data", "idempotency-store.json");
const ordersHubPath = path.join(__dirname, "..", "data", "orders-hub-store.json");
const menuCache = { items: [], expiresAt: 0 };
let toastTokenCache = { token: null, expiresAt: 0 };
const idempotencyStore = loadIdempotencyStore(idempotencyPath);
const ORDERS_HUB_API_KEY = process.env.ORDERS_HUB_API_KEY || "";
const ORDERS_HUB_ALLOW_NO_AUTH =
  process.env.ORDERS_HUB_ALLOW_NO_AUTH === "1" ||
  String(process.env.ORDERS_HUB_ALLOW_NO_AUTH || "").toLowerCase() === "true";
const QUOTE_MINUTES_TAKEOUT = Number(process.env.QUOTE_MINUTES_TAKEOUT || 20);
const ORDERS_HUB_MAX = Number(process.env.ORDERS_HUB_MAX || 200);

const orderItemSchema = z.object({
  toastGuid: z.string().min(1).optional(),
  menuItemName: z.string().min(1).optional(),
  quantity: z.number().int().positive().default(1),
  modifiers: z.array(z.string()).optional(),
  specialInstructions: z.string().max(300).optional(),
});

const getMenuSchema = z.object({
  restaurantId: z.string().min(1),
  nowIso: z.string().optional(),
});

const diningBehaviorSchema = z.enum(["Takeout", "Delivery", "Curbside"]);

const submitOrderSchema = z
  .object({
    sessionId: z.string().min(1),
    callId: z.string().optional(),
    restaurantId: z.string().min(1),
    items: z.array(orderItemSchema).min(1),
    guestName: z.string().max(120).optional(),
    guestPhone: z.string().max(40).optional(),
    diningBehavior: diningBehaviorSchema.optional().default("Takeout"),
    scheduledForIso: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    data.items.forEach((item, idx) => {
      if (!item.toastGuid && !item.menuItemName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each item needs toastGuid or menuItemName",
          path: ["items", idx],
        });
      }
    });
  });

function withAuth(req, res) {
  if (!WEBHOOK_API_KEY) return true;
  if (req.header("x-api-key") === WEBHOOK_API_KEY) return true;
  res.status(401).json({ success: false, error: "Unauthorized webhook" });
  return false;
}

function ordersHubAuthKey() {
  return ORDERS_HUB_API_KEY || WEBHOOK_API_KEY || "";
}

function withOrdersHubAuth(req, res) {
  if (ORDERS_HUB_ALLOW_NO_AUTH) return true;
  const expected = ordersHubAuthKey();
  if (!expected) return true;
  const provided = req.header("x-api-key") || String(req.query.apiKey || "");
  if (provided === expected) return true;
  res.status(401).json({ success: false, error: "Unauthorized" });
  return false;
}

function loadOrdersHubStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(ordersHubPath, "utf8"));
    return Array.isArray(raw.orders) ? raw.orders : [];
  } catch (_error) {
    return [];
  }
}

function saveOrdersHubStore(orders) {
  const trimmed = orders.slice(-ORDERS_HUB_MAX);
  fs.writeFileSync(ordersHubPath, JSON.stringify({ orders: trimmed }, null, 2));
}

function nextCheckNumber(orders) {
  let max = 999;
  for (const o of orders) {
    const n = Number(o.checkNumber);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

function diningOptionLabel(behavior) {
  const map = {
    Takeout: "Phone order — Takeout",
    Delivery: "Phone order — Delivery",
    Curbside: "Phone order — Curbside",
  };
  return map[behavior] || "Phone order — Takeout";
}

function initialFulfillmentStatus(scheduledForIso) {
  if (!scheduledForIso) return "Active";
  const t = new Date(scheduledForIso).getTime();
  if (Number.isNaN(t)) return "Active";
  return t > Date.now() + 60 * 1000 ? "Scheduled" : "Active";
}

function appendOrdersHubSnapshot({ payload, resolved, submitted, idempotencyKey }) {
  const orders = loadOrdersHubStore();
  if (orders.some((o) => o.idempotencyKey === idempotencyKey)) return;
  const placedAt = new Date().toISOString();
  const behavior = payload.diningBehavior || "Takeout";
  const fulfillmentStatus = initialFulfillmentStatus(payload.scheduledForIso);
  const dueMs =
    fulfillmentStatus === "Scheduled" && payload.scheduledForIso
      ? new Date(payload.scheduledForIso).getTime()
      : Date.now() + QUOTE_MINUTES_TAKEOUT * 60 * 1000;
  const dueAt = Number.isNaN(dueMs) ? null : new Date(dueMs).toISOString();

  const row = {
    hubOrderId: crypto.randomUUID(),
    idempotencyKey,
    orderGuid: submitted.guid,
    placedAt,
    dueAt,
    sessionId: payload.sessionId,
    callId: payload.callId || null,
    restaurantId: payload.restaurantId,
    channel: "AI Phone",
    diningBehavior: behavior,
    diningOptionLabel: diningOptionLabel(behavior),
    guestName: (payload.guestName && payload.guestName.trim()) || "Guest",
    guestPhone: (payload.guestPhone && payload.guestPhone.trim()) || "—",
    checkNumber: nextCheckNumber(orders),
    paid: false,
    fulfillmentStatus,
    items: resolved.map((r) => ({
      name: r.menuItemName,
      quantity: r.quantity,
      specialInstructions: r.specialInstructions || "",
      toastGuid: r.toastGuid,
    })),
    unread: true,
    mode: submitted.mode,
  };
  orders.push(row);
  saveOrdersHubStore(orders);
  return row.hubOrderId;
}

function loadIdempotencyStore(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return {};
  }
}

function saveIdempotencyStore() {
  fs.writeFileSync(idempotencyPath, JSON.stringify(idempotencyStore, null, 2));
}

function nowInRestaurant(nowIso) {
  const date = nowIso ? new Date(nowIso) : new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    timeZone: RESTAURANT_TIMEZONE,
  }).formatToParts(date);
  const hh = Number(parts.find((p) => p.type === "hour")?.value || "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value || "0");
  return hh * 60 + mm;
}

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function isRestaurantOpen(nowIso) {
  const nowMins = nowInRestaurant(nowIso);
  const openMins = hhmmToMinutes(BUSINESS_HOURS_OPEN);
  const closeMins = hhmmToMinutes(BUSINESS_HOURS_CLOSE);
  return nowMins >= openMins && nowMins < closeMins;
}

function isWithinSchedule(item, nowIso) {
  if (!item.schedule || !item.schedule.start || !item.schedule.end) return true;
  const nowMins = nowInRestaurant(nowIso);
  const start = hhmmToMinutes(item.schedule.start);
  const end = hhmmToMinutes(item.schedule.end);
  return nowMins >= start && nowMins <= end;
}

function normalizeTestMenu(raw) {
  return (raw.items || []).map((item) => ({
    name: item.name,
    category: item.category || "Uncategorized",
    description: item.description || "",
    toastGuid: item.toastGuid,
    price: Number(item.price || 0),
    outOfStock: Boolean(item.outOfStock),
    schedule: item.schedule || null,
    alternatives: item.alternatives || [],
  }));
}

function normalizeToastMenu(rawMenu) {
  const directItems = rawMenu?.items || [];
  if (directItems.length > 0) return normalizeTestMenu(rawMenu);
  return [];
}

async function getToastToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && toastTokenCache.token && now < toastTokenCache.expiresAt) {
    return toastTokenCache.token;
  }

  const response = await axios.post(
    `${TOAST_BASE_URL}/authentication/v1/authentication/login`,
    {
      clientId: process.env.TOAST_CLIENT_ID,
      clientSecret: process.env.TOAST_CLIENT_SECRET,
      userAccessType: "TOAST_MACHINE_CLIENT",
    },
    { timeout: 15000 },
  );

  const token = response.data?.token?.accessToken;
  if (!token) throw new Error("toast_auth_failed");
  toastTokenCache = { token, expiresAt: now + 50 * 60 * 1000 };
  return token;
}

async function toastRequest(config, { retryAuth = true } = {}) {
  const token = await getToastToken(false);
  try {
    return await axios({
      ...config,
      timeout: config.timeout || 15000,
      headers: {
        ...(config.headers || {}),
        Authorization: `Bearer ${token}`,
        "Toast-Restaurant-External-ID": process.env.TOAST_RESTAURANT_GUID,
      },
    });
  } catch (error) {
    if (retryAuth && error.response?.status === 401) {
      await getToastToken(true);
      return toastRequest(config, { retryAuth: false });
    }
    throw error;
  }
}

async function fetchMenu({ forceFresh = false } = {}) {
  if (!forceFresh && Date.now() < menuCache.expiresAt && menuCache.items.length > 0) {
    return menuCache.items;
  }

  let items = [];
  if (ORDER_MODE === "test") {
    const raw = JSON.parse(fs.readFileSync(menuPath, "utf8"));
    items = normalizeTestMenu(raw);
  } else {
    const response = await toastRequest({ method: "GET", url: `${TOAST_BASE_URL}/menus/v2/menus` });
    items = normalizeToastMenu(response.data);
  }

  menuCache.items = items;
  menuCache.expiresAt = Date.now() + MENU_CACHE_TTL_MS;
  return items;
}

function filterAvailableItems(items, nowIso) {
  const unavailable = [];
  const available = [];
  for (const item of items) {
    if (item.outOfStock) {
      unavailable.push({ name: item.name, reason: "out_of_stock", alternatives: item.alternatives || [] });
      continue;
    }
    if (!isWithinSchedule(item, nowIso)) {
      unavailable.push({ name: item.name, reason: "outside_schedule", alternatives: item.alternatives || [] });
      continue;
    }
    available.push(item);
  }
  return { available, unavailable };
}

function formatMenuItemForVapi(item) {
  return {
    name: item.name,
    category: item.category || "Uncategorized",
    description: item.description || "",
    price: item.price,
    toastGuid: item.toastGuid,
  };
}

function groupMenuForVapi(items) {
  const categories = {};
  for (const item of items) {
    const category = item.category || "Uncategorized";
    if (!categories[category]) {
      categories[category] = [];
    }
    categories[category].push(formatMenuItemForVapi(item));
  }

  return Object.entries(categories).map(([name, categoryItems]) => ({
    name,
    items: categoryItems.sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

function buildUnavailableSuggestions(unavailable, availableItems) {
  return unavailable.map((entry) => {
    const suggested = (entry.alternatives || [])
      .map((name) => availableItems.find((item) => item.name === name))
      .filter(Boolean)
      .map((item) => item.name);

    return {
      name: entry.name,
      reason: entry.reason,
      suggestedAlternatives: suggested,
    };
  });
}

function findRequestedMenuItem(input, menuItems) {
  if (input.toastGuid) return menuItems.find((m) => m.toastGuid === input.toastGuid) || null;
  if (input.menuItemName) {
    return menuItems.find((m) => m.name.toLowerCase() === input.menuItemName.trim().toLowerCase()) || null;
  }
  return null;
}

function buildToastOrder(items) {
  return {
    entityType: "Order",
    checks: [
      {
        entityType: "Check",
        selections: items.map((item) => ({
          entityType: "MenuItemSelection",
          item: { guid: item.toastGuid },
          quantity: item.quantity,
          specialInstructions: item.specialInstructions || "",
        })),
      },
    ],
  };
}

function submissionIdempotencyKey(payload) {
  if (payload.callId) return payload.callId;
  return `${payload.sessionId}_${crypto.createHash("sha1").update(JSON.stringify(payload.items)).digest("hex")}`;
}

async function submitOrderWithRetry(orderPayload, idempotencyKey) {
  if (ORDER_MODE === "test") {
    return { guid: `test-${crypto.randomUUID()}`, mode: "test", idempotencyKey };
  }

  const headers = { "Idempotency-Key": idempotencyKey, "Content-Type": "application/json" };
  try {
    const response = await toastRequest({
      method: "POST",
      url: `${TOAST_BASE_URL}/orders/v2/orders`,
      headers,
      data: orderPayload,
    });
    return { guid: response.data?.guid || "unknown", mode: "live", idempotencyKey };
  } catch (error) {
    const retryable = !error.response || error.response.status >= 500 || error.response.status === 429;
    if (!retryable) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await toastRequest({
      method: "POST",
      url: `${TOAST_BASE_URL}/orders/v2/orders`,
      headers,
      data: orderPayload,
    });
    return { guid: response.data?.guid || "unknown", mode: "live", idempotencyKey };
  }
}

app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>RestVagent</title></head>
<body style="font-family:system-ui;max-width:42rem;margin:2rem">
  <h1>RestVagent</h1>
  <p>API + Orders Hub run in the same process.</p>
  <ul>
    <li><a href="/orders-hub/">Orders Hub (dashboard)</a></li>
    <li><a href="/health/ready">Health</a></li>
  </ul>
  <p style="color:#555;font-size:0.9rem">If the hub shows empty tabs, set <code>ORDERS_HUB_ALLOW_NO_AUTH=true</code> in <code>.env</code> for local use, or open <strong>API key</strong> on the hub and paste <code>WEBHOOK_API_KEY</code>.</p>
</body></html>`);
});

app.get("/health/live", (_req, res) => res.json({ ok: true }));
app.get("/health/ready", (_req, res) =>
  res.json({
    ok: true,
    mode: ORDER_MODE,
    menuCacheItems: menuCache.items.length,
    businessHours: { open: BUSINESS_HOURS_OPEN, close: BUSINESS_HOURS_CLOSE, timezone: RESTAURANT_TIMEZONE },
  }),
);

const ordersHubDir = path.resolve(__dirname, "..", "public", "orders-hub");
const ordersHubIndex = path.join(ordersHubDir, "index.html");

function serveOrdersHubIndex(_req, res) {
  if (!fs.existsSync(ordersHubIndex)) {
    return res.status(503).type("text/plain").send("Orders Hub UI is missing: add public/orders-hub/index.html next to this server.");
  }
  return res.sendFile(ordersHubIndex);
}

// Do not redirect /orders-hub -> /orders-hub/; Express often matches both paths to the same
// handler and a redirect loop causes ERR_TOO_MANY_REDIRECTS in the browser.
app.get("/orders-hub/", serveOrdersHubIndex);
app.get("/orders-hub", serveOrdersHubIndex);
app.use("/orders-hub", express.static(ordersHubDir, { index: false }));

const hubStatusSchema = z.enum(["Needs Approval", "Scheduled", "Active", "Order Ready", "Completed"]);

app.get("/internal/orders-hub/orders", (req, res) => {
  if (!withOrdersHubAuth(req, res)) return;
  const orders = loadOrdersHubStore();
  return res.json({
    success: true,
    quoteMinutesTakeout: QUOTE_MINUTES_TAKEOUT,
    timezone: RESTAURANT_TIMEZONE,
    orders: orders.slice().reverse(),
  });
});

app.patch("/internal/orders-hub/orders/:hubOrderId", (req, res) => {
  if (!withOrdersHubAuth(req, res)) return;
  const hubOrderId = req.params.hubOrderId;
  const bodySchema = z.object({
    fulfillmentStatus: hubStatusSchema.optional(),
    unread: z.boolean().optional(),
    paid: z.boolean().optional(),
  });
  const parsed = bodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: "invalid_payload", details: parsed.error.issues });
  }
  const orders = loadOrdersHubStore();
  const idx = orders.findIndex((o) => o.hubOrderId === hubOrderId);
  if (idx === -1) return res.status(404).json({ success: false, error: "not_found" });
  const next = { ...orders[idx] };
  if (parsed.data.fulfillmentStatus !== undefined) next.fulfillmentStatus = parsed.data.fulfillmentStatus;
  if (parsed.data.unread !== undefined) next.unread = parsed.data.unread;
  if (parsed.data.paid !== undefined) next.paid = parsed.data.paid;
  orders[idx] = next;
  saveOrdersHubStore(orders);
  return res.json({ success: true, order: next });
});

app.post("/tools/get_menu", async (req, res) => {
  if (!withAuth(req, res)) return;
  const parsed = getMenuSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: "invalid_payload", details: parsed.error.issues });

  const { nowIso } = parsed.data;
  if (!isRestaurantOpen(nowIso)) {
    return res.json({ success: false, error: "restaurant_closed", opensAt: BUSINESS_HOURS_OPEN, timezone: RESTAURANT_TIMEZONE });
  }

  try {
    const menu = await fetchMenu({ forceFresh: false });
    const filtered = filterAvailableItems(menu, nowIso);
    const categories = groupMenuForVapi(filtered.available);
    const flatMenu = categories.flatMap((category) => category.items);
    return res.json({
      success: true,
      menu: {
        categories,
        items: flatMenu,
      },
      unavailable: buildUnavailableSuggestions(filtered.unavailable, filtered.available),
      guidance: {
        speakOnlyFromAvailableMenu: true,
        confirmUnavailableItemsAreNotOffered: true,
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    req.log.error({ error }, "Failed to fetch menu");
    return res.status(503).json({ success: false, error: "menu_unavailable" });
  }
});

app.post("/tools/submit_order", async (req, res) => {
  if (!withAuth(req, res)) return;
  const parsed = submitOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: "invalid_payload", details: parsed.error.issues });
  }
  const payload = parsed.data;
  return processSubmitOrder(req, res, payload);
});

async function processSubmitOrder(req, res, payload) {

  if (!isRestaurantOpen()) {
    return res.json({ success: false, error: "restaurant_closed", opensAt: BUSINESS_HOURS_OPEN, timezone: RESTAURANT_TIMEZONE });
  }

  const idemKey = submissionIdempotencyKey(payload);
  if (idempotencyStore[idemKey]) {
    return res.json({
      success: true,
      duplicate: true,
      orderGuid: idempotencyStore[idemKey].orderGuid,
      idempotencyKey: idemKey,
    });
  }

  try {
    const freshMenu = await fetchMenu({ forceFresh: true });
    const filtered = filterAvailableItems(freshMenu);
    const unavailable = [];
    const resolved = [];
    for (const reqItem of payload.items) {
      const match = findRequestedMenuItem(reqItem, filtered.available);
      if (!match) {
        unavailable.push(reqItem.menuItemName || reqItem.toastGuid || "unknown_item");
      } else {
        resolved.push({ ...reqItem, toastGuid: match.toastGuid, menuItemName: match.name });
      }
    }

    if (unavailable.length > 0) {
      return res.json({
        success: false,
        error: "items_unavailable",
        unavailable,
        available: resolved.map((x) => x.menuItemName),
      });
    }

    const toastOrder = buildToastOrder(resolved);
    const submitted = await submitOrderWithRetry(toastOrder, idemKey);
    idempotencyStore[idemKey] = {
      createdAt: Date.now(),
      orderGuid: submitted.guid,
      sessionId: payload.sessionId,
    };
    saveIdempotencyStore();
    const hubOrderId = appendOrdersHubSnapshot({
      payload,
      resolved,
      submitted,
      idempotencyKey: idemKey,
    });

    return res.json({
      success: true,
      duplicate: false,
      orderGuid: submitted.guid,
      idempotencyKey: idemKey,
      mode: submitted.mode,
      hubOrderId,
    });
  } catch (error) {
    req.log.error({ error }, "Failed to submit order");
    return res.status(503).json({
      success: false,
      error: "submission_failed",
      retryable: true,
      userMessage: "Sorry, we could not place your order right now. Please try again.",
    });
  }
}

app.post("/webhooks/vapi/order", async (req, res) => {
  // Backward-compatible alias to submit_order with a default session.
  if (!withAuth(req, res)) return;
  const payload = {
    sessionId: req.body.sessionId || req.body.callId || `legacy_${Date.now()}`,
    callId: req.body.callId,
    restaurantId: req.body.restaurantId,
    items: req.body.items || req.body.order?.items,
    guestName: req.body.guestName,
    guestPhone: req.body.guestPhone,
    diningBehavior: req.body.diningBehavior,
    scheduledForIso: req.body.scheduledForIso,
  };
  const parsed = submitOrderSchema.safeParse(payload);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: "invalid_payload", details: parsed.error.issues });
  }
  return processSubmitOrder(req, res, parsed.data);
});

function start() {
  const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  return app.listen(PORT, HOST, () => {
    logger.info(
      {
        host: HOST,
        port: PORT,
        mode: ORDER_MODE,
        home: `${baseUrl.replace(/\/$/, "")}/`,
        ordersHubUi: `${baseUrl.replace(/\/$/, "")}/orders-hub/`,
        ordersHubAuthBypass: ORDERS_HUB_ALLOW_NO_AUTH,
      },
      "Voice agent backend started",
    );
  });
}

if (require.main === module) start();

module.exports = { app, start, isRestaurantOpen, filterAvailableItems };
