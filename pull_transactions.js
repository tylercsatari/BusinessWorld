const cloud = require('./cloud-storage');
const fs = require('fs');
require('dotenv').config();

async function main() {
    cloud.initR2();
    try {
        // Try to get plaid connection data
        const connBuf = await cloud.downloadFromR2('finance/plaid-connection.json');
        if (connBuf) {
            const conn = JSON.parse(connBuf.toString());
            console.log('Connection keys:', Object.keys(conn));
            if (conn.transactions) {
                console.log('Transaction count:', conn.transactions.length);
                fs.writeFileSync('/tmp/transactions_raw.json', JSON.stringify(conn.transactions, null, 2));
                console.log('Written to /tmp/transactions_raw.json');
            } else {
                console.log('No transactions key, full keys:', JSON.stringify(Object.keys(conn)));
                fs.writeFileSync('/tmp/plaid_conn.json', JSON.stringify(conn, null, 2));
            }
        } else {
            console.log('No plaid connection found in R2');
        }
    } catch(e) {
        console.error('Error:', e.message);
    }

    try {
        const metaBuf = await cloud.downloadFromR2('finance/transaction-meta.json');
        if (metaBuf) {
            const meta = JSON.parse(metaBuf.toString());
            console.log('Meta keys:', Object.keys(meta));
            fs.writeFileSync('/tmp/transaction_meta.json', JSON.stringify(meta, null, 2));
        }
    } catch(e) {
        console.error('Meta error:', e.message);
    }
}
main();
