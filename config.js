// Frontend configuration — NO API KEYS (those live in .env on the server)
// This file is loaded at startup, then /api/config fills in server-side values.
const CONFIG = {
    airtable: {
        boxesTable: 'Box',
        itemsTable: 'Items',
        itemsLinkField: 'Link To Box',
        boxesNameField: 'Name',
        itemsNameField: 'Name',
        itemsQuantityField: 'Quantity'
    },
    search: {
        semanticMatchThreshold: 0.75
    }
};

// Load server config on startup (non-secret values like table names, thresholds)
fetch('/api/config').then(r => r.json()).then(cfg => {
    if (cfg.airtable) Object.assign(CONFIG.airtable, cfg.airtable);
    if (cfg.search) Object.assign(CONFIG.search, cfg.search);
}).catch(() => {});
