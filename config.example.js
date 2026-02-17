// API Configuration
// Copy this file to config.js and fill in your real keys:
//   cp config.example.js config.js
//
// config.js is gitignored and will NOT be committed.

const CONFIG = {
    airtable: {
        token: 'YOUR_AIRTABLE_PERSONAL_ACCESS_TOKEN',
        baseId: 'YOUR_AIRTABLE_BASE_ID',
        boxesTable: 'Box',
        itemsTable: 'Items',
        itemsLinkField: 'Link To Box',
        boxesNameField: 'Name',
        itemsNameField: 'Name',
        itemsQuantityField: 'Quantity'
    },
    openai: {
        apiKey: 'YOUR_OPENAI_API_KEY',
        chatModel: 'gpt-4o',
        embeddingModel: 'text-embedding-3-small',
        embeddingDimensions: 512,
        ttsModel: 'gpt-4o-mini-tts',
        ttsVoice: 'alloy'
    },
    pinecone: {
        apiKey: 'YOUR_PINECONE_API_KEY',
        host: 'YOUR_PINECONE_INDEX_HOST_URL',
        namespace: 'inventory'
    },
    search: {
        semanticMatchThreshold: 0.75
    }
};
