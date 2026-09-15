const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const config = require('./wasi');
const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase } = require('./wasilib/db');

const wasi_app = express();
const wasi_port = process.env.PORT || 3000;

wasi_app.use(express.json());

// Global Sessions Store
const sessions = new Map();
const qrTimeouts = new Map();
const keepAliveIntervals = new Map();

// Helper: Clean JID to support all country codes & device suffix (:1, :2, etc.)
const cleanJid = (id) => {
    if (!id) return '';
    return id.replace(/:\d+@/, '@').trim();
};

// Target and Source JIDs
const SOURCE_JIDS = (process.env.SOURCE_JIDS || config.sourceJids || []).map(cleanJid);
const TARGET_JIDS = (process.env.TARGET_JIDS || config.targetJids || []).map(cleanJid);

// Function to process and clean messages (Removes Forwarded Tag & Newsletter Markers)
function processAndCleanMessage(message) {
    if (!message) return null;
    let cleanMsg = JSON.parse(JSON.stringify(message));

    const removeForwardedFlags = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        delete obj.contextInfo?.isForwarded;
        delete obj.contextInfo?.forwardingScore;
        delete obj.contextInfo?.forwardedNewsletterMessageInfo;
        for (let key in obj) {
            if (obj[key] && typeof obj[key] === 'object') {
                removeForwardedFlags(obj[key]);
            }
        }
    };

    removeForwardedFlags(cleanMsg);
    return cleanMsg;
}

// Function to replace captions / text if configured
function replaceCaption(text) {
    if (!text) return '';
    let result = text;
    if (config.replaceRules && Array.isArray(config.replaceRules)) {
        config.replaceRules.forEach(rule => {
            if (rule.from && rule.to !== undefined) {
                result = result.split(rule.from).join(rule.to);
            }
        });
    }
    return result;
}

// AUTO MEMORY CLEANUP FOR HEROKU (Every 10 minutes)
setInterval(() => {
    if (global.gc) {
        try {
            global.gc();
            console.log('🧹 Heroku Memory Automatically Cleared!');
        } catch (e) {
            console.error('Error during Garbage Collection:', e);
        }
    } else {
        console.log('💡 Memory auto-clean check active.');
    }
}, 10 * 60 * 1000);

// COMMAND HANDLERS
async function handlePingCommand(sock, from) {
    await sock.sendMessage(from, { text: "🏓 Pong! Bot is active and working." });
    console.log(`Ping command executed for ${from}`);
}

async function handleJidCommand(sock, from) {
    await sock.sendMessage(from, { text: `📍 Your JID: ${from}` });
    console.log(`JID command executed for ${from}`);
}

async function handleGjidCommand(sock, from) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        let response = "📋 *Groups List:*\n\n";
        let groupCount = 1;

        for (const [jid, group] of Object.entries(groups)) {
            const groupName = group.subject || "Unnamed Group";
            const participantsCount = group.participants ? group.participants.length : 0;
            
            let groupType = "Simple Group";
            if (group.isCommunity) groupType = "Community";
            else if (group.isCommunityAnnounce) groupType = "Community Announcement";
            else if (group.parentGroup) groupType = "Subgroup";

            response += `${groupCount}. *${groupName}*\n👥 Members: ${participantsCount}\n🆔 \`${jid}\`\n📝 Type: ${groupType}\n───────────────────\n\n`;
            groupCount++;
        }

        if (groupCount === 1) {
            response = "❌ No groups found. You are not in any groups.";
        } else {
            response += `\n*Total Groups: ${groupCount - 1}*`;
        }

        await sock.sendMessage(from, { text: response });
        console.log(`GJID command executed. Sent ${groupCount - 1} groups list.`);
    } catch (error) {
        console.error('Error fetching groups:', error);
        await sock.sendMessage(from, { text: "❌ Error fetching groups list. Please try again later." });
    }
}

async function processCommand(sock, msg) {
    const from = msg.key.remoteJid;
    const text = msg.message?.conversation ||
                 msg.message?.extendedTextMessage?.text ||
                 msg.message?.imageMessage?.caption ||
                 msg.message?.videoMessage?.caption || "";

    if (!text || !text.startsWith('!')) return;

    const command = text.trim().toLowerCase();

    try {
        if (command === '!ping') {
            await handlePingCommand(sock, from);
        } else if (command === '!jid') {
            await handleJidCommand(sock, from);
        } else if (command === '!gjid') {
            await handleGjidCommand(sock, from);
        }
    } catch (error) {
        console.error('Command execution error:', error);
    }
}

