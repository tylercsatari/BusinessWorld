/* ── Chocolate Bar UI ── BusinessWorld Dark Aesthetic ── */
const ChocolateBarUI = (() => {
    let container = null;
    let activeTab = 'dashboard';
    let editingTaskId = null;
    let notesSaveTimer = null;

    const STORAGE_KEY = 'chocolatebar-data';

    const CATEGORIES = ['fulfillment', 'distribution', 'marketing', 'retail', 'other'];
    const PRIORITIES = ['high', 'medium', 'low'];
    const STATUSES = ['todo', 'in-progress', 'done'];

    const CATEGORY_ICONS = {
        fulfillment: '\u{1F4E6}', distribution: '\u{1F6E3}', marketing: '\u{1F4E3}',
        retail: '\u{1F6D2}', other: '\u{2699}'
    };

    const TAB_ICONS = {
        dashboard: '<svg viewBox="0 0 24 24"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>',
        fulfillment: '<svg viewBox="0 0 24 24"><path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4z"/></svg>',
        tasks:    '<svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>',
        distribution: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>',
        notes:    '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
    };

    const TABS = [
        { id: 'dashboard', label: 'Dashboard' },
        { id: 'fulfillment', label: 'Fulfillment' },
        { id: 'tasks', label: 'Tasks' },
        { id: 'distribution', label: 'Channels' },
        { id: 'notes', label: 'Notes' }
    ];

    /* ── Real Product Data (Shopify API + COGS Spreadsheet, 2026-04-01) ── */
    /* COGS from "Chocolate Bar Costs" spreadsheet - per bar breakdown:
       Stella Manufacturing: CHF $1.62 = CAD $2.84/bar (12,936 units, $36,673.56 CAD total)
       Protein cost: $9,250/200kg = $46/kg = $0.71506/bar
       Shipping + duties: $27,000 total = $2.08720/bar
       Packaging cases (2500): $3,420 = $0.46266/bar
       Total per bar: $6.08693 CAD
       Working COGS (from spreadsheet profit column): $3.95/bar USD */
    const COGS_PER_BAR = 3.95; // USD, derived from spreadsheet profit calculations
    const PRODUCTS = [
        { name: '4 Pack',  price: 44.99, subPrice: 35.99, sku: '4pack', cogs: 15.81, weight: 280, inventory: -133, orders90d: 139, revenue90d: 5203.34, pctRevenue: 48.5, pctOrders: 72 },
        { name: '12 Pack', price: 93.75, subPrice: 75.00, sku: '0012',  cogs: 47.43, weight: 750, inventory: 956,  orders90d: 41,  revenue90d: 3257.53, pctRevenue: 30.4, pctOrders: 21 },
        { name: '36 Pack', price: 249.00, subPrice: 198.20, sku: '0014', cogs: 142.29, weight: 2100, inventory: -485, orders90d: 13,  revenue90d: 2354.81, pctRevenue: 22.0, pctOrders: 7 },
        { name: 'Subscription', price: 70.00, subPrice: 70.00, sku: 'sub', cogs: 47.43, weight: 750, inventory: null, orders90d: 2, revenue90d: 139.98, pctRevenue: 1.3, pctOrders: 1 }
    ];

    /* ── Shopify Stats (API pull, last 90 days: Jan 1 - Mar 31 2026) ── */
    const SHOPIFY = {
        totalOrders: 192,
        totalRevenue: 10728.86,
        avgOrderValue: 55.88,
        shippingCharged: 1167.55,
        uniqueCustomers: 151,
        repeatCustomers: 24,
        repeatRate: 15.9,
        fulfilled: 179,
        unfulfilled: 13,
        freeShipOrders: 128,
        paidShipOrders: 64,
        topStates: [
            { state: 'TX', orders: 19 }, { state: 'FL', orders: 14 }, { state: 'CA', orders: 13 },
            { state: 'NJ', orders: 12 }, { state: 'NY', orders: 11 }, { state: 'UK', orders: 10 }
        ]
    };

    /* ── ShipBob Fulfillment Data (Dashboard + Order Analysis, Apr 2026) ── */
    const SHIPBOB = {
        avgCostPerOrder: 17.99,
        targetCost: 9.00,
        longTermTarget: 6.00,
        breakdown: {
            pickPack: 5.25,
            carrierShipping: 8.50,
            storage: 0.15,
            ccSurcharge: 0.41
        },
        carrierMix: [
            { name: 'FedEx', pct: 39.1, cost: '$8-12' },
            { name: 'Tele Post', pct: 24.0, cost: '$5-8' },
            { name: 'UPS', pct: 14.5, cost: '$8-11' },
            { name: 'Amazon Logistics', pct: 6.7, cost: '$4-7' },
            { name: 'UniUni', pct: 4.5, cost: '$4-6' },
            { name: 'USPS', pct: 3.4, cost: '$3.50-4.50' },
            { name: 'Other', pct: 7.8, cost: '$4-8' }
        ],
        costBySku: [
            { sku: '4 Pack', estCost: 14.31, withUsps: 8.94 },
            { sku: '12 Pack', estCost: 16.94, withUsps: 11.00 },
            { sku: '36 Pack', estCost: 22.19, withUsps: 16.00 }
        ],
        alternatives: [
            { name: 'Pirate Ship (self-fulfill)', costPerOrder: '$3.62-4.62', note: 'Cheapest, you pack' },
            { name: 'Fluffle Fulfill (Austin TX)', costPerOrder: '~$5.12', note: '$1/order pick, no min' },
            { name: 'ShipMonk', costPerOrder: '~$6.85', note: '$2.50 pick, $250/mo min' },
            { name: 'Simpl Fulfillment (Austin TX)', costPerOrder: '$6.00 flat', note: 'All-in, $750/mo min' }
        ]
    };

    const DEFAULT_TASKS = [
        // ── FULFILLMENT: Research Complete ──
        { id: 't1', title: 'Research 3PL fulfillment centers', description: 'DONE: Researched ShipBob, ShipMonk, Pirate Ship, Amazon FBA, Fluffle, Simpl. See research files.', category: 'fulfillment', priority: 'high', status: 'done' },
        { id: 't2', title: 'Get quotes from ShipBob, ShipMonk, Fluffle', description: 'DONE: ShipBob $17.99/order actual. ShipMonk $6.85 est. Fluffle ~$5.12 est.', category: 'fulfillment', priority: 'high', status: 'done' },
        { id: 't22', title: 'Fix Shopify product weights', description: 'DONE: Set 4-Pack=280g, 12-Pack=750g, 36-Pack=2100g via API.', category: 'fulfillment', priority: 'high', status: 'done' },

        // ── FULFILLMENT: ShipBob Optimization (Phase 1 - Target $9/order) ──
        { id: 't23', title: 'Contact ShipBob: force USPS Ground Advantage', description: 'Call/chat ShipBob Merchant Care. Request USPS Ground Advantage as default carrier for Standard shipping on 4-Pack SKU. Currently FedEx handles 39% of orders at $8-12 vs USPS $3.50-4.50. Saves ~$4-5/order.', category: 'fulfillment', priority: 'high', status: 'todo' },
        { id: 't24', title: 'Remove Express 2-Day as default shipping option', description: '44% of orders use Express 2-Day. Switch default to Standard (5-7 day). Offer Express only as paid upgrade ($12+). Saves $3-5/order on affected orders.', category: 'fulfillment', priority: 'high', status: 'todo' },
        { id: 't25', title: 'Set free shipping minimum to $75+', description: 'Currently 67% of orders ship free. You absorb ~$583/mo in shipping. Set minimum $75 for free shipping (covers 12-Pack and 36-Pack). 4-Pack pays ~$5-7 for shipping.', category: 'fulfillment', priority: 'high', status: 'todo' },

        // ── FULFILLMENT: 3PL Migration (Phase 2 - Target $5-6/order) ──
        { id: 'fluffle1', title: 'Get Fluffle Fulfillment quote (Austin TX)', description: 'Contact flufflefulfill.com. $1/order pick & pack, no minimums, FDA compliant. Get pricing for 4-Pack (280g), 12-Pack (750g), 36-Pack (2100g). Ask about USPS GA rates from Austin.', category: 'fulfillment', priority: 'medium', status: 'todo' },
        { id: 'fluffle2', title: 'Get Simpl Fulfillment quote (Austin TX)', description: 'Contact simplfulfillment.com. $6/order flat rate all-inclusive. $750/mo min. Ask about weight tiers for chocolate bars and food handling.', category: 'fulfillment', priority: 'medium', status: 'todo' },
        { id: 't3', title: 'Test poly mailer vs box for chocolate bars', description: 'Poly bubble mailers $0.10-$0.15 vs boxes $0.50-$1.00+. Test with actual product - ensure chocolate survives shipping without melting/breaking.', category: 'fulfillment', priority: 'high', status: 'todo' },

        // ── FULFILLMENT: Self-Fulfill Backup ──
        { id: 't18', title: 'Sign up for Pirate Ship (FREE)', description: 'pirateship.com - USPS Ground Advantage 8oz: $3.50-$4.50. No monthly fees. Best fallback if 3PL costs stay high.', category: 'fulfillment', priority: 'medium', status: 'todo' },

        // ── DISTRIBUTION ──
        { id: 't8', title: 'Apply to Amazon FBA Canada', description: 'sellercentral.amazon.ca - FBA fulfillment ~$6 CAD/unit. Huge discovery traffic.', category: 'distribution', priority: 'high', status: 'todo' },
        { id: 't9', title: 'Apply to Amazon FBA US', description: 'FBA 2026: $3.15/unit (6-12oz) + 15% referral. Need FDA food facility registration.', category: 'distribution', priority: 'high', status: 'todo' },
        { id: 't10', title: 'Email 20 specialty grocery/health food retailers', description: 'Pitch wholesale partnerships', category: 'distribution', priority: 'medium', status: 'todo' },
        { id: 't11', title: 'Research Faire wholesale marketplace', description: 'faire.com - 15% commission, access to 500k+ retailers', category: 'distribution', priority: 'medium', status: 'todo' },
        { id: 't12', title: 'Setup subscription box partnerships', description: 'Candy Club, Cocoa Runners, Universal Yums, Love With Food', category: 'distribution', priority: 'medium', status: 'todo' },

        // ── MARKETING ──
        { id: 't13', title: 'Set up email marketing', description: 'Repeat customer retention. 15.9% repeat rate is decent - push to 25%.', category: 'marketing', priority: 'medium', status: 'todo' },
        { id: 't14', title: 'Create sell sheet PDF for retail pitches', description: 'Product photos, price points, margins, certifications', category: 'marketing', priority: 'high', status: 'todo' },

        // ── RETAIL ──
        { id: 't15', title: 'Email pitch to Whole Foods Market Canada', description: 'Local Producer Program', category: 'retail', priority: 'medium', status: 'todo' },
        { id: 't16', title: 'Contact Organic Garage, local stores', description: 'In-store retail placement', category: 'retail', priority: 'medium', status: 'todo' },
        { id: 't17', title: 'Research specialty chocolate subscription boxes', description: 'Candy Club, Cocoa Runners, etc.', category: 'retail', priority: 'low', status: 'todo' }
    ];

    const DEFAULT_CHANNELS = [
        { id: 'ch1', name: 'Shopify (endurenutra.com)', icon: '\u{1F6D2}', status: 'active', note: '192 orders/90d | $10.7K rev | AOV $55.88' },
        { id: 'ch2', name: 'Amazon.ca', icon: '\u{1F4E6}', status: 'planned', note: 'FBA enrollment pending' },
        { id: 'ch3', name: 'Amazon.com', icon: '\u{1F4E6}', status: 'planned', note: 'FBA $3.15/unit + 15% referral' },
        { id: 'ch4', name: 'Faire Wholesale', icon: '\u{1F3EA}', status: 'research', note: '15% commission, 500k+ retailers' },
        { id: 'ch5', name: 'Retail / Grocery', icon: '\u{1F3EC}', status: 'research', note: 'Whole Foods, health food stores' },
        { id: 'ch6', name: 'Wholesale Direct', icon: '\u{1F4CB}', status: 'planned', note: 'Direct to specialty shops' }
    ];

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function genId() { return 't' + Date.now() + Math.random().toString(36).slice(2, 6); }
    function fmt$(n) { return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function fmtPct(n) { return n.toFixed(1) + '%'; }

    function loadData() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) { /* ignore */ }
        return null;
    }

    function saveData(data) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }

    function getData() {
        let data = loadData();
        if (!data) {
            data = {
                tasks: DEFAULT_TASKS,
                channels: DEFAULT_CHANNELS,
                notes: '',
                stats: {
                    monthlyRevenue: fmt$(Math.round(SHOPIFY.totalRevenue / 3)),
                    avgOrderValue: fmt$(SHOPIFY.avgOrderValue),
                    fulfillmentCost: fmt$(SHIPBOB.avgCostPerOrder)
                }
            };
            saveData(data);
        }
        return data;
    }

    function showToast(msg) {
        const t = document.createElement('div');
        t.className = 'choc-toast';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2200);
    }

    /* ── Render ── */
    function render() {
        const data = getData();
        return '<div class="choc-panel">' +
            '<div class="choc-header">' +
                '<div>' +
                    '<h2 class="choc-header-title">\u{1F36B} Chocolate Bar</h2>' +
                    '<div class="choc-header-subtitle">Endure Nutrition \u2022 Business Operations</div>' +
                '</div>' +
            '</div>' +
            '<div class="choc-tabs">' +
                TABS.map(function(t) {
                    return '<button class="choc-tab' + (activeTab === t.id ? ' active' : '') + '" data-tab="' + t.id + '">' +
                        (TAB_ICONS[t.id] || '') + ' ' + t.label +
                    '</button>';
                }).join('') +
            '</div>' +
            '<div class="choc-tab-content" id="choc-content">' +
                renderTab(data) +
            '</div>' +
        '</div>';
    }

    function renderTab(data) {
        switch (activeTab) {
            case 'dashboard': return renderDashboard(data);
            case 'fulfillment': return renderFulfillment(data);
            case 'tasks': return renderTasks(data);
            case 'distribution': return renderDistribution(data);
            case 'notes': return renderNotes(data);
            default: return '';
        }
    }

    /* ── Dashboard Tab (NEW) ── */
    function renderDashboard(data) {
        var monthlyRev = SHOPIFY.totalRevenue / 3;
        var monthlyOrders = Math.round(SHOPIFY.totalOrders / 3);
        var currentCost = SHIPBOB.avgCostPerOrder;
        var targetCost = SHIPBOB.targetCost;
        var maxCost = 17.99;
        var progress = Math.max(0, Math.min(100, ((maxCost - currentCost) / (maxCost - SHIPBOB.longTermTarget)) * 100));

        var html = '';

        // Fulfillment cost progress bar
        html += '<div class="choc-card">' +
            '<div class="choc-card-title">\u{1F3AF} Fulfillment Cost Reduction</div>' +
            '<div class="choc-progress-wrap">' +
                '<div class="choc-progress-label">' +
                    '<span>Current: ' + fmt$(currentCost) + '/order</span>' +
                    '<span>Phase 1: $9 \u2192 Phase 2: $6</span>' +
                '</div>' +
                '<div class="choc-progress-bar">' +
                    '<div class="choc-progress-fill" style="width:' + progress + '%"></div>' +
                '</div>' +
            '</div>' +
        '</div>';

        // Key metrics
        html += '<div class="choc-metrics">' +
            '<div class="choc-metric"><div class="choc-metric-value">' + fmt$(monthlyRev) + '</div><div class="choc-metric-label">Monthly Revenue</div></div>' +
            '<div class="choc-metric"><div class="choc-metric-value">' + monthlyOrders + '</div><div class="choc-metric-label">Monthly Orders</div></div>' +
            '<div class="choc-metric"><div class="choc-metric-value">' + fmt$(SHOPIFY.avgOrderValue) + '</div><div class="choc-metric-label">Avg Order Value</div></div>' +
            '<div class="choc-metric"><div class="choc-metric-value">' + fmtPct(SHOPIFY.repeatRate) + '</div><div class="choc-metric-label">Repeat Rate</div></div>' +
        '</div>';

        // Gross margin table by SKU
        html += '<div class="choc-card">' +
            '<div class="choc-card-title">\u{1F4B0} Gross Margin by SKU</div>' +
            '<div style="margin-top:8px;font-size:13px;">' +
                '<div style="display:flex;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1);font-weight:600;color:var(--choc-accent);">' +
                    '<span style="flex:1.5">SKU</span>' +
                    '<span style="flex:1;text-align:right">Price</span>' +
                    '<span style="flex:1;text-align:right">COGS</span>' +
                    '<span style="flex:1;text-align:right">Fulfill</span>' +
                    '<span style="flex:1;text-align:right">Margin</span>' +
                    '<span style="flex:1;text-align:right">%</span>' +
                '</div>';

        PRODUCTS.forEach(function(p) {
            if (p.sku === 'sub') return;
            var fulfill = SHIPBOB.avgCostPerOrder;
            var skuCost = SHIPBOB.costBySku.find(function(s) { return s.sku === p.name; });
            if (skuCost) fulfill = skuCost.estCost;
            var margin = p.price - p.cogs - fulfill;
            var marginPct = (margin / p.price) * 100;
            var color = marginPct > 50 ? '#4ade80' : marginPct > 30 ? '#facc15' : '#f87171';

            html += '<div style="display:flex;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);">' +
                '<span style="flex:1.5;color:var(--choc-text)">' + esc(p.name) + '</span>' +
                '<span style="flex:1;text-align:right;color:var(--choc-text)">' + fmt$(p.price) + '</span>' +
                '<span style="flex:1;text-align:right;color:var(--choc-muted)">' + fmt$(p.cogs) + '</span>' +
                '<span style="flex:1;text-align:right;color:#f87171">' + fmt$(fulfill) + '</span>' +
                '<span style="flex:1;text-align:right;color:' + color + '">' + fmt$(margin) + '</span>' +
                '<span style="flex:1;text-align:right;color:' + color + '">' + fmtPct(marginPct) + '</span>' +
            '</div>';
        });

        html += '</div></div>';

        // Sales by product
        html += '<div class="choc-card">' +
            '<div class="choc-card-title">\u{1F4CA} Sales Mix (Last 90 Days)</div>' +
            '<div style="margin-top:8px;font-size:13px;">' +
                '<div style="display:flex;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1);font-weight:600;color:var(--choc-accent);">' +
                    '<span style="flex:2">Product</span>' +
                    '<span style="flex:1;text-align:right">Orders</span>' +
                    '<span style="flex:1;text-align:right">Revenue</span>' +
                    '<span style="flex:1;text-align:right">Mix</span>' +
                '</div>';

        PRODUCTS.forEach(function(p) {
            html += '<div style="display:flex;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);">' +
                '<span style="flex:2;color:var(--choc-text)">' + esc(p.name) + '</span>' +
                '<span style="flex:1;text-align:right;color:var(--choc-muted)">' + p.orders90d + '</span>' +
                '<span style="flex:1;text-align:right;color:var(--choc-text)">' + fmt$(p.revenue90d) + '</span>' +
                '<span style="flex:1;text-align:right;color:var(--choc-muted)">' + p.pctOrders + '%</span>' +
            '</div>';
        });

        html += '<div style="display:flex;padding:6px 0;font-weight:600;color:var(--choc-accent);">' +
                '<span style="flex:2">Total</span>' +
                '<span style="flex:1;text-align:right">' + SHOPIFY.totalOrders + '</span>' +
                '<span style="flex:1;text-align:right">' + fmt$(SHOPIFY.totalRevenue) + '</span>' +
                '<span style="flex:1;text-align:right">100%</span>' +
            '</div>' +
            '<div style="margin-top:8px;color:var(--choc-muted);font-size:12px;">' +
                SHOPIFY.uniqueCustomers + ' customers \u2022 ' + fmtPct(SHOPIFY.repeatRate) + ' repeat \u2022 Top: ' +
                SHOPIFY.topStates.slice(0, 4).map(function(s) { return s.state + ' (' + s.orders + ')'; }).join(', ') +
            '</div>' +
        '</div></div>';

        return html;
    }

    /* ── Fulfillment Tab (NEW) ── */
    function renderFulfillment(data) {
        var html = '';

        // Current cost headline
        html += '<div class="choc-card">' +
            '<div class="choc-card-title">\u{1F4B8} Current: ShipBob @ ' + fmt$(SHIPBOB.avgCostPerOrder) + '/order</div>' +
            '<div style="margin-top:8px;font-size:13px;">' +
                '<div style="display:flex;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1);font-weight:600;color:var(--choc-accent);">' +
                    '<span style="flex:2">Component</span><span style="flex:1;text-align:right">Cost</span><span style="flex:2;text-align:right">Notes</span>' +
                '</div>';

        var breakdown = [
            { name: 'Pick & Pack', cost: SHIPBOB.breakdown.pickPack, note: 'Base fee, lowest volume tier' },
            { name: 'Carrier Shipping', cost: SHIPBOB.breakdown.carrierShipping, note: '39% FedEx, 24% Tele Post, 14.5% UPS' },
            { name: 'Storage', cost: SHIPBOB.breakdown.storage, note: 'Bin storage prorated' },
            { name: 'CC Surcharge (3%)', cost: SHIPBOB.breakdown.ccSurcharge, note: 'On fulfillment + shipping' }
        ];

        breakdown.forEach(function(b) {
            html += '<div style="display:flex;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);">' +
                '<span style="flex:2;color:var(--choc-text)">' + b.name + '</span>' +
                '<span style="flex:1;text-align:right;color:#f87171">' + fmt$(b.cost) + '</span>' +
                '<span style="flex:2;text-align:right;color:var(--choc-muted);font-size:12px">' + b.note + '</span>' +
            '</div>';
        });

        var total = breakdown.reduce(function(s, b) { return s + b.cost; }, 0);
        html += '<div style="display:flex;padding:6px 0;font-weight:600;">' +
                '<span style="flex:2;color:var(--choc-accent)">Estimated Total</span>' +
                '<span style="flex:1;text-align:right;color:#f87171">' + fmt$(total) + '</span>' +
                '<span style="flex:2;text-align:right;color:var(--choc-muted);font-size:12px">Dashboard shows ' + fmt$(SHIPBOB.avgCostPerOrder) + '</span>' +
            '</div>' +
        '</div></div>';

        // Carrier mix
        html += '<div class="choc-card">' +
            '<div class="choc-card-title">\u{1F69A} Carrier Mix (192 Orders)</div>' +
            '<div style="margin-top:8px;font-size:13px;">';

        SHIPBOB.carrierMix.forEach(function(c) {
            var barColor = c.name === 'USPS' ? '#4ade80' : (c.name === 'FedEx' || c.name === 'UPS') ? '#f87171' : '#facc15';
            html += '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">' +
                '<span style="width:110px;color:var(--choc-text)">' + c.name + '</span>' +
                '<div style="flex:1;height:16px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden;">' +
                    '<div style="height:100%;width:' + c.pct + '%;background:' + barColor + ';border-radius:4px;"></div>' +
                '</div>' +
                '<span style="width:40px;text-align:right;color:var(--choc-muted);font-size:12px">' + fmtPct(c.pct) + '</span>' +
                '<span style="width:70px;text-align:right;color:var(--choc-muted);font-size:12px">' + c.cost + '</span>' +
            '</div>';
        });

        html += '<div style="margin-top:8px;padding:8px;background:rgba(248,113,113,0.1);border-radius:6px;font-size:12px;color:#f87171;">' +
            '\u26A0 FedEx (39%) is most expensive. USPS (3.4%) is cheapest. Forcing USPS Ground Advantage saves ~$4-5/order.' +
        '</div></div></div>';

        // Cost by SKU comparison
        html += '<div class="choc-card">' +
            '<div class="choc-card-title">\u{1F4E6} Est. Cost by SKU: Current vs USPS Optimized</div>' +
            '<div style="margin-top:8px;font-size:13px;">' +
                '<div style="display:flex;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1);font-weight:600;color:var(--choc-accent);">' +
                    '<span style="flex:1.5">SKU</span><span style="flex:1;text-align:right">Current</span><span style="flex:1;text-align:right">w/ USPS</span><span style="flex:1;text-align:right">Savings</span>' +
                '</div>';

        SHIPBOB.costBySku.forEach(function(s) {
            var saving = s.estCost - s.withUsps;
            html += '<div style="display:flex;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);">' +
                '<span style="flex:1.5;color:var(--choc-text)">' + s.sku + '</span>' +
                '<span style="flex:1;text-align:right;color:#f87171">' + fmt$(s.estCost) + '</span>' +
                '<span style="flex:1;text-align:right;color:#facc15">' + fmt$(s.withUsps) + '</span>' +
                '<span style="flex:1;text-align:right;color:#4ade80">-' + fmt$(saving) + '</span>' +
            '</div>';
        });

        html += '</div></div>';

        // Alternatives comparison
        html += '<div class="choc-card">' +
            '<div class="choc-card-title">\u{1F504} Alternatives (4-Pack Comparison)</div>' +
            '<div style="margin-top:8px;font-size:13px;">';

        SHIPBOB.alternatives.forEach(function(a) {
            var isCurrent = a.name.indexOf('ShipBob') >= 0;
            html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);">' +
                '<span style="flex:2;color:var(--choc-text)">' + a.name + '</span>' +
                '<span style="flex:1;text-align:right;font-weight:600;color:' + (isCurrent ? '#f87171' : '#4ade80') + '">' + a.costPerOrder + '</span>' +
                '<span style="flex:1.5;text-align:right;color:var(--choc-muted);font-size:12px">' + a.note + '</span>' +
            '</div>';
        });

        html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;opacity:0.5">' +
                '<span style="flex:2;color:var(--choc-text)">ShipBob (current)</span>' +
                '<span style="flex:1;text-align:right;font-weight:600;color:#f87171">' + fmt$(SHIPBOB.avgCostPerOrder) + '</span>' +
                '<span style="flex:1.5;text-align:right;color:var(--choc-muted);font-size:12px">$5.25 pick + FedEx markup</span>' +
            '</div>' +
        '</div></div>';

        return html;
    }

    /* ── Overview (removed - replaced by Dashboard) ── */

    /* ── Tasks Tab ── */
    function renderTasks(data) {
        var tasks = data.tasks || [];
        var grouped = {};
        CATEGORIES.forEach(function(c) { grouped[c] = tasks.filter(function(t) { return t.category === c; }); });

        var html = '<button class="choc-add-btn" id="choc-add-task">\u{2795} Add Task</button>';

        CATEGORIES.forEach(function(cat) {
            var catTasks = grouped[cat];
            if (!catTasks || catTasks.length === 0) return;
            html += '<div class="choc-task-group">' +
                '<div class="choc-task-group-title">' + (CATEGORY_ICONS[cat] || '') + ' ' + cat + '</div>' +
                catTasks.map(function(t) { return renderTask(t); }).join('') +
            '</div>';
        });

        return html;
    }

    function renderTask(t) {
        return '<div class="choc-task' + (t.status === 'done' ? ' done' : '') + '" data-id="' + t.id + '">' +
            '<div class="choc-task-body">' +
                '<div class="choc-task-title">' + esc(t.title) + '</div>' +
                (t.description ? '<div class="choc-task-desc">' + esc(t.description) + '</div>' : '') +
                '<div class="choc-task-meta">' +
                    '<span class="choc-badge choc-badge-' + t.priority + '">' + t.priority + '</span>' +
                    '<span class="choc-badge choc-badge-status">' + t.status + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="choc-task-actions">' +
                '<button class="choc-task-btn complete-btn" data-action="complete" data-id="' + t.id + '" title="' + (t.status === 'done' ? 'Reopen' : 'Complete') + '">' + (t.status === 'done' ? '\u21A9' : '\u2713') + '</button>' +
                '<button class="choc-task-btn" data-action="edit" data-id="' + t.id + '" title="Edit">\u270E</button>' +
                '<button class="choc-task-btn delete-btn" data-action="delete" data-id="' + t.id + '" title="Delete">\u2715</button>' +
            '</div>' +
        '</div>';
    }

    /* ── Distribution Tab ── */
    function renderDistribution(data) {
        var channels = data.channels || [];
        return channels.map(function(ch) {
            return '<div class="choc-channel">' +
                '<div class="choc-channel-icon" style="background:rgba(212,145,92,0.15);">' + ch.icon + '</div>' +
                '<div class="choc-channel-info">' +
                    '<div class="choc-channel-name">' + esc(ch.name) + '</div>' +
                    '<div class="choc-channel-status">' + esc(ch.note) + '</div>' +
                '</div>' +
                '<span class="choc-channel-badge choc-channel-' + ch.status + '">' + ch.status + '</span>' +
            '</div>';
        }).join('');
    }

    /* ── Notes Tab ── */
    function renderNotes(data) {
        return '<textarea class="choc-notes-area" id="choc-notes" placeholder="Write notes about the chocolate bar business...">' + esc(data.notes || '') + '</textarea>' +
            '<div class="choc-notes-saved" id="choc-notes-saved">Saved</div>';
    }

    /* ── Task Modal ── */
    function showTaskModal(task) {
        var isEdit = !!task;
        var t = task || { title: '', description: '', category: 'fulfillment', priority: 'medium', status: 'todo' };

        var overlay = document.createElement('div');
        overlay.className = 'choc-modal-overlay';
        overlay.id = 'choc-task-modal';
        overlay.innerHTML = '<div class="choc-modal" onclick="event.stopPropagation()">' +
            '<h3>' + (isEdit ? 'Edit Task' : 'New Task') + '</h3>' +
            '<div class="choc-form-group">' +
                '<label class="choc-form-label">Title</label>' +
                '<input class="choc-input" id="choc-f-title" value="' + esc(t.title) + '" placeholder="Task title...">' +
            '</div>' +
            '<div class="choc-form-group">' +
                '<label class="choc-form-label">Description</label>' +
                '<textarea class="choc-textarea" id="choc-f-desc" placeholder="Details...">' + esc(t.description || '') + '</textarea>' +
            '</div>' +
            '<div style="display:flex;gap:10px;">' +
                '<div class="choc-form-group" style="flex:1">' +
                    '<label class="choc-form-label">Category</label>' +
                    '<select class="choc-select" id="choc-f-cat">' +
                        CATEGORIES.map(function(c) { return '<option value="' + c + '"' + (t.category === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') +
                    '</select>' +
                '</div>' +
                '<div class="choc-form-group" style="flex:1">' +
                    '<label class="choc-form-label">Priority</label>' +
                    '<select class="choc-select" id="choc-f-pri">' +
                        PRIORITIES.map(function(p) { return '<option value="' + p + '"' + (t.priority === p ? ' selected' : '') + '>' + p + '</option>'; }).join('') +
                    '</select>' +
                '</div>' +
            '</div>' +
            (isEdit ? '<div class="choc-form-group">' +
                '<label class="choc-form-label">Status</label>' +
                '<select class="choc-select" id="choc-f-status">' +
                    STATUSES.map(function(s) { return '<option value="' + s + '"' + (t.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
                '</select>' +
            '</div>' : '') +
            '<div class="choc-modal-actions">' +
                '<button class="choc-btn choc-btn-secondary" id="choc-modal-cancel">Cancel</button>' +
                '<button class="choc-btn choc-btn-primary" id="choc-modal-save">' + (isEdit ? 'Save' : 'Add Task') + '</button>' +
            '</div>' +
        '</div>';

        document.body.appendChild(overlay);

        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) overlay.remove();
        });
        overlay.querySelector('#choc-modal-cancel').addEventListener('click', function() { overlay.remove(); });
        overlay.querySelector('#choc-modal-save').addEventListener('click', function() {
            var title = overlay.querySelector('#choc-f-title').value.trim();
            if (!title) { showToast('Title is required'); return; }

            var data = getData();
            var taskData = {
                title: title,
                description: overlay.querySelector('#choc-f-desc').value.trim(),
                category: overlay.querySelector('#choc-f-cat').value,
                priority: overlay.querySelector('#choc-f-pri').value,
                status: isEdit ? (overlay.querySelector('#choc-f-status') ? overlay.querySelector('#choc-f-status').value : t.status) : 'todo'
            };

            if (isEdit) {
                var idx = data.tasks.findIndex(function(x) { return x.id === t.id; });
                if (idx !== -1) Object.assign(data.tasks[idx], taskData);
            } else {
                data.tasks.push(Object.assign({ id: genId() }, taskData));
            }

            saveData(data);
            overlay.remove();
            refresh();
            showToast(isEdit ? 'Task updated' : 'Task added');
        });

        setTimeout(function() { overlay.querySelector('#choc-f-title').focus(); }, 100);
    }

    /* ── Event Binding ── */
    function bindEvents() {
        if (!container) return;

        container.addEventListener('click', function(e) {
            var tab = e.target.closest('.choc-tab');
            if (tab) {
                activeTab = tab.dataset.tab;
                refresh();
                return;
            }

            if (e.target.closest('#choc-add-task')) {
                showTaskModal(null);
                return;
            }

            var actionBtn = e.target.closest('[data-action]');
            if (actionBtn) {
                var action = actionBtn.dataset.action;
                var id = actionBtn.dataset.id;
                var data = getData();
                var idx = data.tasks.findIndex(function(t) { return t.id === id; });
                if (idx === -1) return;

                if (action === 'complete') {
                    data.tasks[idx].status = data.tasks[idx].status === 'done' ? 'todo' : 'done';
                    saveData(data);
                    refresh();
                    showToast(data.tasks[idx].status === 'done' ? 'Task completed!' : 'Task reopened');
                } else if (action === 'edit') {
                    showTaskModal(data.tasks[idx]);
                } else if (action === 'delete') {
                    data.tasks.splice(idx, 1);
                    saveData(data);
                    refresh();
                    showToast('Task deleted');
                }
                return;
            }
        });

        container.addEventListener('input', function(e) {
            if (e.target.id === 'choc-notes') {
                clearTimeout(notesSaveTimer);
                notesSaveTimer = setTimeout(function() {
                    var data = getData();
                    data.notes = e.target.value;
                    saveData(data);
                    var saved = container.querySelector('#choc-notes-saved');
                    if (saved) {
                        saved.classList.add('visible');
                        setTimeout(function() { saved.classList.remove('visible'); }, 1500);
                    }
                }, 500);
            }
        });
    }

    function refresh() {
        if (!container) return;
        container.innerHTML = render();
        bindEvents();
    }

    /* ── Public API ── */
    return {
        open: function(bodyEl, opts) {
            container = bodyEl;
            container.innerHTML = render();
            bindEvents();
        },
        close: function() {
            clearTimeout(notesSaveTimer);
            var modal = document.getElementById('choc-task-modal');
            if (modal) modal.remove();
            container = null;
            activeTab = 'dashboard';
            editingTaskId = null;
        }
    };
})();

window.ChocolateBarUI = { open: function(c, o) { ChocolateBarUI.open(c, o); }, close: function() { ChocolateBarUI.close(); } };

BuildingRegistry.register('Chocolate Bar', {
    open: function(bodyEl, opts) { ChocolateBarUI.open(bodyEl, opts); },
    close: function() { ChocolateBarUI.close(); }
});
