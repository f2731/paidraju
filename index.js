require('dotenv').config();
const {
    DisconnectReason,
    jidNormalizedUser,
    proto,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    makeInMemoryStore,
    useMultiFileAuthState,
    makeWASocket,
    Browsers
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');
const P = require('pino');
const QRCode = require('qrcode');

const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase } = require('./wasilib/database');
const config = require('./wasi');
const { cleanTempFiles } = require('./wasilib/cleaner');

// Load persistent config
try {
    if (fs.existsSync(path.join(__dirname, 'botConfig.json'))) {
        const savedConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'botConfig.json')));
        Object.assign(config, savedConfig);
    }
} catch (e) {
    console.error('Failed to load botConfig.json:', e);
}

const wasi_app = express();
const wasi_port = process.env.PORT || 3000;

// -----------------------------------------------------------------------------
// SESSION STATE
// -----------------------------------------------------------------------------
const sessions = new Map();
const qrTimeouts = new Map();
const keepAliveIntervals = new Map(); // NEW: Keep-alive intervals

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));
// Auto Clear Memory every 30 minutes
setInterval(() => {
    try {
        cleanTempFiles(true);
    } catch (e) {
        console.error('Auto clean error:', e.message);
    }
}, 30 * 60 * 1000);

// -----------------------------------------------------------------------------
// AUTO FORWARD CONFIGURATION
// -----------------------------------------------------------------------------
const SOURCE_JIDS = process.env.SOURCE_JIDS
    ? process.env.SOURCE_JIDS.split(',')
    : [];

const TARGET_JIDS = process.env.TARGET_JIDS
    ? process.env.TARGET_JIDS.split(',')
    : [];

const OLD_TEXT_REGEX = process.env.OLD_TEXT_REGEX
    ? process.env.OLD_TEXT_REGEX.split(',').map(pattern => {
        try {
            return pattern.trim() ? new RegExp(pattern.trim(), 'gu') : null;
        } catch (e) {
            console.error(`Invalid regex pattern: ${pattern}`, e);
            return null;
        }
      }).filter(regex => regex !== null)
    : [];

const NEW_TEXT = process.env.NEW_TEXT
    ? process.env.NEW_TEXT
    : '';

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS FOR MESSAGE CLEANING
// -----------------------------------------------------------------------------

function cleanForwardedLabel(message) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(message));
        
        if (cleanedMessage.extendedTextMessage?.contextInfo) {
            cleanedMessage.extendedTextMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.extendedTextMessage.contextInfo.forwardingScore) {
                cleanedMessage.extendedTextMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.imageMessage?.contextInfo) {
            cleanedMessage.imageMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.imageMessage.contextInfo.forwardingScore) {
                cleanedMessage.imageMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.videoMessage?.contextInfo) {
            cleanedMessage.videoMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.videoMessage.contextInfo.forwardingScore) {
                cleanedMessage.videoMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.audioMessage?.contextInfo) {
            cleanedMessage.audioMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.audioMessage.contextInfo.forwardingScore) {
                cleanedMessage.audioMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.documentMessage?.contextInfo) {
            cleanedMessage.documentMessage.contextInfo.isForwarded = false;
            if (cleanedMessage.documentMessage.contextInfo.forwardingScore) {
                cleanedMessage.documentMessage.contextInfo.forwardingScore = 0;
            }
        }
        
        if (cleanedMessage.protocolMessage) {
            if (cleanedMessage.protocolMessage.type === 14 || 
                cleanedMessage.protocolMessage.type === 26) {
                if (cleanedMessage.protocolMessage.historySyncNotification) {
                    const syncData = cleanedMessage.protocolMessage.historySyncNotification;
                    if (syncData.pushName) {
                        console.log('Newsletter from:', syncData.pushName);
                    }
                }
            }
        }
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error cleaning forwarded label:', error);
        return message;
    }
}

