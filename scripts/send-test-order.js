const axios = require("axios");

async function main() {
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  const apiKey = process.env.WEBHOOK_API_KEY || "";
  const payload = {
    sessionId: "session-test-001",
    callId: "call-test-001",
    restaurantId: "rest_001",
    guestName: "Test Guest",
    guestPhone: "+15555550123",
    diningBehavior: "Takeout",
    items: [
      { menuItemName: "Chicken Dum Biryani", quantity: 1, specialInstructions: "medium spice" },
      { menuItemName: "Garlic Naan", quantity: 2 },
      { menuItemName: "Butter Chicken", quantity: 1 },
    ],
  };

  const response = await axios.post(
    `${baseUrl}/tools/submit_order`,
    payload,
    {
      timeout: 10000,
      headers: apiKey ? { "x-api-key": apiKey } : {},
    },
  );

  console.log("Status:", response.status);
  console.log("Response:", JSON.stringify(response.data, null, 2));
}

main().catch((error) => {
  if (error.response) {
    console.error("Status:", error.response.status);
    console.error("Error:", JSON.stringify(error.response.data, null, 2));
  } else {
    console.error(error.message);
  }
  process.exit(1);
});
