const API_KEY_STORAGE = "restvagent_orders_hub_api_key";

const STATUSES = ["Active", "Scheduled", "Order Ready", "Completed", "Needs Approval", "Cancelled"];

let state = {
  orders: [],
  quoteMinutes: 20,
  timezone: "America/New_York",
  tab: "Active",
  search: "",
  selectedId: null,
};

function getApiKey() {
  return sessionStorage.getItem(API_KEY_STORAGE) || "";
}

function apiHeaders() {
  const key = getApiKey();
  const h = { Accept: "application/json" };
  if (key) h["x-api-key"] = key;
  return h;
}

/** Render free tier returns plain "Not Found" when the dyno is asleep (no JSON body). */
async function parseJsonResponse(res, label) {
  if (res.status === 401) throw new Error("unauthorized");
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const text = (await res.text()).trim();
    if (res.status === 404 && (!text || text === "Not Found")) {
      throw new Error(
        "Server is waking up (Render free tier sleeps when idle). Wait 30–60 seconds, then click Refresh.",
      );
    }
    throw new Error(text || `HTTP ${res.status} (${label})`);
  }
  const data = await res.json();
  return data;
}

async function fetchOrders() {
  const res = await fetch("/internal/orders-hub/orders", { headers: apiHeaders() });
  const data = await parseJsonResponse(res, "orders");
  if (!data.success) throw new Error(data.error || "fetch_failed");
  return data;
}

async function patchOrder(hubOrderId, body) {
  const res = await fetch(`/internal/orders-hub/orders/${encodeURIComponent(hubOrderId)}`, {
    method: "PATCH",
    headers: { ...apiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await parseJsonResponse(res, "patch");
  if (!data.success) throw new Error(data.error || "patch_failed");
  return data.order;
}

function firingClassAndText(dueAtIso) {
  if (!dueAtIso) return { className: "grey", text: "Due time —" };
  const due = new Date(dueAtIso).getTime();
  const now = Date.now();
  const sec = Math.round((due - now) / 1000);
  if (sec > 3600) {
    const d = new Date(dueAtIso);
    return { className: "grey", text: `Due ${d.toLocaleString()}` };
  }
  if (sec > 60) return { className: "green", text: `Due in ${Math.ceil(sec / 60)} min` };
  if (sec > 0) return { className: "green", text: "Due in under 1 min" };
  if (sec >= -60) return { className: "green", text: "Due any moment" };
  return { className: "red", text: `Due ${Math.ceil(sec / 60)} min ago` };
}

function countByTab(orders) {
  const c = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let unreadActive = 0;
  for (const o of orders) {
    if (c[o.fulfillmentStatus] !== undefined) c[o.fulfillmentStatus] += 1;
    if (o.fulfillmentStatus === "Active" && o.unread) unreadActive += 1;
  }
  return { c, unreadActive };
}

function matchesSearch(o, q) {
  if (!q.trim()) return true;
  const s = q.toLowerCase();
  return (
    String(o.checkNumber).includes(s) ||
    (o.guestName && o.guestName.toLowerCase().includes(s)) ||
    (o.guestPhone && o.guestPhone.toLowerCase().includes(s)) ||
    (o.orderGuid && o.orderGuid.toLowerCase().includes(s)) ||
    (o.callId && o.callId.toLowerCase().includes(s))
  );
}

function currentVisibleOrders() {
  return state.orders.filter((o) => o.fulfillmentStatus === state.tab && matchesSearch(o, state.search));
}

function syncSelectionToVisibleOrders() {
  const visible = currentVisibleOrders();
  if (visible.length === 0) {
    state.selectedId = null;
    return;
  }
  const stillVisible = visible.some((o) => o.hubOrderId === state.selectedId);
  if (!stillVisible) state.selectedId = visible[0].hubOrderId;
}

function renderTabs() {
  const { c, unreadActive } = countByTab(state.orders);
  const el = document.getElementById("tabBar");
  el.innerHTML = STATUSES.map((status) => {
    const selected = state.tab === status ? 'aria-selected="true"' : 'aria-selected="false"';
    const dot = status === "Active" && unreadActive > 0 ? '<span class="dot" aria-hidden="true"></span>' : "";
    return `<button type="button" class="tab" role="tab" ${selected} data-tab="${status}">${dot}${status}<span class="count">(${c[status]})</span></button>`;
  }).join("");

  el.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.getAttribute("data-tab");
      state.selectedId = null;
      render();
    });
  });
}

