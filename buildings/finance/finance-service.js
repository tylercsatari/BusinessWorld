// finance-service.js
// Handles Plaid API calls and transaction storage in R2

const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

let plaidClient = null;

function initPlaid() {
    if (plaidClient) return;
    if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) return;
    const config = new Configuration({
        basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
        baseOptions: {
            headers: {
                'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
                'PLAID-SECRET': process.env.PLAID_SECRET
            }
        }
    });
    plaidClient = new PlaidApi(config);
}

function isConfigured() {
    return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

async function createLinkToken(userId) {
    initPlaid();
    const response = await plaidClient.linkTokenCreate({
        user: { client_user_id: userId },
        client_name: 'BusinessWorld Finance',
        products: [Products.Transactions],
        country_codes: [CountryCode.Ca],
        language: 'en'
    });
    return response.data.link_token;
}

async function exchangePublicToken(publicToken) {
    initPlaid();
    const response = await plaidClient.itemPublicTokenExchange({
        public_token: publicToken
    });
    return {
        accessToken: response.data.access_token,
        itemId: response.data.item_id
    };
}

async function getTransactions(accessToken, startDate, endDate) {
    initPlaid();
    const response = await plaidClient.transactionsGet({
        access_token: accessToken,
        start_date: startDate,
        end_date: endDate,
        options: { count: 500, offset: 0 }
    });
    let transactions = response.data.transactions;
    const total = response.data.total_transactions;
    // Paginate if needed
    while (transactions.length < total) {
        const page = await plaidClient.transactionsGet({
            access_token: accessToken,
            start_date: startDate,
            end_date: endDate,
            options: { count: 500, offset: transactions.length }
        });
        transactions = transactions.concat(page.data.transactions);
    }
    return transactions;
}

async function getAccounts(accessToken) {
    initPlaid();
    const response = await plaidClient.accountsGet({
        access_token: accessToken
    });
    return response.data.accounts;
}

// R2 persistence
async function savePlaidData(cloud, data) {
    const json = JSON.stringify(data);
    await cloud.uploadToR2('finance/plaid-connection.json', Buffer.from(json), 'application/json');
}

async function loadPlaidData(cloud) {
    try {
        const buf = await cloud.downloadFromR2('finance/plaid-connection.json');
        if (!buf) return null;
        return JSON.parse(buf.toString('utf8'));
    } catch (e) {
        return null;
    }
}

async function saveTransactionMeta(cloud, meta) {
    const json = JSON.stringify(meta);
    await cloud.uploadToR2('finance/transaction-meta.json', Buffer.from(json), 'application/json');
}

async function loadTransactionMeta(cloud) {
    try {
        const buf = await cloud.downloadFromR2('finance/transaction-meta.json');
        if (!buf) return null;
        return JSON.parse(buf.toString('utf8'));
    } catch (e) {
        return null;
    }
}

module.exports = {
    isConfigured,
    createLinkToken,
    exchangePublicToken,
    getTransactions,
    getAccounts,
    savePlaidData,
    loadPlaidData,
    saveTransactionMeta,
    loadTransactionMeta
};
