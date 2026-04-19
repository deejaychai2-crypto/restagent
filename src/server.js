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

/** Only used by modify_order; submit_order ignores it. merge = keep old items + new; replace = cart is only items in this request. */
const modifyModeSchema = z.enum(["merge", "replace"]).optional();

const removeItemSchema = z
  .object({
    toastGuid: z.string().min(1).optional(),
    menuItemName: z.string().min(1).optional(),
    /** Omit to drop every matching line from the cart for that dish. */
    quantity: z.number().int().positive().optional(),
  })
  .superRefine((item, ctx) => {
    if (!item.toastGuid && !item.menuItemName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each removeItems entry needs toastGuid or menuItemName",
        path: [],
      });
    }
  });

const submitOrderBodySchema = z.object({
  sessionId: z.string().min(1),
  callId: z.string().optional(),
  restaurantId: z.string().min(1),
  guestName: z.string().max(120).optional(),
  guestPhone: z.string().max(40).optional(),
  diningBehavior: diningBehaviorSchema.optional().default("Takeout"),
  // Require offset when provided, so "5 pm" doesn't silently become ASAP fallback.
  scheduledForIso: z.string().datetime({ offset: true }).optional(),
  modifyMode: modifyModeSchema,
});

const submitOrderSchema = submitOrderBodySchema
  .extend({
    items: z.array(orderItemSchema).min(1),
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

/** modify_order: items may be empty if removeItems removes enough to leave a non-empty cart (validated in route). */
const modifyOrderSchema = submitOrderBodySchema
  .extend({
    items: z.array(orderItemSchema).default([]),
    removeItems: z.array(removeItemSchema).optional().default([]),
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
    if (data.items.length === 0 && (!data.removeItems || data.removeItems.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "modify_order needs a non-empty items array and/or removeItems",
        path: ["items"],
      });
    }
  });

/** Flatten common LLM / Vapi shapes so the hub matches what was said on the call. */
function normalizeSubmitOrderBody(body) {
  if (!body || typeof body !== "object") return body;
  const raw = body;
  const next = { ...raw };
  if (!next.items && raw.order && Array.isArray(raw.order.items)) next.items = raw.order.items;

  const callObj = raw.call && typeof raw.call === "object" ? raw.call : null;
  if (!next.callId && callObj?.id) next.callId = String(callObj.id);
  if (!next.sessionId && callObj?.id) next.sessionId = String(callObj.id);
  if (!next.guestPhone && (callObj?.from || callObj?.phoneNumber || callObj?.phone)) {
    next.guestPhone = String(callObj.from || callObj.phoneNumber || callObj.phone);
  }
  if (!next.guestName && callObj?.customer && typeof callObj.customer === "object" && callObj.customer?.name) {
    next.guestName = String(callObj.customer.name);
  }

  const cust = raw.customer && typeof raw.customer === "object" ? raw.customer : null;
  if (!next.guestName && cust?.name) next.guestName = String(cust.name);
  if (!next.guestPhone && (cust?.phone || cust?.phoneNumber)) {
    next.guestPhone = String(cust.phone || cust.phoneNumber);
  }

  if (!next.guestName && raw.customerName) next.guestName = String(raw.customerName);
  if (!next.guestName && raw.pickupName) next.guestName = String(raw.pickupName);
  if (!next.guestName && raw.callerName) next.guestName = String(raw.callerName);
  if (!next.guestName && raw.name) next.guestName = String(raw.name);
  if (!next.guestPhone && raw.customerPhone) next.guestPhone = String(raw.customerPhone);
  if (!next.guestPhone && raw.phone) next.guestPhone = String(raw.phone);
  if (!next.guestPhone && raw.phoneNumber) next.guestPhone = String(raw.phoneNumber);
  if (!next.guestPhone && raw.callerPhone) next.guestPhone = String(raw.callerPhone);
  if (!next.guestPhone && raw.fromNumber) next.guestPhone = String(raw.fromNumber);

  const schedRaw =
    raw.scheduledForIso ||
    raw.scheduledPickupIso ||
    raw.scheduledTime ||
    raw.scheduledPickupTime ||
    raw.pickupTime ||
    raw.pickupAt ||
    raw.pickupTimeIso ||
    raw.pickupDateTime ||
    raw.readyAt ||
    raw.pickupAtIso;
  if (!next.scheduledForIso && schedRaw != null && schedRaw !== "") {
    next.scheduledForIso = typeof schedRaw === "string" ? schedRaw : String(schedRaw);
  }

  const modeRaw = raw.modifyMode ?? raw.modify_order_mode ?? raw.cartMode;
  if (next.modifyMode == null && modeRaw != null && modeRaw !== "") {
    const s = String(modeRaw).trim().toLowerCase();
    if (["replace", "new", "fresh", "only", "replace_cart"].includes(s)) next.modifyMode = "replace";
    if (["merge", "add", "additive", "append"].includes(s)) next.modifyMode = "merge";
  }
  if (next.modifyMode == null && (raw.replaceExistingItems === true || raw.cartReplacement === true)) {
    next.modifyMode = "replace";
  }

  if (!next.removeItems && Array.isArray(raw.removedItems)) next.removeItems = raw.removedItems;
  if (!next.removeItems && Array.isArray(raw.itemsToRemove)) next.removeItems = raw.itemsToRemove;

  return next;
}

/**
 * Voice/tool providers often treat non-2xx HTTP as a generic "technical" failure and never
 * surface the JSON body to the model. Return 200 + success:false so the assistant can read
 * userMessage and details.
 */
function invalidToolPayloadBody(zodError) {
  const issues = zodError?.issues || [];
  const first = issues[0];
  const pathStr = first?.path?.length ? first.path.map(String).join(".") : "request";
  const msg = first?.message || "validation failed";
  let hint =
    "Confirm sessionId, callId, restaurantId, guest name, phone, and each item has toastGuid or menuItemName.";
  const combined = `${pathStr} ${msg}`.toLowerCase();
  if (combined.includes("scheduled") || combined.includes("datetime") || combined.includes("offset")) {
    hint =
      "scheduledForIso must be full ISO-8601 with a real timezone offset (e.g. 2026-04-19T17:00:00-04:00). Omit it only for ASAP pickup.";
  }
  const userMessage = `We could not place that yet: ${pathStr} — ${msg}. ${hint}`.slice(0, 500);
  return { success: false, error: "invalid_payload", details: issues, userMessage };
}

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

function computeOrderTiming(payload) {
  const fulfillmentStatus = initialFulfillmentStatus(payload.scheduledForIso);
  const dueMs =
    fulfillmentStatus === "Scheduled" && payload.scheduledForIso
      ? new Date(payload.scheduledForIso).getTime()
      : Date.now() + QUOTE_MINUTES_TAKEOUT * 60 * 1000;
  const dueAt = Number.isNaN(dueMs) ? null : new Date(dueMs).toISOString();
  return { fulfillmentStatus, dueAt };
}

function appendOrdersHubSnapshot({ payload, resolved, submitted, idempotencyKey }) {
  const orders = loadOrdersHubStore();
  if (orders.some((o) => o.idempotencyKey === idempotencyKey && hubOrderAmendable(o))) return;
  const placedAt = new Date().toISOString();
  const behavior = payload.diningBehavior || "Takeout";
  const { fulfillmentStatus, dueAt } = computeOrderTiming(payload);

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
    scheduledForIso: payload.scheduledForIso && String(payload.scheduledForIso).trim() ? String(payload.scheduledForIso).trim() : null,
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

function mergeOrdersHubFromPayload(orderGuid, idempotencyKey, payload) {
  const orders = loadOrdersHubStore();
  let idx = orderGuid ? orders.findIndex((o) => o.orderGuid === orderGuid) : -1;
  if (idx === -1 && idempotencyKey) {
    idx = orders.findIndex((o) => o.idempotencyKey === idempotencyKey);
  }
  if (idx === -1) {
    logger.debug({ orderGuid, idempotencyKey, hubCount: orders.length }, "orders_hub_merge_miss");
    return;
  }

  const row = { ...orders[idx] };
  const gn = payload.guestName && String(payload.guestName).trim();
  const gp = payload.guestPhone && String(payload.guestPhone).trim();
  if (gn) row.guestName = gn;
  if (gp) row.guestPhone = gp;
  if (payload.callId && String(payload.callId).trim()) row.callId = String(payload.callId).trim();

  const sched = payload.scheduledForIso && String(payload.scheduledForIso).trim();
  if (sched) {
    const t = new Date(sched).getTime();
    if (!Number.isNaN(t)) {
      row.scheduledForIso = sched;
      const { fulfillmentStatus, dueAt } = computeOrderTiming({ ...payload, scheduledForIso: sched });
      row.fulfillmentStatus = fulfillmentStatus;
      if (dueAt) row.dueAt = dueAt;
    }
  }

  orders[idx] = row;
  saveOrdersHubStore(orders);
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

/** Voice/tool payload: no long descriptions (reduces tokens and stops the model from reading blurbs aloud). */
function formatMenuItemForVapi(item) {
  return {
    name: item.name,
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

function hubOrderAmendable(o) {
  return o.fulfillmentStatus !== "Cancelled" && o.fulfillmentStatus !== "Completed";
}

/** Latest open phone order for this session (optionally narrowed by callId or exact orderGuid). */
function findAmendableHubOrder({ sessionId, callId, orderGuid }) {
  const orders = loadOrdersHubStore();
  const candidates = orders.filter((o) => o.sessionId === sessionId && hubOrderAmendable(o));
  if (orderGuid) {
    const row = candidates.find((o) => o.orderGuid === orderGuid);
    if (!row) return null;
    if (callId && row.callId && String(row.callId) !== String(callId)) return null;
    return row;
  }
  if (callId) {
    const matched = candidates.filter((o) => o.callId && String(o.callId) === String(callId));
    if (matched.length === 0) return null;
    matched.sort((a, b) => new Date(b.placedAt).getTime() - new Date(a.placedAt).getTime());
    return matched[0];
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => new Date(b.placedAt).getTime() - new Date(a.placedAt).getTime());
  return candidates[0];
}

function clearIdempotencyEntry(idempotencyKey) {
  if (!idempotencyKey) return;
  if (idempotencyStore[idempotencyKey]) {
    delete idempotencyStore[idempotencyKey];
    saveIdempotencyStore();
  }
}

function patchHubOrderById(hubOrderId, patch) {
  const orders = loadOrdersHubStore();
  const idx = orders.findIndex((o) => o.hubOrderId === hubOrderId);
  if (idx === -1) return false;
  orders[idx] = { ...orders[idx], ...patch };
  saveOrdersHubStore(orders);
  return true;
}

function markHubOrderCancelled(hubOrderId, { reason } = {}) {
  return patchHubOrderById(hubOrderId, {
    fulfillmentStatus: "Cancelled",
    cancelledAt: new Date().toISOString(),
    cancelReason: reason || "",
    unread: false,
  });
}

function normalizeItemKey(item) {
  if (item.toastGuid && String(item.toastGuid).trim()) return `guid:${String(item.toastGuid).trim()}`;
  if (item.menuItemName && String(item.menuItemName).trim()) return `name:${String(item.menuItemName).trim().toLowerCase()}`;
  if (item.name && String(item.name).trim()) return `name:${String(item.name).trim().toLowerCase()}`;
  return `fallback:${crypto.randomUUID()}`;
}

function hubItemsToRequestItems(hubItems) {
  if (!Array.isArray(hubItems)) return [];
  return hubItems
    .map((item) => {
      const quantity = Number(item.quantity || 0);
      const menuItemName = item.name && String(item.name).trim() ? String(item.name).trim() : undefined;
      const toastGuid = item.toastGuid && String(item.toastGuid).trim() ? String(item.toastGuid).trim() : undefined;
      if (quantity <= 0 || (!menuItemName && !toastGuid)) return null;
      return {
        toastGuid,
        menuItemName,
        quantity,
        specialInstructions:
          item.specialInstructions && String(item.specialInstructions).trim()
            ? String(item.specialInstructions).trim()
            : undefined,
      };
    })
    .filter(Boolean);
}

/** modify_order merge mode: keep existing items and add requested items on top (same line merges qty). */
function buildMergedModifyItems(existingItems, requestedItems) {
  const mergedMap = new Map();
  const orderedKeys = [];
  const pushOrMerge = (item) => {
    if (!item) return;
    const key = normalizeItemKey(item);
    const qty = Number(item.quantity || 0);
    if (qty <= 0) return;
    if (!mergedMap.has(key)) {
      mergedMap.set(key, { ...item, quantity: qty });
      orderedKeys.push(key);
      return;
    }
    const prior = mergedMap.get(key);
    mergedMap.set(key, { ...prior, quantity: Number(prior.quantity || 0) + qty });
  };

  for (const item of existingItems) pushOrMerge(item);
  for (const item of requestedItems) pushOrMerge(item);
  return orderedKeys.map((k) => mergedMap.get(k));
}

function resolveRemovalSpecs(removals, menuItems) {
  if (!removals || removals.length === 0) return [];
  return removals.map((r) => {
    const qty = r.quantity;
    if (r.toastGuid && String(r.toastGuid).trim()) {
      return { toastGuid: String(r.toastGuid).trim(), quantity: qty };
    }
    const m = findRequestedMenuItem({ toastGuid: undefined, menuItemName: r.menuItemName }, menuItems);
    if (m) return { toastGuid: m.toastGuid, menuItemName: m.name, quantity: qty };
    return { menuItemName: r.menuItemName && String(r.menuItemName).trim(), quantity: qty };
  });
}

/** Subtract or delete lines; matches toastGuid first, else menuItemName (case-insensitive). */
function applyRemoveItems(cart, removals) {
  if (!removals || removals.length === 0) return cart;
  let lines = cart.map((x) => ({ ...x, quantity: Number(x.quantity || 0) })).filter((x) => x.quantity > 0);
  for (const rem of removals) {
    const guid = rem.toastGuid && String(rem.toastGuid).trim();
    const nameLower = rem.menuItemName && String(rem.menuItemName).trim().toLowerCase();
    const remQty = rem.quantity;
    lines = lines
      .map((line) => {
        const matchGuid = guid && line.toastGuid && String(line.toastGuid).trim() === guid;
        const ln = (line.menuItemName && String(line.menuItemName).trim().toLowerCase()) || "";
        const matchName = nameLower && ln === nameLower;
        if (!matchGuid && !matchName) return line;
        if (remQty == null) return { ...line, quantity: 0 };
        const nextQ = Math.max(0, Number(line.quantity || 0) - remQty);
        return { ...line, quantity: nextQ };
      })
      .filter((line) => line.quantity > 0);
  }
  return lines;
}

/** Toast void requires orders.channel:void scope and OTHER tender on the check; see Toast docs. */
async function voidToastOrder(orderGuid) {
  if (!orderGuid || orderGuid === "unknown") return { ok: true, skipped: true };
  if (ORDER_MODE === "test" || String(orderGuid).startsWith("test-")) {
    return { ok: true, skipped: true };
  }
  try {
    await toastRequest({
      method: "POST",
      url: `${TOAST_BASE_URL}/orders/v2/orders/${orderGuid}/void`,
      data: {
        selections: { voidAll: true },
        payments: { voidAll: true },
      },
    });
    return { ok: true };
  } catch (error) {
    const msg = error.response?.data?.message || error.response?.data?.error || error.message || "void_failed";
    const status = error.response?.status;
    return { ok: false, status, message: String(msg) };
  }
}

async function performCancelOrder(payload) {
  const hubRow = findAmendableHubOrder({
    sessionId: payload.sessionId,
    callId: payload.callId,
    orderGuid: payload.orderGuid,
  });
  if (!hubRow) {
    return { status: 200, json: { success: false, error: "order_not_found" } };
  }
  if (hubRow.fulfillmentStatus === "Cancelled") {
    return {
      status: 200,
      json: { success: true, alreadyCancelled: true, orderGuid: hubRow.orderGuid, hubOrderId: hubRow.hubOrderId },
    };
  }

  const voidResult = await voidToastOrder(hubRow.orderGuid);
  if (!voidResult.ok) {
    return {
      status: 200,
      json: {
        success: false,
        error: "void_failed",
        toastStatus: voidResult.status,
        message: voidResult.message,
        hint:
          "Live Toast voids need OTHER tender on the order and orders.channel:void scope. Staff can void in Toast if this fails.",
      },
    };
  }

  markHubOrderCancelled(hubRow.hubOrderId, { reason: payload.reason || "Customer cancelled" });
  clearIdempotencyEntry(hubRow.idempotencyKey);

  return {
    status: 200,
    json: {
      success: true,
      orderGuid: hubRow.orderGuid,
      hubOrderId: hubRow.hubOrderId,
      idempotencyKey: hubRow.idempotencyKey,
    },
  };
}

async function resolveRequestedItems(payload) {
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
  return { unavailable, resolved };
}

async function performSubmitOrder(payload) {
  if (!isRestaurantOpen()) {
    return {
      status: 200,
      json: {
        success: false,
        error: "restaurant_closed",
        opensAt: BUSINESS_HOURS_OPEN,
        timezone: RESTAURANT_TIMEZONE,
      },
    };
  }

  const idemKey = submissionIdempotencyKey(payload);
  if (idempotencyStore[idemKey]) {
    const prior = idempotencyStore[idemKey];
    mergeOrdersHubFromPayload(prior.orderGuid, idemKey, payload);
    return {
      status: 200,
      json: {
        success: true,
        duplicate: true,
        orderGuid: prior.orderGuid,
        idempotencyKey: idemKey,
      },
    };
  }

  try {
    const { unavailable, resolved } = await resolveRequestedItems(payload);
    if (unavailable.length > 0) {
      return {
        status: 200,
        json: {
          success: false,
          error: "items_unavailable",
          unavailable,
          available: resolved.map((x) => x.menuItemName),
        },
      };
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

    return {
      status: 200,
      json: {
        success: true,
        duplicate: false,
        orderGuid: submitted.guid,
        idempotencyKey: idemKey,
        mode: submitted.mode,
        hubOrderId,
      },
    };
  } catch (error) {
    logger.error({ error }, "Failed to submit order");
    return {
      status: 503,
      json: {
        success: false,
        error: "submission_failed",
        retryable: true,
        userMessage: "Sorry, we could not place your order right now. Please try again.",
      },
    };
  }
}

app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>RestVagent</title>
  <style>
    :root {
      color-scheme: dark;
      --bg-1: #0b1020;
      --bg-2: #131c33;
      --card: #131a2a;
      --card-border: #28324c;
      --text: #e8edff;
      --muted: #a7b2d3;
      --brand: #5ea6ff;
      --brand-2: #79f0ff;
      --ok: #1dd1a1;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      color: var(--text);
      background: radial-gradient(1200px 600px at 10% -10%, #2a3a68 0%, var(--bg-1) 42%) no-repeat, var(--bg-1);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      width: min(860px, 100%);
      border: 1px solid var(--card-border);
      background: linear-gradient(180deg, rgba(19,26,42,0.92), rgba(19,26,42,0.86));
      backdrop-filter: blur(6px);
      border-radius: 20px;
      padding: 28px;
      box-shadow: 0 24px 70px rgba(0,0,0,0.35);
    }
    .eyebrow {
      display: inline-block;
      font-size: 12px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--brand-2);
      background: rgba(94,166,255,0.12);
      border: 1px solid rgba(94,166,255,0.35);
      border-radius: 999px;
      padding: 6px 10px;
      margin-bottom: 12px;
    }
    h1 {
      margin: 0;
      font-size: clamp(30px, 4vw, 44px);
      line-height: 1.08;
      letter-spacing: -0.02em;
    }
    p {
      margin: 12px 0 0;
      color: var(--muted);
      max-width: 70ch;
      line-height: 1.55;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 22px;
    }
    .btn {
      appearance: none;
      border: 1px solid transparent;
      border-radius: 12px;
      padding: 11px 16px;
      font-weight: 700;
      font-size: 14px;
      text-decoration: none;
      transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
    }
    .btn:hover { transform: translateY(-1px); }
    .btn-primary {
      color: #04152f;
      background: linear-gradient(135deg, var(--brand-2), var(--brand));
      box-shadow: 0 10px 24px rgba(94,166,255,0.36);
    }
    .btn-secondary {
      color: var(--text);
      border-color: var(--card-border);
      background: rgba(26,34,54,0.75);
    }
    .meta {
      margin-top: 20px;
      border-top: 1px solid var(--card-border);
      padding-top: 14px;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 12px;
      color: var(--muted);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--ok);
      display: inline-block;
      margin-right: 6px;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: rgba(94,166,255,0.12);
      border: 1px solid rgba(94,166,255,0.24);
      border-radius: 6px;
      padding: 1px 6px;
      color: #cde3ff;
    }
  </style>
</head>
<body>
  <main class="card">
    <span class="eyebrow">Voice Ordering + Toast Mirror</span>
    <h1>RestVagent Demo Console</h1>
    <p>Orders API and dashboard are running in one process. Use Orders Hub for your live demo view and call-level verification.</p>
    <div class="actions">
      <a class="btn btn-primary" href="/orders-hub/">Open Orders Hub</a>
      <a class="btn btn-secondary" href="/health/ready">Health Check</a>
    </div>
    <p>If the hub asks for auth, paste your API key in the hub header. For local-only bypass, set <code>ORDERS_HUB_ALLOW_NO_AUTH=true</code>.</p>
    <div class="meta">
      <span><span class="dot"></span>Service online</span>
      <span>Default quote from <code>QUOTE_MINUTES_TAKEOUT</code></span>
      <span>Base URL from <code>PUBLIC_BASE_URL</code></span>
    </div>
  </main>
</body>
</html>`);
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

const hubStatusSchema = z.enum(["Needs Approval", "Scheduled", "Active", "Order Ready", "Completed", "Cancelled"]);

const cancelOrderSchema = z.object({
  sessionId: z.string().min(1),
  callId: z.string().optional(),
  restaurantId: z.string().min(1),
  orderGuid: z.string().optional(),
  reason: z.string().max(240).optional(),
});

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
  if (!parsed.success) return res.status(200).json(invalidToolPayloadBody(parsed.error));

  const { nowIso } = parsed.data;
  if (!isRestaurantOpen(nowIso)) {
    return res.json({ success: false, error: "restaurant_closed", opensAt: BUSINESS_HOURS_OPEN, timezone: RESTAURANT_TIMEZONE });
  }

  try {
    const menu = await fetchMenu({ forceFresh: false });
    const filtered = filterAvailableItems(menu, nowIso);
    const categories = groupMenuForVapi(filtered.available);
    return res.json({
      success: true,
      menu: { categories },
      unavailable: buildUnavailableSuggestions(filtered.unavailable, filtered.available),
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    req.log.error({ error }, "Failed to fetch menu");
    return res.status(503).json({ success: false, error: "menu_unavailable" });
  }
});

app.post("/tools/submit_order", async (req, res) => {
  if (!withAuth(req, res)) return;
  const parsed = submitOrderSchema.safeParse(normalizeSubmitOrderBody(req.body));
  if (!parsed.success) {
    return res.status(200).json(invalidToolPayloadBody(parsed.error));
  }
  const out = await performSubmitOrder(parsed.data);
  return res.status(out.status).json(out.json);
});

app.post("/tools/cancel_order", async (req, res) => {
  if (!withAuth(req, res)) return;
  const parsed = cancelOrderSchema.safeParse(normalizeSubmitOrderBody(req.body));
  if (!parsed.success) {
    return res.status(200).json(invalidToolPayloadBody(parsed.error));
  }
  const out = await performCancelOrder(parsed.data);
  return res.status(out.status).json(out.json);
});

app.post("/tools/modify_order", async (req, res) => {
  if (!withAuth(req, res)) return;
  const parsed = modifyOrderSchema.safeParse(normalizeSubmitOrderBody(req.body));
  if (!parsed.success) {
    return res.status(200).json(invalidToolPayloadBody(parsed.error));
  }
  const payload = parsed.data;
  const hubRow = findAmendableHubOrder({
    sessionId: payload.sessionId,
    callId: payload.callId,
    orderGuid: undefined,
  });
  if (!hubRow) {
    return res.json({
      success: false,
      error: "no_active_order_to_replace",
      hint: "Nothing to replace for this session/call — use submit_order for a first order.",
    });
  }

  const modifyMode = payload.modifyMode === "replace" ? "replace" : "merge";
  const existingReqItems = hubItemsToRequestItems(hubRow.items);
  const nextItems =
    modifyMode === "replace" ? payload.items : buildMergedModifyItems(existingReqItems, payload.items);

  let menuForRemovals = [];
  try {
    menuForRemovals = await fetchMenu({ forceFresh: true });
  } catch (error) {
    req.log.error({ error }, "Failed to load menu for modify_order removals");
    return res.status(503).json({
      success: false,
      error: "submission_failed",
      retryable: true,
      userMessage: "Sorry, we could not update the order right now. Please try again.",
    });
  }
  const resolvedRemovals = resolveRemovalSpecs(payload.removeItems || [], menuForRemovals);
  const afterRemovals = applyRemoveItems(nextItems, resolvedRemovals);

  if (afterRemovals.length === 0) {
    return res.json({
      success: false,
      error: "empty_cart_after_modification",
      hint: "After removals the cart would be empty. Use cancel_order instead, or keep at least one item.",
    });
  }

  const { modifyMode: _omitModifyMode, removeItems: _omitRemoveItems, ...payloadForSubmit } = payload;
  const carriedSchedule =
    payload.scheduledForIso && String(payload.scheduledForIso).trim()
      ? String(payload.scheduledForIso).trim()
      : hubRow.scheduledForIso && String(hubRow.scheduledForIso).trim()
        ? String(hubRow.scheduledForIso).trim()
        : undefined;
  const mergedPayload = {
    ...payloadForSubmit,
    items: afterRemovals,
    ...(carriedSchedule ? { scheduledForIso: carriedSchedule } : {}),
  };

  // Validate/resolve replacement first so we never cancel an order unless the new one is placeable.
  let preflight;
  try {
    preflight = await resolveRequestedItems(mergedPayload);
  } catch (error) {
    req.log.error({ error }, "Failed preflight for modify_order");
    return res.status(503).json({
      success: false,
      error: "submission_failed",
      retryable: true,
      userMessage: "Sorry, we could not validate the updated order right now. Please try again.",
    });
  }
  if (preflight.unavailable.length > 0) {
    return res.json({
      success: false,
      error: "items_unavailable",
      unavailable: preflight.unavailable,
      available: preflight.resolved.map((x) => x.menuItemName),
    });
  }

  const cancelOut = await performCancelOrder({
    sessionId: payload.sessionId,
    callId: payload.callId,
    restaurantId: payload.restaurantId,
    orderGuid: hubRow.orderGuid,
    reason: "Customer changed the order",
  });
  if (!cancelOut.json.success) {
    return res.status(cancelOut.status).json(cancelOut.json);
  }

  const submitOut = await performSubmitOrder(mergedPayload);
  if (submitOut.json.success && submitOut.json.hubOrderId) {
    patchHubOrderById(hubRow.hubOrderId, { replacedByHubOrderId: submitOut.json.hubOrderId });
  }
  return res.status(submitOut.status).json({
    ...submitOut.json,
    modifyMode,
    removeItemsApplied: resolvedRemovals.length > 0 ? resolvedRemovals : undefined,
    replacedPreviousHubOrderId: hubRow.hubOrderId,
    replacedPreviousOrderGuid: hubRow.orderGuid,
  });
});

async function processSubmitOrder(req, res, payload) {
  const out = await performSubmitOrder(payload);
  return res.status(out.status).json(out.json);
}

app.post("/webhooks/vapi/order", async (req, res) => {
  // Backward-compatible alias to submit_order with a default session.
  if (!withAuth(req, res)) return;
  const raw = normalizeSubmitOrderBody(req.body);
  const payload = {
    sessionId: raw.sessionId || raw.callId || `legacy_${Date.now()}`,
    callId: raw.callId,
    restaurantId: raw.restaurantId,
    items: raw.items || raw.order?.items,
    guestName: raw.guestName,
    guestPhone: raw.guestPhone,
    diningBehavior: raw.diningBehavior,
    scheduledForIso: raw.scheduledForIso,
  };
  const parsed = submitOrderSchema.safeParse(payload);
  if (!parsed.success) {
    return res.status(200).json(invalidToolPayloadBody(parsed.error));
  }
  return processSubmitOrder(req, res, parsed.data);
});

function start() {
  const baseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  const srv = app.listen(PORT, HOST, () => {
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
  srv.on("error", (err) => {
    logger.fatal({ err, port: PORT, host: HOST }, "server_listen_failed");
    process.exit(1);
  });
  return srv;
}

if (require.main === module) start();

module.exports = { app, start, isRestaurantOpen, filterAvailableItems };