function cleanNewsletterText(text) {
    if (!text) return text;
    
    const newsletterMarkers = [
        /📢\s*/g,
        /🔔\s*/g,
        /📰\s*/g,
        /🗞️\s*/g,
        /\[NEWSLETTER\]/gi,
        /\[BROADCAST\]/gi,
        /\[ANNOUNCEMENT\]/gi,
        /Newsletter:/gi,
        /Broadcast:/gi,
        /Announcement:/gi,
        /Forwarded many times/gi,
        /Forwarded message/gi,
        /This is a broadcast message/gi
    ];
    
    let cleanedText = text;
    newsletterMarkers.forEach(marker => {
        cleanedText = cleanedText.replace(marker, '');
    });
    
    cleanedText = cleanedText.trim();
    return cleanedText;
}

function replaceCaption(caption) {
    if (!caption) return caption;
    if (!OLD_TEXT_REGEX.length || !NEW_TEXT) return caption;
    
    let result = caption;
    
    OLD_TEXT_REGEX.forEach(regex => {
        result = result.replace(regex, NEW_TEXT);
    });
    
    return result;
}

function processAndCleanMessage(originalMessage) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(originalMessage));
        cleanedMessage = cleanForwardedLabel(cleanedMessage);
        
        const text = cleanedMessage.conversation ||
            cleanedMessage.extendedTextMessage?.text ||
            cleanedMessage.imageMessage?.caption ||
            cleanedMessage.videoMessage?.caption ||
            cleanedMessage.documentMessage?.caption || '';
        
        if (text) {
            const cleanedText = cleanNewsletterText(text);
            
            if (cleanedMessage.conversation) {
                cleanedMessage.conversation = cleanedText;
            } else if (cleanedMessage.extendedTextMessage?.text) {
                cleanedMessage.extendedTextMessage.text = cleanedText;
            } else if (cleanedMessage.imageMessage?.caption) {
                cleanedMessage.imageMessage.caption = replaceCaption(cleanedText);
            } else if (cleanedMessage.videoMessage?.caption) {
                cleanedMessage.videoMessage.caption = replaceCaption(cleanedText);
            } else if (cleanedMessage.documentMessage?.caption) {
                cleanedMessage.documentMessage.caption = replaceCaption(cleanedText);
            }
        }
        
        delete cleanedMessage.protocolMessage;
        
        if (cleanedMessage.extendedTextMessage?.contextInfo?.participant) {
            const participant = cleanedMessage.extendedTextMessage.contextInfo.participant;
            if (participant.includes('newsletter') || participant.includes('broadcast')) {
                delete cleanedMessage.extendedTextMessage.contextInfo.participant;
                delete cleanedMessage.extendedTextMessage.contextInfo.stanzaId;
                delete cleanedMessage.extendedTextMessage.contextInfo.remoteJid;
            }
        }
        
        if (cleanedMessage.extendedTextMessage) {
            cleanedMessage.extendedTextMessage.contextInfo = cleanedMessage.extendedTextMessage.contextInfo || {};
            cleanedMessage.extendedTextMessage.contextInfo.isForwarded = false;
            cleanedMessage.extendedTextMessage.contextInfo.forwardingScore = 0;
        }
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error processing message:', error);
        return originalMessage;
    }
}

// -----------------------------------------------------------------------------
// COMMAND HANDLER FUNCTIONS
// -----------------------------------------------------------------------------

async function handlePingCommand(sock, from) {
    await sock.sendMessage(from, { text: "Love You😘" });
    console.log(`Ping command executed for ${from}`);
}

async function handleJidCommand(sock, from) {
    await sock.sendMessage(from, { text: `${from}` });
    console.log(`JID command executed for ${from}`);
}

async function handleGjidCommand(sock, from) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        
        let response = "📌 *Groups List:*\n\n";
        let groupCount = 1;
        
        for (const [jid, group] of Object.entries(groups)) {
            const groupName = group.subject || "Unnamed Group";
            const participantsCount = group.participants ? group.participants.length : 0;
            
            let groupType = "Simple Group";
            if (group.isCommunity) {
                groupType = "Community";
            } else if (group.isCommunityAnnounce) {
                groupType = "Community Announcement";
            } else if (group.parentGroup) {
                groupType = "Subgroup";
            }
            
            response += `${groupCount}. *${groupName}*\n`;
            response += `   👥 Members: ${participantsCount}\n`;
            response += `   🆔: \`${jid}\`\n`;
            response += `   📝 Type: ${groupType}\n`;
            response += `   ──────────────\n\n`;
            
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
        await sock.sendMessage(from, { 
            text: "❌ Error fetching groups list. Please try again later." 
        });
    }
}

