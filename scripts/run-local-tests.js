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
    expectStatus: 400,
    expectSuccess: false,
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

    const pass = statusOk && successOk && duplicateOk && errorOk;
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
