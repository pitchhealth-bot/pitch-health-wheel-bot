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
  DISCORD_APPLICATION_ID,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_NAME = "Spin Log",
  WHEEL_BASE_URL,
} = process.env;

/* =========================
   SIMPLE CORS
========================= */

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://pitch-health-wheel-web.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

app.options("*", (req, res) => {
  res.sendStatus(204);
});

/* =========================
   DISCORD INTERACTIONS
========================= */

app.post("/interactions", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    const signature = req.get("X-Signature-Ed25519");
    const timestamp = req.get("X-Signature-Timestamp");
    const rawBody = req.body;

    console.log("=== /interactions hit ===");

    if (!signature || !timestamp || !DISCORD_PUBLIC_KEY) {
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

    if (interaction.type === InteractionType.PING) {
      return res.json({ type: InteractionResponseType.PONG });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const commandName = interaction.data?.name;

      if (commandName === "spin") {
        const user = interaction.member?.user || interaction.user;
        const spinnerName =
          user?.global_name || user?.username || "Unknown User";
        const discordUserId = user?.id || "";
        const interactionToken = interaction.token;
        const sessionId = crypto.randomBytes(6).toString("hex");

        const wheelUrl = `${WHEEL_BASE_URL}?session=${sessionId}`;

        res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `🎡 ${spinnerName}, spin your reward!\n\n👉 ${wheelUrl}`,
          },
        });

        createSpinRecord({
          spinnerName,
          discordUserId,
          sessionId,
          interactionToken,
        }).catch((error) => {
          console.error("Airtable create failed:", error);
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

/* =========================
   JSON FOR NORMAL ROUTES
========================= */

app.use(express.json());

function getBaseUrl() {
  return `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
    AIRTABLE_TABLE_NAME
  )}`;
}

async function airtableFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return { response, data, text };
}

async function createSpinRecord({
  spinnerName,
  discordUserId,
  sessionId,
  interactionToken,
}) {
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
    throw new Error("Missing Airtable environment variables");
  }

  const url = getBaseUrl();

  const payload = {
    records: [
      {
        fields: {
          "Spinner Name": spinnerName,
          "Discord User ID": discordUserId,
          "Session ID": sessionId,
          "Status": "Pending",
          "Interaction Token": interactionToken,
        },
      },
    ],
  };

  console.log("Creating Airtable spin record:", payload);

  const { response, text } = await airtableFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Airtable create failed: ${response.status} ${text}`);
  }

  console.log("Airtable create success");
}

async function findSpinRecord(sessionId) {
  const baseUrl = getBaseUrl();
  const filterFormula = encodeURIComponent(`{Session ID}='${sessionId}'`);

  const { response, data, text } = await airtableFetch(
    `${baseUrl}?filterByFormula=${filterFormula}`
  );

  if (!response.ok) {
    throw new Error(`Airtable lookup failed: ${response.status} ${text}`);
  }

  return data.records?.[0] || null;
}

app.get("/session-status", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    const record = await findSpinRecord(sessionId);

    if (!record) {
      return res.status(404).json({ error: "Session not found" });
    }

    return res.json({
      success: true,
      status: record.fields["Status"] || "Pending",
      reward: record.fields["Reward"] || "",
    });
  } catch (error) {
    console.error("Session status error:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.post("/complete-spin", async (req, res) => {
  try {
    const { sessionId, reward } = req.body;

    console.log("=== /complete-spin hit ===");
    console.log("sessionId:", sessionId);
    console.log("reward:", reward);

    if (!sessionId || !reward) {
      return res.status(400).json({ error: "sessionId and reward are required" });
    }

    const record = await findSpinRecord(sessionId);

    if (!record) {
      return res.status(404).json({ error: "Session not found" });
    }

    const recordId = record.id;
    const currentStatus = record.fields["Status"];
    const existingReward = record.fields["Reward"] || "";
    const interactionToken = record.fields["Interaction Token"];

    if (currentStatus === "Completed") {
      return res.json({
        success: true,
        alreadyCompleted: true,
        reward: existingReward,
      });
    }

    const baseUrl = getBaseUrl();

    const updatePayload = {
      fields: {
        "Reward": reward,
        "Status": "Completed",
      },
    };

    console.log("Updating Airtable with payload:", updatePayload);

    const { response, text } = await airtableFetch(`${baseUrl}/${recordId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updatePayload),
    });

    if (!response.ok) {
      console.error("Airtable update failed:", response.status, text);
      return res.status(500).json({
        error: "Airtable update failed",
        status: response.status,
        details: text,
      });
    }

    console.log("Airtable update success");

    if (!interactionToken) {
      console.error("No Interaction Token found on Airtable record");
    } else if (!DISCORD_APPLICATION_ID) {
      console.error("Missing DISCORD_APPLICATION_ID in environment");
    } else {
      const discordWebhookUrl = `https://discord.com/api/v10/webhooks/${DISCORD_APPLICATION_ID}/${interactionToken}`;

      const discordResponse = await fetch(discordWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: `🎉 Final result: **${reward}**`,
        }),
      });

      const discordText = await discordResponse.text();

      if (!discordResponse.ok) {
        console.error(
          "Discord follow-up failed:",
          discordResponse.status,
          discordText
        );
      } else {
        console.log("Discord follow-up sent");
      }
    }

    return res.json({
      success: true,
      reward,
    });
  } catch (error) {
    console.error("Complete spin error:", error);
    return res.status(500).json({
      error: "Failed to complete spin",
      details: error.message,
    });
  }
});

app.get("/", (req, res) => {
  res.send("Pitch Health Wheel Bot is running");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Running on ${PORT}`);
});
