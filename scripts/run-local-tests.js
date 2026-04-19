const axios = require("axios");

// Avoid port 3000 collisions with a dev server: load `src/server.js` with a free PORT unless BASE_URL is set.
if (!process.env.BASE_URL) {
  process.env.PORT = String(18000 + Math.floor(Math.random() * 15000));
}
const { start } = require("../src/server");

const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT}`;
const apiKey = process.env.WEBHOOK_API_KEY || "";

const headers = apiKey ? { "x-api-key": apiKey } : {};

const cases = [
  {
    name: "get-menu-happy-path",
    method: "post",
    path: "/tools/get_menu",
    payload: {
      restaurantId: "rest_001",
      nowIso: "2026-04-14T17:00:00-04:00",
    },
    expectStatus: 200,
    expectSuccess: true,
  },
  {
    name: "estimate-cart-subtotal",
    method: "post",
    path: "/tools/estimate_cart",
    payload: {
      restaurantId: "rest_001",
      items: [
        { menuItemName: "Chicken Dum Biryani", quantity: 1 },
        { menuItemName: "Samosa", quantity: 2 },
      ],
    },
    expectStatus: 200,
    expectSuccess: true,
    expectSubtotal: 17 + 7.99 * 2,
  },
  {
    name: "estimate-cart-unknown-item",
    method: "post",
    path: "/tools/estimate_cart",
    payload: {
      restaurantId: "rest_001",
      items: [{ menuItemName: "Dragon Pizza", quantity: 1 }],
    },
    expectStatus: 200,
    expectSuccess: false,
    expectError: "items_unavailable",
  },
  {
    name: "restaurant-closed",
    method: "post",
    path: "/tools/get_menu",
    payload: {
      restaurantId: "rest_001",
      nowIso: "2026-04-14T02:00:00-04:00",
    },
    expectStatus: 200,
    expectSuccess: false,
    expectError: "restaurant_closed",
  },
  {
    name: "submit-order-happy-path",
    method: "post",
    path: "/tools/submit_order",
    payload: {
      sessionId: "sess-suite-001",
      callId: "call-suite-001",
      restaurantId: "rest_001",
      items: [
        { menuItemName: "Chicken Dum Biryani", quantity: 1 },
        { menuItemName: "Garlic Naan", quantity: 2, specialInstructions: "extra butter" },
      ],
    },
    expectStatus: 200,
    expectSuccess: true,
  },
  {
    name: "duplicate-call-id",
    method: "post",
    path: "/tools/submit_order",
    payload: {
      sessionId: "sess-suite-001",
      callId: "call-suite-001",
      restaurantId: "rest_001",
      items: [{ menuItemName: "Chicken Dum Biryani", quantity: 1 }],
    },
    expectStatus: 200,
    expectDuplicate: true,
  },
  {
    name: "unknown-menu-item-unavailable",
    method: "post",
    path: "/tools/submit_order",
    payload: {
      sessionId: "sess-suite-003",
      callId: "call-suite-003",
      restaurantId: "rest_001",
      items: [{ menuItemName: "Dragon Pizza", quantity: 1 }],
    },
    expectStatus: 200,
    expectSuccess: false,
    expectError: "items_unavailable",
  },
  {
    name: "invalid-payload-fails",
    method: "post",
    path: "/tools/submit_order",
    payload: { restaurantId: "rest_001", items: [] },
    expectStatus: 200,
    expectSuccess: false,
    expectError: "invalid_payload",
  },
  {
    name: "submit-order-asap-empty-scheduledForIso",
    method: "post",
    path: "/tools/submit_order",
    payload: {
      sessionId: "sess-asap-empty-sched",
      callId: "call-asap-empty-sched",
      restaurantId: "rest_001",
      scheduledForIso: "",
      items: [{ menuItemName: "Samosa", quantity: 1 }],
    },
    expectStatus: 200,
    expectSuccess: true,
  },
  {
    name: "cancel-order-not-found",
    method: "post",
    path: "/tools/cancel_order",
    payload: {
      sessionId: "sess-no-such-order",
      callId: "call-no-such-order",
      restaurantId: "rest_001",
    },
    expectStatus: 200,
    expectSuccess: false,
    expectError: "order_not_found",
  },
];

async function runCase(testCase) {
  try {
    const response = await axios({
      method: testCase.method || "post",
      url: `${baseUrl}${testCase.path || "/webhooks/vapi/order"}`,
      data: testCase.payload,
      headers,
      timeout: 10000,
      validateStatus: () => true,
    });

    const statusOk = response.status === testCase.expectStatus;
    const successOk =
      typeof testCase.expectSuccess === "boolean"
        ? response.data.success === testCase.expectSuccess
        : true;
    const duplicateOk =
      typeof testCase.expectDuplicate === "boolean"
        ? response.data.duplicate === testCase.expectDuplicate
        : true;
    const errorOk =
      typeof testCase.expectError === "string" ? response.data.error === testCase.expectError : true;
    const subtotalOk =
      typeof testCase.expectSubtotal === "number"
        ? response.data.success === true && Math.abs(Number(response.data.subtotal) - testCase.expectSubtotal) < 0.02
        : true;

    const pass = statusOk && successOk && duplicateOk && errorOk && subtotalOk;
    return {
      name: testCase.name,
      pass,
      status: response.status,
      data: response.data,
    };
  } catch (error) {
    return {
      name: testCase.name,
      pass: false,
      status: "network-error",
      data: { message: error.message },
    };
  }
}

async function main() {
  const server = start();
  const results = [];
  for (const testCase of cases) {
    results.push(await runCase(testCase));
  }

  // cancel_order (after submit) + modify_order (replace items, same callId)
  try {
    const cancelCall = `call-cancel-${Date.now()}`;
    const sub1 = await axios.post(
      `${baseUrl}/tools/submit_order`,
      {
        sessionId: "sess-cancel-flow",
        callId: cancelCall,
        restaurantId: "rest_001",
        items: [{ menuItemName: "Garlic Naan", quantity: 1 }],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const cancelRes = await axios.post(
      `${baseUrl}/tools/cancel_order`,
      {
        sessionId: "sess-cancel-flow",
        callId: cancelCall,
        restaurantId: "rest_001",
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const hubAfterCancel = await axios.get(`${baseUrl}/internal/orders-hub/orders`, { headers, timeout: 10000, validateStatus: () => true });
    const rowCancel = (hubAfterCancel.data?.orders || []).find((o) => o.callId === cancelCall);

    const modCall = `call-modify-${Date.now()}`;
    const subM = await axios.post(
      `${baseUrl}/tools/submit_order`,
      {
        sessionId: "sess-mod-flow",
        callId: modCall,
        restaurantId: "rest_001",
        items: [{ menuItemName: "Garlic Naan", quantity: 1 }],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const modRes = await axios.post(
      `${baseUrl}/tools/modify_order`,
      {
        sessionId: "sess-mod-flow",
        callId: modCall,
        restaurantId: "rest_001",
        items: [{ menuItemName: "Chicken Dum Biryani", quantity: 1 }],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const hubAfterMod = await axios.get(`${baseUrl}/internal/orders-hub/orders`, { headers, timeout: 10000, validateStatus: () => true });
    const rowsMod = (hubAfterMod.data?.orders || []).filter((o) => o.callId === modCall);
    const oldRow = rowsMod.find((o) => o.fulfillmentStatus === "Cancelled");
    const newRow = rowsMod.find((o) => o.fulfillmentStatus === "Active");

    const cancelFlowOk =
      sub1.status === 200 &&
      sub1.data.success === true &&
      cancelRes.status === 200 &&
      cancelRes.data.success === true &&
      rowCancel &&
      rowCancel.fulfillmentStatus === "Cancelled";
    results.push({
      name: "cancel-order-after-submit",
      pass: cancelFlowOk,
      status: cancelFlowOk ? 200 : "assert",
      data: cancelFlowOk ? {} : { sub1: sub1.data, cancelRes: cancelRes.data, rowCancel },
    });

    const modifyFlowOk =
      subM.status === 200 &&
      subM.data.success === true &&
      modRes.status === 200 &&
      modRes.data.success === true &&
      oldRow &&
      newRow &&
      newRow.items.some((it) => it.name === "Chicken Dum Biryani") &&
      oldRow.replacedByHubOrderId === newRow.hubOrderId;
    results.push({
      name: "modify-order-replaces-items",
      pass: modifyFlowOk,
      status: modifyFlowOk ? 200 : "assert",
      data: modifyFlowOk ? {} : { subM: subM.data, modRes: modRes.data, rowsMod },
    });

    // merge + removeItems: drop a line the guest said they do not want (must not rely on merge-only items)
    const removeCall = `call-modify-remove-${Date.now()}`;
    const subR = await axios.post(
      `${baseUrl}/tools/submit_order`,
      {
        sessionId: "sess-mod-remove",
        callId: removeCall,
        restaurantId: "rest_001",
        items: [
          { menuItemName: "Lamb Chops", quantity: 2 },
          { menuItemName: "Chicken Dum Biryani", quantity: 1 },
        ],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const modRemoveRes = await axios.post(
      `${baseUrl}/tools/modify_order`,
      {
        sessionId: "sess-mod-remove",
        callId: removeCall,
        restaurantId: "rest_001",
        modifyMode: "merge",
        items: [],
        removeItems: [{ menuItemName: "Lamb Chops" }],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const hubRemove = await axios.get(`${baseUrl}/internal/orders-hub/orders`, { headers, timeout: 10000, validateStatus: () => true });
    const rowsR = (hubRemove.data?.orders || []).filter((o) => o.callId === removeCall);
    const newR = rowsR.find((o) => o.fulfillmentStatus === "Active");
    const removeFlowOk =
      subR.status === 200 &&
      subR.data.success === true &&
      modRemoveRes.status === 200 &&
      modRemoveRes.data.success === true &&
      newR &&
      newR.items.some((it) => it.name === "Chicken Dum Biryani") &&
      !newR.items.some((it) => it.name === "Lamb Chops");
    results.push({
      name: "modify-order-remove-items",
      pass: removeFlowOk,
      status: removeFlowOk ? 200 : "assert",
      data: removeFlowOk ? {} : { subR: subR.data, modRemoveRes: modRemoveRes.data, newR },
    });
  } catch (error) {
    results.push(
      { name: "cancel-order-after-submit", pass: false, status: "network-error", data: { message: error.message } },
      { name: "modify-order-replaces-items", pass: false, status: "network-error", data: { message: error.message } },
      { name: "modify-order-remove-items", pass: false, status: "network-error", data: { message: error.message } },
    );
  }

  // Same sessionId, no callId: multiple open orders require guestName (or orderGuid) — never guess "latest".
  try {
    const sharedSess = `sess-shared-${Date.now()}`;
    const r1 = await axios.post(
      `${baseUrl}/tools/submit_order`,
      {
        sessionId: sharedSess,
        restaurantId: "rest_001",
        guestName: "Ram",
        guestPhone: "+15550001001",
        items: [{ menuItemName: "Chicken Dum Biryani", quantity: 1 }],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const r2 = await axios.post(
      `${baseUrl}/tools/submit_order`,
      {
        sessionId: sharedSess,
        restaurantId: "rest_001",
        guestName: "Chris",
        guestPhone: "+15550001001",
        items: [{ menuItemName: "Garlic Naan", quantity: 1 }],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const amb = await axios.post(
      `${baseUrl}/tools/modify_order`,
      {
        sessionId: sharedSess,
        restaurantId: "rest_001",
        modifyMode: "replace",
        items: [{ menuItemName: "Lamb Chops", quantity: 1 }],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const modRam = await axios.post(
      `${baseUrl}/tools/modify_order`,
      {
        sessionId: sharedSess,
        restaurantId: "rest_001",
        guestName: "Ram",
        modifyMode: "replace",
        items: [
          { menuItemName: "Lamb Chops", quantity: 1 },
          { menuItemName: "Rasmalai", quantity: 4 },
        ],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const hub = await axios.get(`${baseUrl}/internal/orders-hub/orders`, { headers, timeout: 10000, validateStatus: () => true });
    const ramRows = (hub.data?.orders || []).filter((o) => o.sessionId === sharedSess && o.guestName === "Ram");
    const ramActive = ramRows.find((o) => o.fulfillmentStatus !== "Cancelled" && o.fulfillmentStatus !== "Completed");
    const chrisStill = (hub.data?.orders || []).find(
      (o) =>
        o.sessionId === sharedSess &&
        o.guestName === "Chris" &&
        o.fulfillmentStatus !== "Cancelled" &&
        o.fulfillmentStatus !== "Completed",
    );

    const ambiguousOk =
      r1.status === 200 &&
      r1.data.success === true &&
      r2.status === 200 &&
      r2.data.success === true &&
      amb.status === 200 &&
      amb.data.success === false &&
      amb.data.error === "ambiguous_active_orders";
    const disambigOk =
      modRam.status === 200 &&
      modRam.data.success === true &&
      ramActive &&
      ramActive.items.some((it) => it.name === "Lamb Chops") &&
      ramActive.items.some((it) => it.name === "Rasmalai") &&
      !ramActive.items.some((it) => it.name === "Chicken Dum Biryani") &&
      chrisStill &&
      chrisStill.items.some((it) => it.name === "Garlic Naan");
    results.push({
      name: "modify-order-shared-session-guestName-disambiguation",
      pass: ambiguousOk && disambigOk,
      status: ambiguousOk && disambigOk ? 200 : "assert",
      data:
        ambiguousOk && disambigOk
          ? {}
          : { r1: r1.data, r2: r2.data, amb: amb.data, modRam: modRam.data, ramActive, chrisStill },
    });
  } catch (error) {
    results.push({
      name: "modify-order-shared-session-guestName-disambiguation",
      pass: false,
      status: "network-error",
      data: { message: error.message },
    });
  }

  // Same call: modify_order merge with identical items + only guestName change must not double quantities.
  try {
    const ts = Date.now();
    const sess = `sess-namefix-${ts}`;
    const call = `call-namefix-${ts}`;
    const subNf = await axios.post(
      `${baseUrl}/tools/submit_order`,
      {
        sessionId: sess,
        callId: call,
        restaurantId: "rest_001",
        guestName: "Itsaram",
        guestPhone: "+15550003333",
        scheduledForIso: "2030-06-01T19:00:00-04:00",
        items: [{ menuItemName: "Chicken Dum Biryani", quantity: 1 }],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const modNf = await axios.post(
      `${baseUrl}/tools/modify_order`,
      {
        sessionId: sess,
        callId: call,
        restaurantId: "rest_001",
        guestName: "RAM",
        guestPhone: "+15550003333",
        scheduledForIso: "2030-06-01T19:00:00-04:00",
        modifyMode: "merge",
        items: [{ menuItemName: "Chicken Dum Biryani", quantity: 1 }],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const hubNf = await axios.get(`${baseUrl}/internal/orders-hub/orders`, { headers, timeout: 10000, validateStatus: () => true });
    const rowNf = (hubNf.data?.orders || []).find((o) => o.callId === call && o.fulfillmentStatus !== "Cancelled");
    const biryaniLine = rowNf && rowNf.items.find((it) => it.name === "Chicken Dum Biryani");
    const namefixOk =
      subNf.status === 200 &&
      subNf.data.success === true &&
      modNf.status === 200 &&
      modNf.data.success === true &&
      modNf.data.guestOrScheduleOnly === true &&
      rowNf &&
      rowNf.guestName === "RAM" &&
      biryaniLine &&
      Number(biryaniLine.quantity) === 1;
    results.push({
      name: "modify-order-merge-same-cart-name-only-no-double-qty",
      pass: namefixOk,
      status: namefixOk ? 200 : "assert",
      data: namefixOk ? {} : { subNf: subNf.data, modNf: modNf.data, rowNf, biryaniLine },
    });
  } catch (error) {
    results.push({
      name: "modify-order-merge-same-cart-name-only-no-double-qty",
      pass: false,
      status: "network-error",
      data: { message: error.message },
    });
  }

  // New Vapi session (different sessionId/callId): resolve open order by pickup phone + name.
  try {
    const ts = Date.now();
    // Unique national numbers so persisted hub rows from older runs do not collide on phone fallback.
    const uniquePriya = `+1${5550000000 + (ts % 8_999_999)}`;
    const placePhone = uniquePriya;
    const modifyPhone = uniquePriya;
    const placeSess = `sess-phone-place-${ts}`;
    const placeCall = `call-phone-place-${ts}`;
    const modSess = `sess-phone-mod-${ts}`;
    const modCall = `call-phone-mod-${ts}`;
    const subPhone = await axios.post(
      `${baseUrl}/tools/submit_order`,
      {
        sessionId: placeSess,
        callId: placeCall,
        restaurantId: "rest_001",
        guestName: "Priya",
        guestPhone: placePhone,
        items: [{ menuItemName: "Chicken Dum Biryani", quantity: 1 }],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const modPhone = await axios.post(
      `${baseUrl}/tools/modify_order`,
      {
        sessionId: modSess,
        callId: modCall,
        restaurantId: "rest_001",
        guestName: "Priya",
        guestPhone: modifyPhone,
        modifyMode: "replace",
        items: [
          { menuItemName: "Lamb Chops", quantity: 1 },
          { menuItemName: "Rasmalai", quantity: 2 },
        ],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const hubPhone = await axios.get(`${baseUrl}/internal/orders-hub/orders`, { headers, timeout: 10000, validateStatus: () => true });
    const priyaOpen = (hubPhone.data?.orders || []).find(
      (o) =>
        o.guestName === "Priya" &&
        o.fulfillmentStatus !== "Cancelled" &&
        o.fulfillmentStatus !== "Completed" &&
        o.items.some((it) => it.name === "Lamb Chops"),
    );
    const phoneCrossSessOk =
      subPhone.status === 200 &&
      subPhone.data.success === true &&
      modPhone.status === 200 &&
      modPhone.data.success === true &&
      priyaOpen &&
      priyaOpen.items.some((it) => it.name === "Lamb Chops") &&
      priyaOpen.items.some((it) => it.name === "Rasmalai") &&
      !priyaOpen.items.some((it) => it.name === "Chicken Dum Biryani");

    const sharedPhone = `+1${5560000000 + (ts % 8_999_999)}`;
    const s1 = await axios.post(
      `${baseUrl}/tools/submit_order`,
      {
        sessionId: `sess-sp1-${ts}`,
        callId: `c-sp1-${ts}`,
        restaurantId: "rest_001",
        guestName: "Alex",
        guestPhone: sharedPhone,
        items: [{ menuItemName: "Garlic Naan", quantity: 1 }],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const s2 = await axios.post(
      `${baseUrl}/tools/submit_order`,
      {
        sessionId: `sess-sp2-${ts}`,
        callId: `c-sp2-${ts}`,
        restaurantId: "rest_001",
        guestName: "Blake",
        guestPhone: sharedPhone,
        items: [{ menuItemName: "Chicken Dum Biryani", quantity: 1 }],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const ambPhone = await axios.post(
      `${baseUrl}/tools/modify_order`,
      {
        sessionId: `sess-spx-${ts}`,
        callId: `c-spx-${ts}`,
        restaurantId: "rest_001",
        guestPhone: sharedPhone,
        modifyMode: "replace",
        items: [{ menuItemName: "Lamb Chops", quantity: 1 }],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const modAlex = await axios.post(
      `${baseUrl}/tools/modify_order`,
      {
        sessionId: `sess-spy-${ts}`,
        callId: `c-spy-${ts}`,
        restaurantId: "rest_001",
        guestName: "Alex",
        guestPhone: sharedPhone,
        modifyMode: "replace",
        items: [{ menuItemName: "Lamb Chops", quantity: 2 }],
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const hub2 = await axios.get(`${baseUrl}/internal/orders-hub/orders`, { headers, timeout: 10000, validateStatus: () => true });
    const alexOpen = (hub2.data?.orders || []).find(
      (o) => o.guestName === "Alex" && o.fulfillmentStatus !== "Cancelled" && o.fulfillmentStatus !== "Completed",
    );
    const blakeOpen = (hub2.data?.orders || []).find(
      (o) => o.guestName === "Blake" && o.fulfillmentStatus !== "Cancelled" && o.fulfillmentStatus !== "Completed",
    );
    const samePhoneDisambigOk =
      s1.status === 200 &&
      s1.data.success === true &&
      s2.status === 200 &&
      s2.data.success === true &&
      ambPhone.status === 200 &&
      ambPhone.data.success === false &&
      ambPhone.data.error === "ambiguous_active_orders" &&
      modAlex.status === 200 &&
      modAlex.data.success === true &&
      alexOpen &&
      alexOpen.items.some((it) => it.name === "Lamb Chops") &&
      blakeOpen &&
      blakeOpen.items.some((it) => it.name === "Chicken Dum Biryani");

    results.push({
      name: "modify-order-phone-fallback-and-shared-phone-disambiguation",
      pass: phoneCrossSessOk && samePhoneDisambigOk,
      status: phoneCrossSessOk && samePhoneDisambigOk ? 200 : "assert",
      data:
        phoneCrossSessOk && samePhoneDisambigOk
          ? {}
          : { subPhone: subPhone.data, modPhone: modPhone.data, ambPhone: ambPhone.data, modAlex: modAlex.data, priyaOpen, alexOpen, blakeOpen },
    });
  } catch (error) {
    results.push({
      name: "modify-order-phone-fallback-and-shared-phone-disambiguation",
      pass: false,
      status: "network-error",
      data: { message: error.message },
    });
  }

  // Duplicate submit_order with same callId merges guest + schedule into Orders Hub (no second Toast order).
  const mergeCallId = `hub-merge-${Date.now()}`;
  const mergeBase = {
    sessionId: "sess-merge",
    callId: mergeCallId,
    restaurantId: "rest_001",
    items: [
      { menuItemName: "Chicken Dum Biryani", quantity: 1 },
      { menuItemName: "Garlic Naan", quantity: 1 },
    ],
  };
  try {
    const first = await axios.post(`${baseUrl}/tools/submit_order`, mergeBase, { headers, timeout: 10000, validateStatus: () => true });
    const second = await axios.post(
      `${baseUrl}/tools/submit_order`,
      {
        ...mergeBase,
        guestName: "Merge Test",
        guestPhone: "+15550001111",
        scheduledForIso: "2030-01-15T20:00:00-05:00",
      },
      { headers, timeout: 10000, validateStatus: () => true },
    );
    const hubRes = await axios.get(`${baseUrl}/internal/orders-hub/orders`, { headers, timeout: 10000, validateStatus: () => true });
    const row = (hubRes.data?.orders || []).find((o) => o.callId === mergeCallId);
    const mergeOk =
      first.status === 200 &&
      first.data.success === true &&
      second.status === 200 &&
      second.data.duplicate === true &&
      hubRes.status === 200 &&
      row &&
      row.guestName === "Merge Test" &&
      row.guestPhone === "+15550001111" &&
      row.scheduledForIso === "2030-01-15T20:00:00-05:00" &&
      row.fulfillmentStatus === "Scheduled";
    results.push({
      name: "orders-hub-merge-on-duplicate-submit",
      pass: mergeOk,
      status: mergeOk ? 200 : "assert",
      data: mergeOk ? {} : { first: first.data, second: second.data, hub: hubRes.data, row },
    });
  } catch (error) {
    results.push({
      name: "orders-hub-merge-on-duplicate-submit",
      pass: false,
      status: "network-error",
      data: { message: error.message },
    });
  }

  let failed = 0;
  for (const result of results) {
    const icon = result.pass ? "PASS" : "FAIL";
    console.log(`${icon} ${result.name} -> status=${result.status}`);
    if (!result.pass) {
      failed += 1;
      console.log(JSON.stringify(result.data, null, 2));
    }
  }

  if (failed > 0) {
    server.close();
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }

  server.close();
  console.log("\nAll local tests passed.");
}

main();