async function processCommand(sock, msg) {
    const from = msg.key.remoteJid;
    const text = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";
    
    if (!text || !text.startsWith('!')) return;
    
    const command = text.trim().toLowerCase();
    
    try {
        if (command === '!ping') {
            await handlePingCommand(sock, from);
        } 
        else if (command === '!jid') {
            await handleJidCommand(sock, from);
        }
        else if (command === '!gjid') {
            await handleGjidCommand(sock, from);
        }
    } catch (error) {
        console.error('Command execution error:', error);
    }
}

// -----------------------------------------------------------------------------
// KEEP-ALIVE MECHANISM - PREVENTS 50-MINUTE TIMEOUT
// -----------------------------------------------------------------------------
function startKeepAlive(sessionId, sock) {
    // Clear existing interval
    if (keepAliveIntervals.has(sessionId)) {
        clearInterval(keepAliveIntervals.get(sessionId));
        keepAliveIntervals.delete(sessionId);
    }
    
    console.log(`🔄 Starting keep-alive for session: ${sessionId}`);
    
    // Send presence every 30 seconds to keep connection alive
    const interval = setInterval(async () => {
        try {
            const session = sessions.get(sessionId);
            if (!session || !session.isConnected || !session.sock) {
                clearInterval(interval);
                keepAliveIntervals.delete(sessionId);
                return;
            }
            
            // Send presence available
            await session.sock.sendPresenceAvailable();
            
            // Also send read receipt for any pending messages (optional)
            // This keeps the WebSocket connection active
        } catch (error) {
            // Silent fail - will try again next interval
            if (error.message?.includes('reconnecting')) {
                // Connection is reconnecting, clear interval
                clearInterval(interval);
                keepAliveIntervals.delete(sessionId);
            }
        }
    }, 30000); // Every 30 seconds
    
    keepAliveIntervals.set(sessionId, interval);
}

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT WITH ENHANCED RECONNECTION
// -----------------------------------------------------------------------------
async function startSession(sessionId) {
    // Clear any existing QR timeout for this session
    if (qrTimeouts.has(sessionId)) {
        clearTimeout(qrTimeouts.get(sessionId));
        qrTimeouts.delete(sessionId);
    }
    
    // Clear keep-alive if exists
    if (keepAliveIntervals.has(sessionId)) {
        clearInterval(keepAliveIntervals.get(sessionId));
        keepAliveIntervals.delete(sessionId);
    }

    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) {
            console.log(`Session ${sessionId} is already connected.`);
            // Ensure keep-alive is running
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
                
                // Set timeout to regenerate QR if not scanned within 2 minutes
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
                
                // Clear keep-alive on disconnect
                if (keepAliveIntervals.has(sessionId)) {
                    clearInterval(keepAliveIntervals.get(sessionId));
                    keepAliveIntervals.delete(sessionId);
                }
                
                // Clear QR timeout
                if (qrTimeouts.has(sessionId)) {
                    clearTimeout(qrTimeouts.get(sessionId));
                    qrTimeouts.delete(sessionId);
                }
                
                const statusCode = (lastDisconnect?.error instanceof Boom) ?
                    lastDisconnect.error.output.statusCode : 500;

                // Check if it's a logout or auth failure
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || 
                                   statusCode === 440 ||
                                   lastDisconnect?.error?.message?.includes('401');

                if (isLoggedOut) {
                    console.log(`❌ Session ${sessionId} logged out. Removing session.`);
                    sessions.delete(sessionId);
                    await wasi_clearSession(sessionId);
                    return;
                }

                // Regular reconnection with exponential backoff
                const delay = Math.min(3000 * Math.pow(1.5, sessionState.reconnectAttempts), 30000);
                sessionState.reconnectAttempts += 1;

                console.log(`Session ${sessionId}: Connection closed, reconnecting in ${delay}ms (attempt ${sessionState.reconnectAttempts})`);

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
                
                // Clear QR timeout on successful connection
                if (qrTimeouts.has(sessionId)) {
                    clearTimeout(qrTimeouts.get(sessionId));
                    qrTimeouts.delete(sessionId);
                }
                
                console.log(`✅ ${sessionId}: Connected to WhatsApp`);
                
                // START KEEP-ALIVE TO PREVENT TIMEOUT
                startKeepAlive(sessionId, wasi_sock);
                
                // Send presence available
                try {
    if (wasi_sock?.authState?.creds?.registered) {
        await wasi_sock.sendPresenceAvailable();
    }
} catch (e) {
    // Ignore presence errors
}
            }
        });

        wasi_sock.ev.on('creds.update', saveCreds);

        // AUTO FORWARD MESSAGE HANDLER (ALL COUNTRY NUMBER SUPPORT)
