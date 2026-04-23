import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();

/* =========================
   ENV VARIABLES
========================= */

const {
  DISCORD_PUBLIC_KEY,
  DISCORD_APPLICATION_ID,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_NAME = "Spin Log",
  WHEEL_BASE_URL,
} = process.env;

/* =========================
   RAW BODY FOR DISCORD
========================= */

// Discord signature verification MUST use the raw request body.
// So we use express.raw() only for /interactions.
app.post(
  "/interactions",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-signature-ed25519"];
      const timestamp = req.headers["x-signature-timestamp"];
      const rawBody = req.body;

      if (!signature || !timestamp || !DISCORD_PUBLIC_KEY) {
        return res.status(401).send("Missing signature headers or public key");
      }

      const isValid = crypto.verify(
        null,
        Buffer.concat([Buffer.from(timestamp), rawBody]),
        {
          key: Buffer.from(DISCORD_PUBLIC_KEY, "hex"),
          format: "der",
          type: "spki",
        },
        Buffer.from(signature, "hex")
      );

      // If the above method fails in your environment, fallback below:
      // Discord uses Ed25519 raw public key format, and Node's crypto can be finicky.
      // So we manually construct the SPKI wrapper around the raw 32-byte key.
      // We'll only do that if needed.
      let verified = isValid;

      if (!verified) {
        try {
          const rawKey = Buffer.from(DISCORD_PUBLIC_KEY, "hex");
          const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
          const publicKey = Buffer.concat([spkiPrefix, rawKey]);

          verified = crypto.verify(
            null,
            Buffer.concat([Buffer.from(timestamp), rawBody]),
            {
              key: publicKey,
              format: "der",
              type: "spki",
            },
            Buffer.from(signature, "hex")
          );
        } catch (err) {
          console.error("Fallback verification error:", err);
        }
      }

      if (!verified) {
        return res.status(401).send("Invalid request signature");
      }

      const interaction = JSON.parse(rawBody.toString("utf8"));

      // Discord endpoint verification ping
      if (interaction.type === 1) {
        return res.json({ type: 1 });
      }

      // Slash command
      if (interaction.type === 2) {
        const commandName = interaction.data.name;

        if (commandName === "spin") {
          const user = interaction.member?.user || interaction.user;
          const sessionId = crypto.randomBytes(6).toString("hex");

          await createSpinRecord(user.username, user.id, sessionId);

          const wheelUrl = `${WHEEL_BASE_URL}?session=${sessionId}`;

          return res.json({
            type: 4,
            data: {
              content: `🎡 ${user.username}, spin your reward!\n\n👉 ${wheelUrl}`,
            },
          });
        }
      }

      return res.json({});
    } catch (err) {
      console.error("Interaction error:", err);
      return res.status(500).send("Error handling interaction");
    }
  }
);

// Normal JSON parsing for every other route
app.use(express.json());

/* =========================
   AIRTABLE HELPERS
========================= */

async function createSpinRecord(spinnerName, discordUserId, sessionId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
    AIRTABLE_TABLE_NAME
  )}`;

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

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
      AIRTABLE_TABLE_NAME
    )}`;

    const filterFormula = encodeURIComponent(`{Session ID}='${sessionId}'`);
    const findRes = await fetch(`${url}?filterByFormula=${filterFormula}`, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      },
    });

    const data = await findRes.json();

    if (!data.records || !data.records.length) {
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
          Reward: reward,
          Status: "Completed",
        },
      }),
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Complete spin error:", err);
    return res.status(500).json({ error: "Failed to complete spin" });
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
