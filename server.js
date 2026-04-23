import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json());

/* =========================
   ENV VARIABLES
========================= */

const {
  DISCORD_PUBLIC_KEY,
  DISCORD_APPLICATION_ID,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_NAME = "Spin Log",
  WHEEL_BASE_URL
} = process.env;

/* =========================
   DISCORD SIGNATURE VERIFY
========================= */

function verifyDiscordRequest(req) {
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];

  const body = JSON.stringify(req.body);

  const isValid = crypto.verify(
    null,
    Buffer.from(timestamp + body),
    Buffer.from(DISCORD_PUBLIC_KEY, "hex"),
    Buffer.from(signature, "hex")
  );

  return isValid;
}

/* =========================
   CREATE SPIN (Airtable)
========================= */

async function createSpinRecord(spinnerName, discordUserId, sessionId) {
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
            "Spinner Name": spinnerName,
            "Discord User ID": discordUserId,
            "Session ID": sessionId,
            "Status": "Pending"
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

    const findRes = await fetch(`${url}?filterByFormula={Session ID}='${sessionId}'`, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      },
    });

    const data = await findRes.json();

    if (!data.records.length) {
      return res.status(404).json({ error: "Session not found" });
    }

    const recordId = data.records[0].id;

    await fetch(`${url}/${recordId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          "Reward": reward,
          "Status": "Completed",
        },
      }),
    });

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to complete spin" });
  }
});

/* =========================
   DISCORD INTERACTIONS
========================= */

app.post("/interactions", async (req, res) => {
  try {
    // 🔒 Verify request
    if (!verifyDiscordRequest(req)) {
      return res.status(401).send("Invalid request signature");
    }

    const interaction = req.body;

    // 🔁 Discord PING (verification)
    if (interaction.type === 1) {
      return res.json({ type: 1 });
    }

    // 🎡 Slash command
    if (interaction.type === 2) {
      const commandName = interaction.data.name;

      if (commandName === "spin") {

        const user = interaction.member?.user || interaction.user;

        const sessionId = crypto.randomBytes(6).toString("hex");

        // 🔥 Create Airtable record
        await createSpinRecord(
          user.username,
          user.id,
          sessionId
        );

        const wheelUrl = `${WHEEL_BASE_URL}?session=${sessionId}`;

        return res.json({
          type: 4,
          data: {
            content: `🎡 ${user.username}, spin your reward!\n\n👉 ${wheelUrl}`
          }
        });
      }
    }

    return res.json({});

  } catch (err) {
    console.error(err);
    res.status(500).send("Error handling interaction");
  }
});

/* =========================
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.send("Pitch Health Wheel Bot is running");
});

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
