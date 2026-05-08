require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const MONDAY_API_URL = "https://api.monday.com/v2";

const COLS = {
  nameText: "text2",
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
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
}

async function createMondayUpdate(itemId, rfq) {
  const specialInstructions = clean(rfq.specialInstruction) || "None";
  const originZip = clean(rfq.originZip) || "N/A";
  const destinationZip = clean(rfq.destinationZip) || "N/A";

  const fullName =
  clean(`${rfq.firstName || ""} ${rfq.lastName || ""}`) || "N/A";

const companyName = clean(rfq.companyName) || "N/A";
const email = clean(rfq.email) || "N/A";

const updateBody =
  `Name: ${fullName}\n` +
  `Company: ${companyName}\n` +
  `Email: ${email}\n` +
  `Origin ZIP: ${originZip}\n` +
  `Destination ZIP: ${destinationZip}\n\n` +
  `Special Instructions:\n${specialInstructions}`;

  const mutation = `
    mutation {
      create_update(
        item_id: ${itemId},
        body: "${escapeGraphqlString(updateBody)}"
      ) {
        id
      }
    }
  `;

  await mondayGraphql(mutation);
}

async function createMondayItemFromRfq(rfq) {
  const itemName =
    clean(`${rfq.firstName || ""} ${rfq.lastName || ""}`) ||
    rfq.rfqDisplayId ||
    "New RFQ";

  const columnValues = {
    [COLS.nameText]: itemName,

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
  const itemId = data.data.create_item.id;

  await createMondayUpdate(itemId, rfq);

  return itemId;
}

function getDateString(date) {
  return date.toISOString().split("T")[0];
}

let cachedBitAccessToken = null;
let cachedBitRefreshToken = process.env.BIT_REFRESH_TOKEN;

async function refreshBitToken() {
  console.log("Refreshing BIT access token...");

  const params = new URLSearchParams();

  params.append(
    "client_id",
    process.env.BIT_CLIENT_ID || "CNF.BIT.UI"
  );

  params.append("grant_type", "refresh_token");

  params.append(
  "refresh_token",
  cachedBitRefreshToken
);

  const response = await axios.post(
    "https://id.bitv5.net/connect/token",
    params.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  cachedBitAccessToken = response.data.access_token;

  if (response.data.refresh_token) {
  cachedBitRefreshToken = response.data.refresh_token;

  console.log(
    "NEW_REFRESH_TOKEN:",
    cachedBitRefreshToken
  );
}

  return cachedBitAccessToken;
}

async function getBitAccessToken() {
  if (cachedBitAccessToken) {
    return cachedBitAccessToken;
  }

  return await refreshBitToken();
}

async function getBitRfqs() {
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

    let accessToken = await getBitAccessToken();

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    return response.data.data.items || [];
  } catch (error) {
    if (error.response?.status === 401 || error.response?.status === 403) {
      console.log("BIT token expired. Refreshing and retrying once...");

      accessToken = await refreshBitToken();

      const retryResponse = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      return retryResponse.data.data.items || [];
    }

    throw error;
  }
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

    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

app.post("/sync", async (req, res) => {
  try {
    console.log("Monday automation called /sync");

    const result = await runSync();
    res.json(result);
  } catch (error) {
    console.error(error.response?.data || error.message);

    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
