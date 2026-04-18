const axios = require("axios");
const { start } = require("../src/server");

const baseUrl = process.env.BASE_URL || "http://localhost:3000";
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