// AUTO FORWARD HANDLER (100+ BULK ALBUM & HEAVY MEDIA SUPPORT)
wasi_sock.ev.on('messages.upsert', async wasi_m => {
    const wasi_msg = wasi_m.messages[0];
    if (!wasi_msg || !wasi_msg.message) return;

    // Heroku Config Settings (Toggle Options)
    const ALLOW_TEXT = process.env.ALLOW_TEXT !== 'false';
    const ALLOW_IMAGES = process.env.ALLOW_IMAGES !== 'false';
    const ALLOW_VIDEOS = process.env.ALLOW_VIDEOS !== 'false';
    const ALLOW_DOCUMENTS = process.env.ALLOW_DOCUMENTS !== 'false';
    const ALLOW_AUDIO = process.env.ALLOW_AUDIO !== 'false';
    const ALLOW_STICKERS = process.env.ALLOW_STICKERS === 'true';

    const cleanJid = (id) => id ? id.replace(/:(?:[0-9]+)@/, '@').trim() : '';
    const wasi_origin = cleanJid(wasi_msg.key.remoteJid);
    const cleanedSources = (SOURCE_JIDS || []).map(cleanJid);

    // Command Processing (!ping etc.)
    await processCommand(wasi_sock, wasi_msg);

    // Auto Forward Trigger
    if (cleanedSources.includes(wasi_origin)) {
        try {
            let baseMsg = wasi_msg.message;

            // Unwrap ViewOnce Messages
            if (baseMsg?.viewOnceMessageV2?.message) baseMsg = baseMsg.viewOnceMessageV2.message;
            if (baseMsg?.viewOnceMessage?.message) baseMsg = baseMsg.viewOnceMessage.message;

            // Extract All Messages From Heavy/Large Album Arrays
            let rawMessages = [];
            if (baseMsg?.albumMessage?.messages && Array.isArray(baseMsg.albumMessage.messages)) {
                rawMessages = baseMsg.albumMessage.messages;
            } else if (baseMsg?.messageContextInfo?.albumMessage?.messages && Array.isArray(baseMsg.messageContextInfo.albumMessage.messages)) {
                rawMessages = baseMsg.messageContextInfo.albumMessage.messages;
            } else {
                rawMessages.push(wasi_msg.message);
            }

            console.log(`📦 Processing ${rawMessages.length} item(s) from ${wasi_origin}`);

            // Loop Through Every Single Item in Album (Unlimited Limit)
            for (let i = 0; i < rawMessages.length; i++) {
                const item = rawMessages[i];
                let currentMsg = item.message || item;

                // Media Filters Check
                const isText = !!(currentMsg.conversation || currentMsg.extendedTextMessage);
                const isImage = !!currentMsg.imageMessage;
                const isVideo = !!currentMsg.videoMessage;
                const isDocument = !!currentMsg.documentMessage;
                const isAudio = !!(currentMsg.audioMessage || currentMsg.voiceMessage);
                const isSticker = !!currentMsg.stickerMessage;

                if (isText && !ALLOW_TEXT) continue;
                if (isImage && !ALLOW_IMAGES) continue;
                if (isVideo && !ALLOW_VIDEOS) continue;
                if (isDocument && !ALLOW_DOCUMENTS) continue;
                if (isAudio && !ALLOW_AUDIO) continue;
                if (isSticker && !ALLOW_STICKERS) continue;

                // Process Clean Message & Remove Caption Links if configured
                let cleanPayload = typeof processAndCleanMessage === 'function' 
                    ? processAndCleanMessage(currentMsg) 
                    : currentMsg;

                if (!cleanPayload) cleanPayload = currentMsg;

                // Relay To All Targets
                for (const targetJid of TARGET_JIDS) {
                    try {
                        await wasi_sock.relayMessage(
                            targetJid,
                            cleanPayload,
                            { messageId: wasi_sock.generateMessageTag() }
                        );

                        console.log(`⚡ Forwarded Item [${i + 1}/${rawMessages.length}] to ${targetJid}`);

                        // Essential Delay For 100+ Videos to Prevent Rate-Limit/Crash
                        const delayTime = isVideo ? 1500 : 500;
                        await new Promise(res => setTimeout(res, delayTime));

                    } catch (err) {
                        console.error(`Error forwarding item ${i + 1} to ${targetJid}:`, err.message);
                    }
                }
            }
        } catch (err) {
            console.error('Relay Heavy Album Error:', err.message);
        }
    }
});

        // Handle socket errors
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

