import express from "express";
import crypto from "crypto";
import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from "discord-interactions";

const app = express();

const {
  DISCORD_PUBLIC_KEY,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_NAME = "Spin Log",
  WHEEL_BASE_URL,
} = process.env;

/*
  DISCORD INTERACTIONS
  Use express.raw so Discord signature verification uses exact raw bytes
*/
app.post("/interactions", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    const signature = req.get("X-Signature-Ed25519");
    const timestamp = req.get("X-Signature-Timestamp");
    const rawBody = req.body;

    console.log("=== /interactions hit ===");
    console.log("signature header exists:", !!signature);
    console.log("timestamp header exists:", !!timestamp);
    console.log("public key exists:", !!DISCORD_PUBLIC_KEY);

    if (!signature || !timestamp || !DISCORD_PUBLIC_KEY) {
      console.log("Missing Discord signature headers or public key");
      return res.status(401).send("Missing Discord signature headers or public key");
    }

    const isValid = await verifyKey(
      rawBody,
      signature,
      timestamp,
      DISCORD_PUBLIC_KEY
    );

    console.log("verifyKey result:", isValid);

    if (!isValid) {
      return res.status(401).send("Invalid signature");
    }

    const interaction = JSON.parse(rawBody.toString("utf8"));
    console.log("interaction type:", interaction.type);

    // Discord endpoint verification
    if (interaction.type === InteractionType.PING) {
      console.log("Returning PONG");
      return res.json({ type: InteractionResponseType.PONG });
    }

    // Slash command handling
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const commandName = interaction.data?.name;

      if (commandName === "spin") {
        const user = interaction.member?.user || interaction.user;
        const spinnerName = user?.global_name || user?.username || "Unknown User";
        const discordUserId = user?.id || "";
        const sessionId = crypto.randomBytes(6).toString("hex");

        const wheelUrl = `${WHEEL_BASE_URL}?session=${sessionId}`;

        // 🔥 Respond to Discord IMMEDIATELY
        res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `🎡 ${spinnerName}, spin your reward!\n\n👉 ${wheelUrl}`,
          },
        });

        // 🔥 Create Airtable record in background
        createSpinRecord(spinnerName, discordUserId, sessionId).catch((error) => {
          console.error("Background Airtable create failed:", error);
        });

        return;
      }
    }

    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Unknown command.",
      },
    });
  } catch (err) {
    console.error("interaction route error:", err);
    return res.status(500).send("Error handling interaction");
  }
});

/*
  Normal JSON parsing for non-Discord routes
*/
app.use(express.json());

async function createSpinRecord(spinnerName, discordUserId, sessionId) {
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
    throw new Error("Missing Airtable environment variables");
  }

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
    AIRTABLE_TABLE_NAME
  )}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      records: [
        {
          fields: {
            "Spinner Name": spinnerName,
            "Discord User ID": discordUserId,
            "Session ID": sessionId,
            "Status": "Pending",
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("Airtable create failed:", response.status, text);
    throw new Error(`Airtable create failed: ${response.status} ${text}`);
  }
}

app.post("/complete-spin", async (req, res) => {
  try {
    const { sessionId, reward } = req.body;

    console.log("=== /complete-spin hit ===");
    console.log("sessionId:", sessionId);
    console.log("reward:", reward);

    if (!sessionId || !reward) {
      return res.status(400).json({ error: "sessionId and reward are required" });
    }

    const baseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
      AIRTABLE_TABLE_NAME
    )}`;

    const filterFormula = encodeURIComponent(`{Session ID}='${sessionId}'`);

    const findResponse = await fetch(`${baseUrl}?filterByFormula=${filterFormula}`, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      },
    });

    if (!findResponse.ok) {
      const text = await findResponse.text();
      throw new Error(`Airtable lookup failed: ${findResponse.status} ${text}`);
    }

    const data = await findResponse.json();

    if (!data.records || data.records.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    const recordId = data.records[0].id;

    const updateResponse = await fetch(`${baseUrl}/${recordId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          Reward: reward,
          Status: "Completed",
        },
      }),
    });

    if (!updateResponse.ok) {
      const text = await updateResponse.text();
      throw new Error(`Airtable update failed: ${updateResponse.status} ${text}`);
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Complete spin error:", error);
    return res.status(500).json({ error: "Failed to complete spin" });
  }
});

app.post("/spin", async (req, res) => {
  try {
    const { spinnerName = "Test User", discordUserId = "manual-test" } = req.body || {};
    const sessionId = crypto.randomBytes(6).toString("hex");

    console.log("=== /spin manual test hit ===");
    console.log("spinnerName:", spinnerName);
    console.log("discordUserId:", discordUserId);

    await createSpinRecord(spinnerName, discordUserId, sessionId);

    const wheelUrl = `${WHEEL_BASE_URL}?session=${sessionId}`;

    return res.json({
      success: true,
      sessionId,
      wheelUrl,
    });
  } catch (error) {
    console.error("Manual spin error:", error);
    return res.status(500).json({ error: "Failed to create spin" });
  }
});

app.get("/", (req, res) => {
  res.send("Pitch Health Wheel Bot is running");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Running on ${PORT}`);
});
