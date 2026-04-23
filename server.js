import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
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

/* =========================
   DISCORD INTERACTIONS
========================= */

app.post("/interactions", express.text({ type: "application/json" }), async (req, res) => {
  try {
    const signature = req.get("X-Signature-Ed25519");
    const timestamp = req.get("X-Signature-Timestamp");

    const isValid = verifyKey(req.body, signature, timestamp, DISCORD_PUBLIC_KEY);

    if (!isValid) {
      return res.status(401).send("Invalid signature");
    }

    const interaction = JSON.parse(req.body);

    // Ping check
    if (interaction.type === InteractionType.PING) {
      return res.json({ type: InteractionResponseType.PONG });
    }

    // Slash command
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      if (interaction.data.name === "spin") {
        const user = interaction.member?.user || interaction.user;

        const sessionId = crypto.randomBytes(6).toString("hex");

        await createSpinRecord(user.username, user.id, sessionId);

        const wheelUrl = `${WHEEL_BASE_URL}?session=${sessionId}`;

        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `🎡 ${user.username}, spin your reward!\n\n👉 ${wheelUrl}`,
          },
        });
      }
    }

    return res.json({});
  } catch (err) {
    console.error(err);
    return res.status(500).send("Error");
  }
});

/* =========================
   JSON FOR OTHER ROUTES
========================= */

app.use(express.json());

/* =========================
   AIRTABLE
========================= */

async function createSpinRecord(name, discordId, sessionId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      records: [
        {
          fields: {
            "Spinner Name": name,
            "Discord User ID": discordId,
            "Session ID": sessionId,
            "Status": "Pending",
          },
        },
      ],
    }),
  });
}

/* =========================
   COMPLETE SPIN
========================= */

app.post("/complete-spin", async (req, res) => {
  try {
    const { sessionId, reward } = req.body;

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;

    const find = await fetch(`${url}?filterByFormula={Session ID}='${sessionId}'`, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });

    const data = await find.json();

    const recordId = data.records[0]?.id;

    if (!recordId) return res.status(404).json({ error: "Not found" });

    await fetch(`${url}/${recordId}`, {
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

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed" });
  }
});

/* =========================
   HEALTH
========================= */

app.get("/", (req, res) => {
  res.send("Bot running");
});

app.listen(10000, () => console.log("Running on 10000"));
