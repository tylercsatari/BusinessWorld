require('dotenv').config();
const cloud = require('./cloud-storage');
const https = require('https');
const fs = require('fs');

function plaidPost(path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const opts = {
            hostname: 'production.plaid.com',
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
            }
        };
        const req = https.request(opts, res => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                try { resolve(JSON.parse(buf)); }
                catch(e) { reject(new Error('Parse error: ' + buf.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function main() {
    cloud.initR2();
    const connBuf = await cloud.downloadFromR2('finance/plaid-connection.json');
    const conn = JSON.parse(connBuf.toString());
    const { accessToken } = conn;
    console.log('Got access token');

    const base = {
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        access_token: accessToken,
    };

    // Fetch all transactions — Plaid allows up to 500 at a time
    let allTx = [];
    let offset = 0;
    let total = null;

    // Use transactions/get with date range (last 12 months)
    const now = new Date();
    const start = new Date(now);
    start.setFullYear(start.getFullYear() - 1);
    const endDate = now.toISOString().slice(0, 10);
    const startDate = start.toISOString().slice(0, 10);

    console.log(`Fetching transactions ${startDate} to ${endDate}...`);

    do {
        const res = await plaidPost('/transactions/get', {
            ...base,
            start_date: startDate,
            end_date: endDate,
            options: { count: 500, offset }
        });

        if (res.error_code) {
            console.error('Plaid error:', res.error_code, res.error_message);
            // Try sync instead
            break;
        }

        const txs = res.transactions || [];
        allTx = allTx.concat(txs);
        total = res.total_transactions;
        offset += txs.length;
        console.log(`  Fetched ${allTx.length} / ${total}`);
    } while (allTx.length < total);

    // Also get accounts
    const accountsRes = await plaidPost('/accounts/get', base);
    const accounts = accountsRes.accounts || [];
    console.log('Accounts:', accounts.map(a => `${a.name} (${a.subtype}): $${a.balances.current}`).join('\n  '));

    const out = { transactions: allTx, accounts, fetchedAt: new Date().toISOString(), startDate, endDate };
    fs.writeFileSync('/tmp/transactions_raw.json', JSON.stringify(out, null, 2));
    console.log(`\nTotal transactions: ${allTx.length}`);
    console.log('Written to /tmp/transactions_raw.json');

    // Show sample
    if (allTx.length > 0) {
        console.log('\nSample transaction:', JSON.stringify(allTx[0], null, 2));
    }
}

main().catch(e => { console.error(e); process.exit(1); });
