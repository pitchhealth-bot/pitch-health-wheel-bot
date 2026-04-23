import express from "express";
import Airtable from "airtable";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "Spin Log";
const WHEEL_BASE_URL = process.env.WHEEL_BASE_URL || "https://pitch-health-wheel-web.vercel.app";

let base = null;

if (AIRTABLE_TOKEN && AIRTABLE_BASE_ID) {
  base = new Airtable({ apiKey: AIRTABLE_TOKEN }).base(AIRTABLE_BASE_ID);
}

function createSessionId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

app.get("/", (req, res) => {
  res.send("Pitch Health Wheel Bot is running");
});

app.post("/spin", async (req, res) => {
  try {
    const { spinnerName = "Unknown User", discordUserId = "" } = req.body || {};

    const sessionId = createSessionId();
    const wheelUrl = `${WHEEL_BASE_URL}?session=${sessionId}&spinner=${encodeURIComponent(spinnerName)}`;

    if (base) {
      await base(AIRTABLE_TABLE_NAME).create([
        {
          fields: {
            "Spinner Name": spinnerName,
            "Discord User ID": discordUserId,
            "Session ID": sessionId,
            "Status": "Pending"
          }
        }
      ]);
    }

    return res.json({
      success: true,
      sessionId,
      wheelUrl
    });
  } catch (error) {
    console.error("Spin error:", error);
    return res.status(500).json({
      success: false,
      error: "Could not create spin session"
    });
  }
});

app.post("/complete-spin", async (req, res) => {
  try {
    const { sessionId, reward } = req.body || {};

    if (!base) {
      return res.json({ success: true });
    }

    const records = await base(AIRTABLE_TABLE_NAME)
      .select({
        filterByFormula: `{Session ID}='${sessionId}'`,
        maxRecords: 1
      })
      .firstPage();

    if (records.length > 0) {
      await base(AIRTABLE_TABLE_NAME).update([
        {
          id: records[0].id,
          fields: {
            Reward: reward,
            Status: "Completed"
          }
        }
      ]);
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Complete spin error:", error);
    return res.status(500).json({
      success: false,
      error: "Could not complete spin"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
