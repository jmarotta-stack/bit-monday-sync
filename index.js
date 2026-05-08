require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONDAY_API_URL = "https://api.monday.com/v2";

let bitAccessToken = null;
let browserInstance = null;

const COLS = {
  company: "text59",
  email: "email",
  phone: "phone_1",
  trafficSource: "text_mkty6s2b",
  medium: "text_mktyazvy",
  campaignCode: "text_mkty4cs2",
  bitRfqId: "text_mm34238a"
};

app.get("/", (req, res) => {
  res.send("BIT Monday Sync Running");
});

async function ensureBitLogin() {
  if (bitAccessToken) return;

  console.log("Logging into BIT automatically...");

  browserInstance = await chromium.launch({
    headless: true
  });

  const page = await browserInstance.newPage();

  page.on("request", request => {
    const headers = request.headers();

    if (headers.authorization && headers.authorization.startsWith("Bearer")) {
      bitAccessToken = headers.authorization.replace("Bearer ", "");
      console.log("BIT TOKEN CAPTURED");
    }
  });

  await page.goto("https://bitv5.net", {
    waitUntil: "networkidle"
  });

  await page.fill('input[placeholder="User Name"]', process.env.BIT_USERNAME);
  await page.fill('input[placeholder="Password"]', process.env.BIT_PASSWORD);
  await page.click('button:has-text("Login")');

  await page.waitForTimeout(8000);

  if (!bitAccessToken) {
    throw new Error("Failed to capture BIT token after login.");
  }
}

async function mondayGraphql(query) {
  const response = await axios.post(
    MONDAY_API_URL,
    { query },
    {
      headers: {
        Authorization: process.env.MONDAY_API_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );

  if (response.data.errors) {
    throw new Error(JSON.stringify(response.data.errors));
  }

  return response.data;
}

async function findMondayItemByRfqId(rfqId) {
  const query = `
    query {
      items_page_by_column_values(
        board_id: ${process.env.MONDAY_BOARD_ID},
        columns: [
          {
            column_id: "${COLS.bitRfqId}",
            column_values: ["${rfqId}"]
          }
        ],
        limit: 1
      ) {
        items {
          id
          name
        }
      }
    }
  `;

  const data = await mondayGraphql(query);
  return data.data.items_page_by_column_values.items[0] || null;
}

function clean(value) {
  return value ? String(value).trim() : "";
}

function escapeGraphqlString(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

async function createMondayItemFromRfq(rfq) {
  const itemName =
    clean(`${rfq.firstName || ""} ${rfq.lastName || ""}`) ||
    rfq.rfqDisplayId ||
    "New RFQ";

  const columnValues = {
    [COLS.company]: clean(rfq.companyName),
    [COLS.email]: {
      email: clean(rfq.email),
      text: clean(rfq.email)
    },
    [COLS.phone]: {
      phone: clean(rfq.phone),
      countryShortName: "US"
    },
    [COLS.trafficSource]: clean(rfq.leadSource),
    [COLS.medium]: clean(rfq.categoryMedium),
    [COLS.campaignCode]: clean(rfq.campaign),
    [COLS.bitRfqId]: clean(rfq.rfqId)
  };

  const mutation = `
    mutation {
      create_item(
        board_id: ${process.env.MONDAY_BOARD_ID},
        item_name: "${escapeGraphqlString(itemName)}",
        column_values: ${JSON.stringify(JSON.stringify(columnValues))}
      ) {
        id
      }
    }
  `;

  const data = await mondayGraphql(mutation);
  return data.data.create_item.id;
}

function getDateString(date) {
  return date.toISOString().split("T")[0];
}

async function getBitRfqs() {
  await ensureBitLogin();

  const statusId = process.env.BIT_STATUS_ID || 1;

  const to = new Date();
  const from = new Date(process.env.BIT_FROM_DATE);

  const url =
    `https://api.bitv5.net/api/RFQ/Browse` +
    `?Results=50` +
    `&Page=0` +
    `&OrderBy=id` +
    `&SortOrder=desc` +
    `&IsActive=true` +
    `&StatusId=${statusId}` +
    `&From=${getDateString(from)}` +
    `&To=${getDateString(to)}` +
    `&IsUnAssigned=false`;

  console.log("Fetching RFQs from BIT...");

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${bitAccessToken}`
    }
  });

  return response.data.data.items || [];
}

async function runSync() {
  const rfqs = await getBitRfqs();

  const created = [];
  const skipped = [];
  const failed = [];

  for (const rfq of rfqs) {
    try {
      if (!rfq.rfqId) {
        skipped.push({
          rfqDisplayId: rfq.rfqDisplayId,
          reason: "Missing rfqId"
        });
        continue;
      }

      const existing = await findMondayItemByRfqId(rfq.rfqId);

      if (existing) {
        skipped.push({
          rfqDisplayId: rfq.rfqDisplayId,
          rfqId: rfq.rfqId,
          reason: "Already exists",
          mondayItemId: existing.id
        });
        continue;
      }

      const mondayItemId = await createMondayItemFromRfq(rfq);

      created.push({
        rfqDisplayId: rfq.rfqDisplayId,
        rfqId: rfq.rfqId,
        mondayItemId
      });
    } catch (itemError) {
      failed.push({
        rfqDisplayId: rfq.rfqDisplayId,
        rfqId: rfq.rfqId,
        error: itemError.message
      });
    }
  }

  return {
    success: true,
    checked: rfqs.length,
    createdCount: created.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    created,
    skipped,
    failed
  };
}

app.get("/sync", async (req, res) => {
  try {
    const result = await runSync();
    res.json(result);
  } catch (error) {
    console.error(error.response?.data || error.message);
    bitAccessToken = null;

    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

app.post("/sync", async (req, res) => {
  try {
    console.log("Monday automation called /sync");
    console.log("Payload:", JSON.stringify(req.body || {}, null, 2));

    const result = await runSync();

    res.json(result);
  } catch (error) {
    console.error(error.response?.data || error.message);
    bitAccessToken = null;

    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});