// KEEP-ALIVE MECHANISM - PREVENTS TIMEOUT
function startKeepAlive(sessionId, sock) {
    if (keepAliveIntervals.has(sessionId)) {
        clearInterval(keepAliveIntervals.get(sessionId));
        keepAliveIntervals.delete(sessionId);
    }

    console.log(`📡 Starting keep-alive for session: ${sessionId}`);

    const interval = setInterval(async () => {
        try {
            const session = sessions.get(sessionId);
            if (!session || !session.isConnected || !session.sock) {
                clearInterval(interval);
                keepAliveIntervals.delete(sessionId);
                return;
            }

            await session.sock.sendPresenceAvailable();
        } catch (error) {
            if (error.message?.includes('reconnecting')) {
                clearInterval(interval);
                keepAliveIntervals.delete(sessionId);
            }
        }
    }, 30000);

    keepAliveIntervals.set(sessionId, interval);
}

// SESSION MANAGEMENT WITH ENHANCED RECONNECTION
async function startSession(sessionId) {
    if (qrTimeouts.has(sessionId)) {
        clearTimeout(qrTimeouts.get(sessionId));
        qrTimeouts.delete(sessionId);
    }

    if (keepAliveIntervals.has(sessionId)) {
        clearInterval(keepAliveIntervals.get(sessionId));
        keepAliveIntervals.delete(sessionId);
    }

    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) {
            console.log(`Session ${sessionId} is already connected.`);
            startKeepAlive(sessionId, existing.sock);
            return;
        }

        if (existing.sock) {
            existing.sock.ev.removeAllListeners('connection.update');
            existing.sock.end(undefined);
            sessions.delete(sessionId);
        }
    }

    console.log(`🚀 Starting session: ${sessionId}`);

    const sessionState = {
        sock: null,
        isConnected: false,
        qr: null,
        reconnectAttempts: 0,
        lastQRTime: null,
        isConnecting: false,
        lastConnectionTime: null,
    };

    sessions.set(sessionId, sessionState);

    try {
        const { wasi_sock, saveCreds } = await wasi_connectSession(true, sessionId);
        sessionState.sock = wasi_sock;
        sessionState.isConnecting = true;

        wasi_sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                sessionState.qr = qr;
                sessionState.isConnected = false;
                sessionState.lastQRTime = Date.now();
                console.log(`📱 QR generated for session: ${sessionId}`);

                if (qrTimeouts.has(sessionId)) {
                    clearTimeout(qrTimeouts.get(sessionId));
                }

                const timeout = setTimeout(() => {
                    console.log(`⏰ QR code expired for session: ${sessionId}, regenerating...`);
                    if (!sessionState.isConnected && sessionState.sock) {
                        sessionState.sock.end(undefined);
                        setTimeout(() => {
                            startSession(sessionId);
                        }, 1000);
                    }
                }, 120000);

                qrTimeouts.set(sessionId, timeout);
            }

            if (connection === 'close') {
                sessionState.isConnected = false;
                sessionState.isConnecting = false;
                sessionState.lastConnectionTime = Date.now();

                if (keepAliveIntervals.has(sessionId)) {
                    clearInterval(keepAliveIntervals.get(sessionId));
                    keepAliveIntervals.delete(sessionId);
                }

                if (qrTimeouts.has(sessionId)) {
                    clearTimeout(qrTimeouts.get(sessionId));
                    qrTimeouts.delete(sessionId);
                }

                const statusCode = (lastDisconnect?.error?.output?.statusCode || 500);
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 440 || lastDisconnect?.error?.message?.includes('401');

                if (isLoggedOut) {
                    console.log(`❌ Session ${sessionId} logged out. Removing session.`);
                    sessions.delete(sessionId);
                    await wasi_clearSession(sessionId);
                    return;
                }

                const delay = Math.min(3000 * Math.pow(1.5, sessionState.reconnectAttempts), 30000);
                sessionState.reconnectAttempts += 1;

                console.log(`Session ${sessionId} Connection closed, reconnecting in ${delay/1000}s...`);

                setTimeout(() => {
                    if (!sessions.has(sessionId) || !sessions.get(sessionId).isConnected) {
                        startSession(sessionId);
                    }
                }, delay);

            } else if (connection === 'open') {
                sessionState.isConnected = true;
                sessionState.isConnecting = false;
                sessionState.qr = null;
                sessionState.reconnectAttempts = 0;
                sessionState.lastConnectionTime = Date.now();

                if (qrTimeouts.has(sessionId)) {
                    clearTimeout(qrTimeouts.get(sessionId));
                    qrTimeouts.delete(sessionId);
                }

                console.log(`✅ ${sessionId}: Connected to WhatsApp`);

                startKeepAlive(sessionId, wasi_sock);

                try {
                    if (wasi_sock.authState?.creds?.registered) {
                        await wasi_sock.sendPresenceAvailable();
                    }
                } catch (e) {
                    // Ignore presence errors
                }
            }
        });

        wasi_sock.ev.on('creds.update', saveCreds);

        // AUTO FORWARD MESSAGE HANDLER (ALL COUNTRY & ALBUM/VIDEO SUPPORT)
        wasi_sock.ev.on('messages.upsert', async wasi_m => {
            const wasi_msg = wasi_m.messages[0];
            if (!wasi_msg || !wasi_msg.message) return;

            const wasi_origin = cleanJid(wasi_msg.key.remoteJid);
            const cleanedSources = (SOURCE_JIDS || []).map(cleanJid);

            // Handle commands
            await processCommand(wasi_sock, wasi_msg);

            // AUTO FORWARD LOGIC
            if (cleanedSources.includes(wasi_origin)) {
                try {
                    let relayMsg = processAndCleanMessage(wasi_msg.message);
                    if (!relayMsg) return;

                    if (relayMsg.viewOnceMessageV2) relayMsg = relayMsg.viewOnceMessageV2.message;
                    if (relayMsg.viewOnceMessage) relayMsg = relayMsg.viewOnceMessage.message;

                    const isMedia = relayMsg.imageMessage ||
                                    relayMsg.videoMessage ||
                                    relayMsg.audioMessage ||
                                    relayMsg.documentMessage ||
                                    relayMsg.stickerMessage;

                    let isEmojiOnly = false;
                    if (relayMsg.conversation) {
                        const emojiRegex = /^(\p{Extended_Pictographic}|\s)+$/u;
                        isEmojiOnly = emojiRegex.test(relayMsg.conversation);
                    }

                    if (!isMedia && !isEmojiOnly && !relayMsg.conversation && !relayMsg.extendedTextMessage) return;

                    if (relayMsg.imageMessage?.caption) {
                        relayMsg.imageMessage.caption = replaceCaption(relayMsg.imageMessage.caption);
                    }
                    if (relayMsg.videoMessage?.caption) {
                        relayMsg.videoMessage.caption = replaceCaption(relayMsg.videoMessage.caption);
                    }
                    if (relayMsg.documentMessage?.caption) {
                        relayMsg.documentMessage.caption = replaceCaption(relayMsg.documentMessage.caption);
                    }
                    if (relayMsg.extendedTextMessage?.text) {
                        relayMsg.extendedTextMessage.text = replaceCaption(relayMsg.extendedTextMessage.text);
                    }
                    if (relayMsg.conversation) {
                        relayMsg.conversation = replaceCaption(relayMsg.conversation);
                    }

                    console.log(`📦 Forwarding item from ${wasi_origin}...`);

                    for (const targetJid of TARGET_JIDS) {
                        try {
                            await wasi_sock.relayMessage(
                                targetJid,
                                relayMsg,
                                { messageId: wasi_sock.generateMessageTag() }
                            );
                            console.log(`✅ Message/Media forwarded to ${targetJid}`);
                            
                            await new Promise(res => setTimeout(res, 1500));
                        } catch (err) {
                            console.error(`Failed to forward to ${targetJid}:`, err.message);
                        }
                    }

                } catch (err) {
                    console.error('Auto Forward Error:', err.message);
                }
            }
        });

        wasi_sock.ev.on('error', (error) => {
            console.error(`Socket error for session ${sessionId}:`, error);
        });

    } catch (error) {
        console.error(`Failed to start session ${sessionId}:`, error);
        setTimeout(() => {
            if (!sessions.has(sessionId) || !sessions.get(sessionId).isConnected) {
                startSession(sessionId);
            }
        }, 5000);
    }
}

// SERVER START
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`🚀 Auto Forward: ${SOURCE_JIDS.length} source(s) -> ${TARGET_JIDS.length} target(s)`);
        console.log(`⚙️ Multi-Country, Memory Auto-Clean & Album/Video Support Active`);
    });
}

// MAIN STARTUP
async function main() {
    if (config.mongoDbUrl) {
        const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
        if (dbResult) {
            console.log('✅ Database connected');
        }
    }

    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    wasi_startServer();
}

// Handle process termination
process.on('SIGINT', async () => {
    console.log('🔴 Shutting down...');
    for (const [sessionId, session] of sessions) {
        if (session.sock) {
            try { await session.sock.end(undefined); } catch (e) {}
        }
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🔴 Shutting down...');
    for (const [sessionId, session] of sessions) {
        if (session.sock) {
            try { await session.sock.end(undefined); } catch (e) {}
        }
    }
    process.exit(0);
});

main();