// -----------------------------------------------------------------------------
// API ROUTES
// -----------------------------------------------------------------------------

// API: GET STATUS
wasi_app.get('/api/status', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
    const session = sessions.get(sessionId);

    let qrDataUrl = null;
    let connected = false;
    let dbConnected = false;

    if (config.mongoDbUrl) {
        try {
            dbConnected = true;
        } catch (e) {
            dbConnected = false;
        }
    }

    if (session) {
        connected = session.isConnected;
        if (session.qr) {
            try {
                qrDataUrl = await QRCode.toDataURL(session.qr, { width: 256 });
            } catch (e) { }
        }
    }

    const isConnecting = session?.isConnecting || false;
    const hasKeepAlive = keepAliveIntervals.has(sessionId);

    res.json({
        sessionId,
        connected,
        isConnecting,
        qr: qrDataUrl,
        qrAvailable: !!session?.qr,
        dbConnected,
        dbConfigured: !!config.mongoDbUrl,
        phoneNumber: connected ? 'Connected ✅' : (isConnecting ? 'Connecting...' : 'Disconnected'),
        lastActive: new Date().toISOString(),
        keepAliveActive: hasKeepAlive,
        uptime: session?.lastConnectionTime ? Math.floor((Date.now() - session.lastConnectionTime) / 1000) + 's' : 'N/A',
        activeSessions: Array.from(sessions.keys()).map(id => ({
            id,
            connected: sessions.get(id)?.isConnected || false,
            hasQR: !!sessions.get(id)?.qr,
            keepAlive: keepAliveIntervals.has(id)
        }))
    });
});

