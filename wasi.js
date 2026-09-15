require('dotenv').config();

module.exports = {
    sessionId: process.env.SESSION_ID || '',
    mongoDbUrl: process.env.MONGODB_URI || process.env.MONGODB_URL || '',
    PHONE_NUMBER: process.env.PHONE_NUMBER || '92301782626'
};