function renderList() {
  const list = document.getElementById("orderList");
  const filtered = currentVisibleOrders();

  if (filtered.length === 0) {
    list.innerHTML = `<p class="empty-detail">No orders in <strong>${state.tab}</strong> for this filter.</p>`;
    return;
  }

  list.innerHTML = filtered
    .map((o) => {
      const firing = firingClassAndText(o.dueAt);
      const selected = o.hubOrderId === state.selectedId ? "selected" : "";
      return `
      <button type="button" class="order-card ${selected}" data-id="${o.hubOrderId}" data-unread="${Boolean(o.unread)}">
        <span class="unread-dot" aria-hidden="true"></span>
        <div class="card-main">
          <div class="title-row">
            <h2>${escapeHtml(o.guestName)}</h2>
            <div class="badges">
              <span class="badge channel">${escapeHtml(o.channel)}</span>
              ${o.fulfillmentStatus === "Cancelled" ? '<span class="badge not-paid">Cancelled</span>' : ""}
              ${o.paid ? '<span class="badge paid">Paid</span>' : o.fulfillmentStatus !== "Cancelled" ? '<span class="badge not-paid">Not paid</span>' : ""}
            </div>
          </div>
          <div class="meta-line"><strong>${escapeHtml(o.diningOptionLabel)}</strong> · ${escapeHtml(o.guestPhone)}</div>
          <div class="meta-line">${o.items.length} item(s) · placed ${formatTime(o.placedAt)}</div>
        </div>
        <div class="card-side">
          <div class="check-num">#${o.checkNumber}</div>
          <div class="firing ${firing.className}">${escapeHtml(firing.text)}</div>
        </div>
      </button>`;
    })
    .join("");

  list.querySelectorAll(".order-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedId = card.getAttribute("data-id");
      const order = state.orders.find((x) => x.hubOrderId === state.selectedId);
      if (order && order.unread) {
        patchOrder(order.hubOrderId, { unread: false })
          .then((updated) => {
            const idx = state.orders.findIndex((x) => x.hubOrderId === updated.hubOrderId);
            if (idx !== -1) state.orders[idx] = updated;
            render();
          })
          .catch(() => {
            render();
          });
      } else {
        render();
      }
    });
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function renderDetail() {
  const panel = document.getElementById("detailPanel");
  const order = state.orders.find((x) => x.hubOrderId === state.selectedId);
  if (!order) {
    panel.innerHTML = '<p class="empty-detail">Select an order to see guest, items, and actions.</p>';
    return;
  }

  const firing = firingClassAndText(order.dueAt);
  const itemsHtml = order.items
    .map(
      (it) => `
    <li><span class="qty">${it.quantity}×</span>${escapeHtml(it.name)}
      ${it.specialInstructions ? `<div style="color:var(--muted);font-size:0.8rem;margin-top:0.2rem">${escapeHtml(it.specialInstructions)}</div>` : ""}
    </li>`,
    )
    .join("");

  panel.innerHTML = `
    <div class="detail-head">
      <h2>${escapeHtml(order.guestName)}</h2>
      <div class="badges">
        <span class="badge channel">${escapeHtml(order.channel)}</span>
        ${order.fulfillmentStatus === "Cancelled" ? '<span class="badge not-paid">Cancelled</span>' : order.paid ? '<span class="badge paid">Paid</span>' : '<span class="badge not-paid">Not paid</span>'}
      </div>
    </div>
    <dl class="detail-grid">
      <dt>Check</dt><dd>#${order.checkNumber}</dd>
      <dt>Phone</dt><dd>${escapeHtml(order.guestPhone)}</dd>
      <dt>Dining</dt><dd>${escapeHtml(order.diningOptionLabel)} (${escapeHtml(order.diningBehavior)})</dd>
      <dt>Due / quote</dt><dd class="firing ${firing.className}">${escapeHtml(firing.text)}</dd>
      ${
        order.scheduledForIso
          ? `<dt>Scheduled pickup (ISO)</dt><dd style="word-break:break-all;font-size:0.78rem">${escapeHtml(order.scheduledForIso)}</dd>`
          : ""
      }
      <dt>Placed</dt><dd>${formatTime(order.placedAt)}</dd>
      <dt>Order GUID</dt><dd style="word-break:break-all;font-size:0.78rem">${escapeHtml(order.orderGuid)}</dd>
      <dt>Call / session</dt><dd style="word-break:break-all;font-size:0.78rem">${escapeHtml(order.callId || "—")} / ${escapeHtml(order.sessionId)}</dd>
      <dt>Mode</dt><dd>${escapeHtml(order.mode)}</dd>
      ${
        order.fulfillmentStatus === "Cancelled" && order.cancelledAt
          ? `<dt>Cancelled</dt><dd>${formatTime(order.cancelledAt)}${order.cancelReason ? ` · ${escapeHtml(order.cancelReason)}` : ""}</dd>`
          : ""
      }
      ${
        order.replacedByHubOrderId
          ? `<dt>Replaced by</dt><dd style="word-break:break-all;font-size:0.78rem">Hub ${escapeHtml(order.replacedByHubOrderId)}</dd>`
          : ""
      }
    </dl>
    <h3 style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);margin:0.5rem 0 0">Items</h3>
    <ul class="item-rows">${itemsHtml}</ul>
    <div class="actions">
      ${order.fulfillmentStatus === "Active" ? `<button type="button" class="btn primary" data-action="ready">Order ready</button>` : ""}
      ${order.fulfillmentStatus === "Order Ready" && order.paid ? `<button type="button" class="btn primary" data-action="complete">Complete</button>` : ""}
      ${order.fulfillmentStatus === "Order Ready" && !order.paid ? `<button type="button" class="btn secondary" data-action="pay">Mark paid (demo)</button>` : ""}
      ${order.fulfillmentStatus === "Completed" ? `<button type="button" class="btn secondary" data-action="reopen">Reopen to Active</button>` : ""}
    </div>
  `;

  panel.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const action = e.currentTarget.getAttribute("data-action");
      runAction(order, action);
    });
  });
}