// API: GENERATE NEW QR
wasi_app.post('/api/generate-qr', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
        const session = sessions.get(sessionId);
        
        // Clear keep-alive
        if (keepAliveIntervals.has(sessionId)) {
            clearInterval(keepAliveIntervals.get(sessionId));
            keepAliveIntervals.delete(sessionId);
        }
        
        if (session && session.sock) {
            session.sock.end(undefined);
            setTimeout(() => {
                startSession(sessionId);
            }, 1000);
            res.json({ success: true, message: 'Generating new QR code...' });
        } else {
            startSession(sessionId);
            res.json({ success: true, message: 'Starting session with new QR...' });
        }
    } catch (error) {
        console.error('Generate QR error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: RESTART BOT
wasi_app.post('/api/restart', async (req, res) => {
    try {
        console.log('🔄 Restarting bot...');
        
        // Clear all keep-alive intervals
        for (const [sessionId, interval] of keepAliveIntervals) {
            clearInterval(interval);
        }
        keepAliveIntervals.clear();
        
        // Clear all QR timeouts
        for (const [sessionId, timeout] of qrTimeouts) {
            clearTimeout(timeout);
        }
        qrTimeouts.clear();
        
        // Clear all sessions
        for (const [sessionId, session] of sessions) {
            if (session.sock) {
                try {
                    session.sock.end(undefined);
                } catch (e) {
                    console.error(`Error ending session ${sessionId}:`, e);
                }
            }
        }
        sessions.clear();
        
        setTimeout(() => {
            main().catch(err => console.error('Restart error:', err));
        }, 1000);
        
        res.json({ success: true, message: 'Bot restarting...' });
    } catch (error) {
        console.error('Restart error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: LOGOUT
wasi_app.post('/api/logout', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
        const session = sessions.get(sessionId);
        
        // Clear keep-alive
        if (keepAliveIntervals.has(sessionId)) {
            clearInterval(keepAliveIntervals.get(sessionId));
            keepAliveIntervals.delete(sessionId);
        }
        
        // Clear QR timeout
        if (qrTimeouts.has(sessionId)) {
            clearTimeout(qrTimeouts.get(sessionId));
            qrTimeouts.delete(sessionId);
        }
        
        if (session && session.sock) {
            try {
                await session.sock.logout();
            } catch (e) {
                console.error('Logout error:', e);
            }
            sessions.delete(sessionId);
            await wasi_clearSession(sessionId);
        }
        
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: GET SESSIONS LIST
wasi_app.get('/api/sessions', async (req, res) => {
    try {
        const sessionList = Array.from(sessions.keys()).map(id => ({
            sessionId: id,
            isConnected: sessions.get(id)?.isConnected || false,
            hasQR: !!sessions.get(id)?.qr,
            isConnecting: sessions.get(id)?.isConnecting || false,
            keepAliveActive: keepAliveIntervals.has(id)
        }));
        
        res.json({
            success: true,
            sessions: sessionList,
            total: sessionList.length,
            activeKeepAlives: keepAliveIntervals.size
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API: HEALTH CHECK
wasi_app.get('/api/health', async (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        sessions: sessions.size,
        qrTimeouts: qrTimeouts.size,
        keepAliveCount: keepAliveIntervals.size
    });
});

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------------------------------------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`📡 Auto Forward: ${SOURCE_JIDS.length} source(s) → ${TARGET_JIDS.length} target(s)`);
        console.log(`✨ Message Cleaning: Forwarded labels removed, Newsletter markers cleaned`);
        console.log(`🤖 Bot Commands: !ping, !jid, !gjid`);
        console.log(`🔄 Keep-Alive: Active (prevents 50-min timeout)`);
        console.log(`\n📌 API Endpoints:`);
        console.log(`   GET  /api/status      - Get bot status`);
        console.log(`   POST /api/generate-qr - Generate new QR code`);
        console.log(`   POST /api/restart     - Restart bot`);
        console.log(`   POST /api/logout      - Logout bot`);
        console.log(`   GET  /api/sessions    - List all sessions`);
        console.log(`   GET  /api/health      - Health check`);
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------
async function main() {
    // 1. Connect DB if configured
    if (config.mongoDbUrl) {
        const dbResult = await wasi_connectDatabase(config.mongoDbUrl);
        if (dbResult) {
            console.log('✅ Database connected');
        }
    }

    // 2. Start default session
    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    // 3. Start server
    wasi_startServer();
}

// Handle process termination
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down...');
    for (const [sessionId, interval] of keepAliveIntervals) {
        clearInterval(interval);
    }
    for (const [sessionId, timeout] of qrTimeouts) {
        clearTimeout(timeout);
    }
    for (const [sessionId, session] of sessions) {
        if (session.sock) {
            try {
                await session.sock.end(undefined);
            } catch (e) {}
        }
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 Shutting down...');
    for (const [sessionId, interval] of keepAliveIntervals) {
        clearInterval(interval);
    }
    for (const [sessionId, timeout] of qrTimeouts) {
        clearTimeout(timeout);
    }
    for (const [sessionId, session] of sessions) {
        if (session.sock) {
            try {
                await session.sock.end(undefined);
            } catch (e) {}
        }
    }
    process.exit(0);
});

main();
