const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay,
    generateForwardMessageContent,
    generateWAMessageFromContent
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const { Boom } = require("@hapi/boom");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");

const app = express();
const port = 3000;
const sessionsDir = path.join(__dirname, 'accounts');

// Création du dossier de stockage si absent
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

let tempSocks = {};
global.msgStore = {};

// Helper pour récupérer les paramètres (AntiPromote etc)
const getSetting = (type, key) => config[key] || false;

/**
 * FONCTION PRINCIPALE DE CONNEXION DU BOT
 */
async function startUserBot(phoneNumber, isPairing = false) {
    const sessionName = `session_${phoneNumber.replace(/[^0-9]/g, '')}`;
    const sessionPath = path.join(sessionsDir, sessionName);

    // Suppression de l'ancienne session si on demande un nouveau pairing
    if (isPairing) {
        if (tempSocks[sessionName]) {
            try { tempSocks[sessionName].end(); delete tempSocks[sessionName]; } catch (e) { }
        }
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();
    let currentMode = config.MODE || "public";

    const det = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        }
    });

    tempSocks[sessionName] = det;

    det.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            const decode = jidDecode(jid) || {};
            return decode.user && decode.server && `${decode.user}@${decode.server}` || jid;
        }
        return jid;
    };

    // ✅ FIX: Request pairing code immediately after socket creation,
    // before any connection events fire. Small 1.5s buffer is enough.
    let pairCode = null;
    if (isPairing && !det.authState.creds.registered) {
        await delay(1500);
        pairCode = await det.requestPairingCode(
            phoneNumber.replace(/[^0-9]/g, ''),
            "NULLCRSH" // ✅ FIX: exactly 8 uppercase alphanumeric chars (was "NULL-GEN1" — invalid)
        );
    }

    det.ev.on("messages.upsert", async chatUpdate => {
        try {
            const msg = chatUpdate.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
            const m = smsg(det, msg, store);
            require("./handler")(det, n, chatUpdate, store);
        } catch (err) {
            console.error("Error message scanning:", err.stack || err.message);
        }
    });

    // --- GESTION DE LA CONNEXION ---
    det.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
            if (reason !== DisconnectReason.loggedOut && tempSocks[sessionName]) {
                console.log(`[${phoneNumber}] Reconnection...`);
                startUserBot(phoneNumber);
            }
        } else if (connection === "open") {
            if ("120363419855570475@newsletter")
            try {
                await det.newsletterFollow("120363419855570475@newsletter");
            } catch (err) {
                console.log("Newsletter follow failed:", err.message || err);
            }
            console.log(`✅ [${phoneNumber}] Session Connected !`);
            const userJid = det.user.id.split(":")[0] + "@s.whatsapp.net";
            await det.sendMessage(userJid, {
                image: { url: "https://files.catbox.moe/4w8x5f.png" },
                caption:
`╭─────────────────⭓
│
│  ✅ NULL CRASH 
│
├─────────────────
│
│  👤 Owner: NULL 
│
╰─────────────────⭓

> 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃 𝚂𝚈𝚂𝚃𝙴𝙼 ϟ`,
            });
        }
    });

    det.ev.on("creds.update", saveCreds);

    // Return both the socket and the pairing code
    return { sock: det, code: pairCode };
}

/**
 * FONCTION D'AUTOLOAD DES SESSIONS AU DÉMARRAGE
 */
async function restoreSessions() {
    console.log("📂 [AUTOLOAD] Loading session...");
    if (fs.existsSync(sessionsDir)) {
        const folders = fs.readdirSync(sessionsDir);
        for (const folder of folders) {
            if (folder.startsWith('session_')) {
                const phoneNumber = folder.replace('session_', '');
                console.log(`🔄 Reloading auto : ${phoneNumber}`);
                await startUserBot(phoneNumber);
                await delay(5000); // 5 secondes entre chaque compte pour la sécurité
            }
        }
    }
}

// CONFIGURATION API
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ✅ FIX: Pairing code is now generated inside startUserBot immediately
// after socket creation — no more 8s blind delay in the route
app.get("/pair", async (req, res) => {
    const num = req.query.number?.replace(/[^0-9]/g, '');
    if (!num) return res.json({ error: "No number provided." });
    try {
        const { code } = await startUserBot(num, true);
        if (code) {
            res.json({ code });
        } else {
            res.json({ error: "Could not generate pairing code. Number may already be registered." });
        }
    } catch (e) {
        console.error("Pair error:", e);
        res.json({ error: "Server error or incorrect number format." });
    }
});

// Sessions count endpoint for frontend display
app.get("/sessions/count", (req, res) => {
    const count = Object.keys(tempSocks).length;
    res.json({ count });
});

// Health check endpoint for frontend display
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

// --- DÉMARRAGE GLOBAL ---
app.listen(port, async () => {
    console.log(`🌐 NULL CRASH IS READY ON : http://localhost:${port}`);
    await restoreSessions();
});