async function runAction(order, action) {
  try {
    if (action === "ready") {
      await patchOrder(order.hubOrderId, { fulfillmentStatus: "Order Ready", unread: false });
    } else if (action === "complete") {
      await patchOrder(order.hubOrderId, { fulfillmentStatus: "Completed" });
    } else if (action === "pay") {
      await patchOrder(order.hubOrderId, { paid: true });
    } else if (action === "reopen") {
      await patchOrder(order.hubOrderId, { fulfillmentStatus: "Active" });
    }
    await load();
  } catch (err) {
    alert(err.message || String(err));
  }
}

function render() {
  document.getElementById("quoteLabel").textContent = `${state.quoteMinutes} min`;
  syncSelectionToVisibleOrders();
  renderTabs();
  renderList();
  renderDetail();
  document.querySelectorAll(".order-card").forEach((c) => {
    if (c.getAttribute("data-id") === state.selectedId) c.classList.add("selected");
  });
}

async function load() {
  const hint = document.getElementById("authHint");
  try {
    const data = await fetchOrders();
    state.orders = data.orders || [];
    state.quoteMinutes = data.quoteMinutesTakeout ?? 20;
    state.timezone = data.timezone || state.timezone;
    hint.textContent = getApiKey()
      ? "Loaded orders (session API key)."
      : "Loaded orders (no browser key — server may allow unauthenticated hub reads).";
  } catch (e) {
    state.orders = [];
    if (e.message === "unauthorized") {
      hint.innerHTML =
        "Could not load orders (401). Click <strong>API key</strong> and paste the same value as <code>WEBHOOK_API_KEY</code> in your <code>.env</code>, or set <code>ORDERS_HUB_ALLOW_NO_AUTH=true</code> for local-only.";
      try {
        document.getElementById("settingsDialog").showModal();
      } catch (_ignored) {
        /* dialog unsupported or blocked */
      }
    } else {
      hint.textContent = e.message || "Could not load orders.";
    }
    console.error(e);
  } finally {
    render();
  }
}

document.getElementById("btnRefresh").addEventListener("click", () => load());
document.getElementById("searchInput").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderList();
  renderDetail();
});

document.getElementById("btnSettings").addEventListener("click", () => {
  document.getElementById("apiKeyInput").value = getApiKey();
  document.getElementById("settingsDialog").showModal();
});

document.getElementById("btnSaveKey").addEventListener("click", () => {
  const v = document.getElementById("apiKeyInput").value.trim();
  if (v) sessionStorage.setItem(API_KEY_STORAGE, v);
  else sessionStorage.removeItem(API_KEY_STORAGE);
  document.getElementById("settingsDialog").close();
  load();
});

document.getElementById("btnCancelKey").addEventListener("click", () => {
  document.getElementById("settingsDialog").close();
});

load();
setInterval(load, 8000);
