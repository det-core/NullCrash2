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

// __filename et __dirname sont déjà disponibles en CommonJS
// Pas besoin de les redéfinir

// Fonction jidDecode manuelle (remplacement)
function jidDecode(jid) {
    if (!jid) return null;
    const parts = jid.split('@');
    if (parts.length < 2) return { user: jid, server: 's.whatsapp.net' };
    return { 
        user: parts[0], 
        server: parts[1],
        toString: () => jid
    };
}

const app = express();
const port = 8000;
const sessionsDir = path.join(__dirname, 'accounts');

// Création du dossier de stockage si absent
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

let tempSocks = {};
global.msgStore = {};

const store = {
    messages: {},
    loadMessage: async (jid, id) => {
        return store.messages[jid]?.[id] || null;
    },
    bind: (ev) => {
        ev.on('messages.upsert', ({ messages }) => {
            for (const msg of messages) {
                const jid = msg.key.remoteJid;
                if (!store.messages[jid]) store.messages[jid] = {};
                store.messages[jid][msg.key.id] = msg;
            }
        });
    }
};

// ========== FUNCTION SMSG (Version complète) ==========
function smsg(conn, m, store) {
    if (!m) return m;
    
    try {
        // Parse message
        m.message = JSON.parse(JSON.stringify(m.message));
        m.key = m.key || {};
        
        // Basic info
        m.fromMe = m.key.fromMe || false;
        m.id = m.key.id;
        m.remoteJid = m.key.remoteJid;
        m.isGroup = m.remoteJid?.endsWith('@g.us') || false;
        
        // Sender
        m.sender = m.fromMe ? conn.user.id.split(':')[0] + '@s.whatsapp.net' : 
                   m.key.participant || m.key.remoteJid;
        
        // Message text extraction
        m.text = m.message?.conversation ||
                 m.message?.extendedTextMessage?.text ||
                 m.message?.imageMessage?.caption ||
                 m.message?.videoMessage?.caption ||
                 m.message?.documentMessage?.caption ||
                 m.message?.buttonsResponseMessage?.selectedButtonId ||
                 m.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
                 m.message?.templateButtonReplyMessage?.selectedId ||
                 m.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
                 "";
        
        // Push name
        m.pushName = m.pushName || m.notifyName || "";
        
        // Quoted message
        const quotedMsg = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quotedMsg) {
            m.quoted = {
                key: m.message?.extendedTextMessage?.contextInfo?.stanzaId,
                message: quotedMsg,
                sender: m.message?.extendedTextMessage?.contextInfo?.participant,
                text: quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || ""
            };
        }
        
        return m;
    } catch (err) {
        console.error("Error in smsg:", err);
        return m;
    }
}
// ========== FIN SMSG ==========

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

    const minato = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        }
    });

    tempSocks[sessionName] = minato;

    minato.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            const decode = jidDecode(jid) || {};
            return decode.user && decode.server && `${decode.user}@${decode.server}` || jid;
        }
        return jid;
    };

    minato.ev.on("messages.upsert", async chatUpdate => {
        try {
            const msg = chatUpdate.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
            const m = smsg(minato, msg, store);
            require("./handler")(minato, m, chatUpdate, store);
        } catch (err) {
            console.error("Error message scanning:", err.stack || err.message);
        }
    });

    // --- GESTION DE LA CONNEXION ---
    minato.ev.on("connection.update", async (update) => {
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
                await minato.newsletterFollow("120363419855570475@newsletter");
            } catch (err) {
                console.log("Newsletter follow failed:", err.message || err);
            }
            console.log(`✅ [${phoneNumber}] Session Connected !`);
            const userJid = minato.user.id.split(":")[0] + "@s.whatsapp.net";
            await minato.sendMessage(userJid, {
                image: { url: "https://files.catbox.moe/4w8x5f.png" },
                caption: 
`╭─────────────────⭓
│
│  ✅ NULL CRASH 
│
├─────────────────
│
│  👤 Owner: I'M NULL 
│
╰─────────────────⭓

> 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃 𝚂𝚈𝚂𝚃𝙴𝙼 ϟ`,
            });
        }
    });

    minato.ev.on("creds.update", saveCreds);
    return minato;
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

// Health check endpoint
app.get('/health', (req, res) => {
    const sessions = Object.keys(tempSocks).length;
    const status = {
        status: 'online',
        bot: 'Null',
        version: '1.0.0',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        sessions: sessions,
        memory: process.memoryUsage(),
        node_version: process.version
    };
    
    res.status(200).json(status);
});

app.get("/sessions/active", (req, res) => {
    try {
        const activeSessions = Array.from(global.sessionActive?.keys() || []);
        res.json({ count: activeSessions.length, sessions: activeSessions });
    } catch (e) {
        res.json({ count: 0, sessions: [] });
    }
});

app.get("/pair", async (req, res) => {
    const num = req.query.number;

    if (!num) {
        return res.json({ error: "Number required" });
    }

    try {
        const sock = await startUserBot(num, true);

        // wait for Baileys auth to initialize properly
        const waitForPairing = async () => {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error("Pairing timeout"));
                }, 15000);

                sock.ev.on("connection.update", async (update) => {
                    try {
                        if (!sock.authState?.creds?.registered) {
                            const code = await sock.requestPairingCode(num.trim());
                            clearTimeout(timeout);

                            resolve({
                                success: true,
                                code: code
                            });
                        }
                    } catch (err) {
                        clearTimeout(timeout);
                        reject(err);
                    }
                });
            });
        };

        const result = await waitForPairing();
        return res.json(result);

    } catch (e) {
        return res.json({
            success: false,
            error: e.message
        });
    }
});

// --- DÉMARRAGE GLOBAL ---
app.listen(port, async () => {
    console.log(`🌐 NUll CRASH IS READY ON : http://localhost:${port}`);
    await restoreSessions();
});a