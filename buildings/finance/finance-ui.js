// finance-ui.js — Finance building dashboard with Plaid bank integration
const FinanceUI = (() => {
    let container = null;
    let activeTab = 'overview';
    let dateRange = 30; // days back from today
    let transactions = [];
    let accounts = [];
    let projects = []; // Dropbox folder names
    let connectionStatus = { configured: false, connected: false, connectedAt: null };
    let connectedAt = null;
    let expandedTxId = null;
    let searchQuery = '';
    let txFilter = 'all'; // all | uncategorized | credits | debits
    let plaidLinkLoaded = false;
    let loading = false;
    let dragTxId = null;

    const DATE_RANGES = [
        { label: 'Last Day', days: 1 },
        { label: 'Last 7 Days', days: 7 },
        { label: 'Last 30 Days', days: 30 },
        { label: 'Last 3 Months', days: 90 },
        { label: 'Last 6 Months', days: 180 },
        { label: 'Last Year', days: 365 },
        { label: 'All Time', days: 730 }
    ];

    const TABS = [
        { id: 'overview', label: 'Overview' },
        { id: 'transactions', label: 'Transactions' },
        { id: 'projects', label: 'Projects' },
        { id: 'connect', label: 'Connect' }
    ];

    const TAB_ICONS = {
        overview: '<svg viewBox="0 0 24 24"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>',
        transactions: '<svg viewBox="0 0 24 24"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>',
        projects: '<svg viewBox="0 0 24 24"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>',
        connect: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
    };

    const CATEGORY_EMOJIS = {
        'FOOD_AND_DRINK': '🍔', 'TRANSPORTATION': '🚗', 'TRAVEL': '✈️',
        'ENTERTAINMENT': '🎬', 'GENERAL_MERCHANDISE': '🛍️', 'GENERAL_SERVICES': '🔧',
        'RENT_AND_UTILITIES': '🏠', 'MEDICAL': '🏥', 'PERSONAL_CARE': '💇',
        'GOVERNMENT_AND_NON_PROFIT': '🏛️', 'TRANSFER_IN': '💰', 'TRANSFER_OUT': '💸',
        'INCOME': '💵', 'BANK_FEES': '🏦', 'LOAN_PAYMENTS': '📋',
        'HOME_IMPROVEMENT': '🔨', 'OTHER': '📦'
    };

    const BAR_COLORS = ['#4ade80', '#60a5fa', '#c084fc', '#fbbf24', '#f87171'];

    function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    function fmt$(n) {
        var num = parseFloat(n) || 0;
        var neg = num < 0;
        var abs = Math.abs(num).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (neg ? '-' : '') + '$' + abs;
    }

    function getStartDate() {
        var d = new Date();
        d.setDate(d.getDate() - dateRange);
        return d.toISOString().slice(0, 10);
    }

    function getEndDate() {
        return new Date().toISOString().slice(0, 10);
    }

    function getCategoryPrimary(t) {
        return (t.personal_finance_category && t.personal_finance_category.primary) || 'OTHER';
    }

    function getCategoryEmoji(t) {
        return CATEGORY_EMOJIS[getCategoryPrimary(t)] || '📦';
    }

    function getAccountName(accountId) {
        var a = accounts.find(function(acc) { return acc.account_id === accountId; });
        return a ? (a.name || a.official_name || 'Account') : accountId ? accountId.slice(0, 8) + '...' : 'N/A';
    }

    // ── API calls ──

    async function fetchStatus() {
        try {
            var resp = await fetch('/api/finance/status');
            connectionStatus = await resp.json();
        } catch (e) {
            connectionStatus = { configured: false, connected: false, connectedAt: null };
        }
    }

    async function fetchTransactions() {
        if (!connectionStatus.connected) return;
        loading = true;
        refresh();
        try {
            var resp = await fetch('/api/finance/transactions?start=' + getStartDate() + '&end=' + getEndDate());
            var data = await resp.json();
            if (data.transactions) {
                transactions = data.transactions;
                connectedAt = data.connectedAt;
            }
        } catch (e) {
            console.error('Finance: fetch transactions failed', e);
        }
        loading = false;
        refresh();
    }

    async function fetchAccounts() {
        if (!connectionStatus.connected) return;
        try {
            var resp = await fetch('/api/finance/accounts');
            var data = await resp.json();
            if (data.accounts) accounts = data.accounts;
        } catch (e) {
            console.error('Finance: fetch accounts failed', e);
        }
    }

    async function fetchProjects() {
        try {
            var resp = await fetch('/api/dropbox/list_folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: '/Snappy' })
            });
            var data = await resp.json();
            if (data.entries) {
                projects = data.entries
                    .filter(function(e) { return e['.tag'] === 'folder'; })
                    .map(function(e) { return e.name; });
            }
        } catch (e) {
            console.error('Finance: fetch projects failed', e);
        }
    }

    async function saveMeta(transactionId, updates) {
        // Update local transaction object
        var tx = transactions.find(function(t) { return t.transaction_id === transactionId; });
        if (tx) {
            if ('project' in updates) tx._project = updates.project;
            if ('category' in updates) tx._category = updates.category;
            if ('accountedFor' in updates) tx._accountedFor = updates.accountedFor;
            if ('notes' in updates) tx._notes = updates.notes;
        }
        try {
            await fetch('/api/finance/transaction-meta', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transactionId: transactionId,
                    project: (tx && tx._project) || updates.project || null,
                    category: (tx && tx._category) || updates.category || null,
                    accountedFor: tx ? !!tx._accountedFor : !!updates.accountedFor,
                    notes: (tx && tx._notes) || updates.notes || ''
                })
            });
        } catch (e) {
            console.error('Finance: save meta failed', e);
        }
    }

    async function disconnectBank() {
        try {
            await fetch('/api/finance/connection', { method: 'DELETE' });
            connectionStatus.connected = false;
            connectionStatus.connectedAt = null;
            transactions = [];
            accounts = [];
            connectedAt = null;
            showToast('Bank disconnected');
            refresh();
        } catch (e) {
            showToast('Failed to disconnect');
        }
    }

    // ── Plaid Link (preserved exactly) ──

    function loadPlaidLink(callback) {
        if (plaidLinkLoaded) { callback(); return; }
        var script = document.createElement('script');
        script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
        script.onload = function() { plaidLinkLoaded = true; callback(); };
        script.onerror = function() { showToast('Failed to load Plaid Link'); };
        document.head.appendChild(script);
    }

    async function startPlaidLink() {
        var plaidObserver = null;

        function forceZIndex() {
            document.querySelectorAll('iframe[id*="plaid"], div[id*="plaid"], div[class*="plaid"]').forEach(function(el) {
                el.style.setProperty('z-index', '99999', 'important');
            });
        }

        function startPlaidObserver() {
            plaidObserver = new MutationObserver(function() {
                forceZIndex();
            });
            plaidObserver.observe(document.body, { childList: true, subtree: true });
            forceZIndex();
            var overlay = document.getElementById('modal-overlay');
            if (overlay) {
                overlay.style.backdropFilter = 'none';
                overlay.style.zIndex = '0';
            }
            var style = document.createElement('style');
            style.id = 'plaid-override-style';
            style.textContent = '#modal-overlay { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; z-index: 0 !important; }\n' +
                'body > iframe, body > div[id*="plaid"], body > div[class*="plaid"] { z-index: 2147483647 !important; position: fixed !important; }';
            document.head.appendChild(style);
        }

        function cleanupPlaidObserver() {
            if (plaidObserver) {
                plaidObserver.disconnect();
                plaidObserver = null;
            }
            var overrideStyle = document.getElementById('plaid-override-style');
            if (overrideStyle) overrideStyle.remove();
            var overlay = document.getElementById('modal-overlay');
            if (overlay) {
                overlay.style.backdropFilter = 'blur(6px)';
                overlay.style.zIndex = '200';
            }
        }

        try {
            var resp = await fetch('/api/finance/link-token', { method: 'POST' });
            var data = await resp.json();
            if (!data.link_token) { showToast(data.error || 'Failed to get link token'); return; }
            loadPlaidLink(function() {
                var handler = Plaid.create({
                    token: data.link_token,
                    onSuccess: async function(publicToken, metadata) {
                        cleanupPlaidObserver();
                        showToast('Connecting...');
                        try {
                            await fetch('/api/finance/exchange-token', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ public_token: publicToken })
                            });
                            showToast('Bank connected!');
                            await fetchStatus();
                            await fetchAccounts();
                            await fetchTransactions();
                        } catch (e) {
                            showToast('Failed to connect bank');
                        }
                    },
                    onExit: function(err) {
                        cleanupPlaidObserver();
                        if (err) console.warn('Plaid Link exited with error', err);
                    }
                });
                setTimeout(function() {
                    handler.open();
                    startPlaidObserver();
                }, 100);
            });
        } catch (e) {
            showToast('Failed to start Plaid Link');
        }
    }

    function showToast(msg) {
        var existing = document.querySelector('.fin-toast');
        if (existing) existing.remove();
        var el = document.createElement('div');
        el.className = 'fin-toast';
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(function() { el.remove(); }, 3000);
    }

    // ── Filtering ──

    function getFilteredTransactions() {
        var list = transactions;
        if (searchQuery) {
            var q = searchQuery.toLowerCase();
            list = list.filter(function(t) {
                return (t.name || '').toLowerCase().includes(q) ||
                       (t.merchant_name || '').toLowerCase().includes(q);
            });
        }
        if (txFilter === 'uncategorized') {
            list = list.filter(function(t) { return !t._project; });
        } else if (txFilter === 'credits') {
            list = list.filter(function(t) { return t.amount < 0; });
        } else if (txFilter === 'debits') {
            list = list.filter(function(t) { return t.amount > 0; });
        }
        return list;
    }

    // ── Render helpers ──

    function renderTimeFilter() {
        return '<div class="fin-time-pills">' +
            DATE_RANGES.map(function(r) {
                return '<button class="fin-pill' + (dateRange === r.days ? ' active' : '') + '" data-days="' + r.days + '">' + r.label + '</button>';
            }).join('') +
        '</div>';
    }

    // ── Main render ──

    function render() {
        return '<div class="fin-panel">' +
            '<div class="fin-header">' +
                '<h2 class="fin-header-title">Finance</h2>' +
                '<div class="fin-header-subtitle">Business Banking Dashboard</div>' +
            '</div>' +
            '<div class="fin-tabs">' +
                TABS.map(function(t) {
                    return '<button class="fin-tab' + (activeTab === t.id ? ' active' : '') + '" data-tab="' + t.id + '">' +
                        (TAB_ICONS[t.id] || '') + ' ' + t.label +
                    '</button>';
                }).join('') +
            '</div>' +
            '<div class="fin-content" id="fin-content">' +
                (loading ? '<div class="fin-loading"><div class="fin-spinner"></div><div style="margin-top:12px">Loading transactions...</div></div>' : renderTab()) +
            '</div>' +
        '</div>';
    }

    function renderTab() {
        if (!connectionStatus.connected && activeTab !== 'connect') {
            return renderEmptyState();
        }
        switch (activeTab) {
            case 'overview': return renderOverview();
            case 'transactions': return renderTransactions();
            case 'projects': return renderProjects();
            case 'connect': return renderConnect();
            default: return '';
        }
    }

    function renderEmptyState() {
        return '<div class="fin-connect-cta">' +
            '<h3>Connect your bank to start tracking</h3>' +
            '<p>Link your business bank account to see transactions, categorize spending by project, and track where your money goes.</p>' +
            '<button class="fin-btn fin-btn-primary" id="fin-cta-connect">Connect Bank Account</button>' +
        '</div>';
    }

    // ── Overview Tab ──

    function renderOverview() {
        var html = renderTimeFilter();

        // Compute metrics
        var totalIncome = 0, totalSpent = 0, uncategorized = 0;
        transactions.forEach(function(t) {
            if (t.amount < 0) totalIncome += Math.abs(t.amount);
            else totalSpent += t.amount;
            if (!t._project) uncategorized++;
        });
        var net = totalIncome - totalSpent;

        html += '<div class="fin-metrics">' +
            '<div class="fin-metric">' +
                '<div class="fin-metric-value" style="color:var(--fin-green)">' + fmt$(totalIncome) + '</div>' +
                '<div class="fin-metric-label">Total Income</div>' +
            '</div>' +
            '<div class="fin-metric">' +
                '<div class="fin-metric-value" style="color:var(--fin-red)">' + fmt$(totalSpent) + '</div>' +
                '<div class="fin-metric-label">Total Spent</div>' +
            '</div>' +
            '<div class="fin-metric">' +
                '<div class="fin-metric-value" style="color:' + (net >= 0 ? 'var(--fin-green)' : 'var(--fin-red)') + '">' + fmt$(net) + '</div>' +
                '<div class="fin-metric-label">Net</div>' +
            '</div>' +
            '<div class="fin-metric">' +
                '<div class="fin-metric-value" style="color:var(--fin-gold)">' + uncategorized + '</div>' +
                '<div class="fin-metric-label">Uncategorized</div>' +
            '</div>' +
        '</div>';

        // Bar chart — top 5 spending categories
        var catTotals = {};
        transactions.forEach(function(t) {
            if (t.amount > 0) {
                var cat = getCategoryPrimary(t);
                catTotals[cat] = (catTotals[cat] || 0) + t.amount;
            }
        });
        var catSorted = Object.entries(catTotals).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5);
        var catMax = catSorted.length > 0 ? catSorted[0][1] : 1;

        if (catSorted.length > 0) {
            html += '<div class="fin-card">' +
                '<div class="fin-card-title">Spending by Category</div>' +
                '<div class="fin-bar-chart">';
            catSorted.forEach(function(entry, i) {
                var pct = Math.round((entry[1] / catMax) * 100);
                var label = entry[0].replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, function(c) { return c.toUpperCase(); });
                html += '<div class="fin-bar-row">' +
                    '<div class="fin-bar-label">' + esc(label) + '</div>' +
                    '<div class="fin-bar-track"><div class="fin-bar-fill" style="width:' + pct + '%;background:' + BAR_COLORS[i % BAR_COLORS.length] + '"></div></div>' +
                    '<div class="fin-bar-value">' + fmt$(entry[1]) + '</div>' +
                '</div>';
            });
            html += '</div></div>';
        }

        // Account balance cards
        if (accounts.length > 0) {
            html += '<div class="fin-card">' +
                '<div class="fin-card-title">Accounts</div>' +
                '<div class="fin-account-cards">';
            accounts.forEach(function(a) {
                var bal = a.balances && a.balances.current != null ? a.balances.current : 0;
                var type = a.subtype || a.type || '';
                html += '<div class="fin-account-card">' +
                    '<div class="fin-account-name">' + esc(a.name || a.official_name || 'Account') + '</div>' +
                    '<div class="fin-account-balance">' + fmt$(bal) + '</div>' +
                    '<div class="fin-account-type">' + esc(type) + (a.mask ? ' ••••' + a.mask : '') + '</div>' +
                '</div>';
            });
            html += '</div></div>';
        }

        return html;
    }

    // ── Transactions Tab ──

    function renderTransactions() {
        var html = renderTimeFilter();

        // Uncategorized banner
        var uncatCount = transactions.filter(function(t) { return !t._project; }).length;
        if (uncatCount > 0) {
            html += '<div class="fin-banner fin-banner-amber">' + uncatCount + ' transaction' + (uncatCount === 1 ? '' : 's') + ' need review</div>';
        }

        // Search + filter pills
        html += '<div class="fin-filters">' +
            '<input type="text" class="fin-search" id="fin-search" placeholder="Search by name or merchant..." value="' + esc(searchQuery) + '">' +
        '</div>';

        html += '<div class="fin-filter-pills">' +
            ['all', 'uncategorized', 'credits', 'debits'].map(function(f) {
                var label = f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1);
                return '<button class="fin-pill' + (txFilter === f ? ' active' : '') + '" data-txfilter="' + f + '">' + label + '</button>';
            }).join('') +
        '</div>';

        var filtered = getFilteredTransactions();
        if (filtered.length === 0) {
            html += '<div class="fin-empty">No transactions match your filters</div>';
            return html;
        }

        html += '<div class="fin-tx-list">';
        filtered.forEach(function(t) {
            var isDebit = t.amount > 0;
            var displayName = t.merchant_name || t.name || 'Unknown';
            var catPrimary = getCategoryPrimary(t);
            var catLabel = catPrimary.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, function(c) { return c.toUpperCase(); });

            // Logo or emoji fallback
            var logoHtml = t.logo_url
                ? '<img class="fin-tx-logo" src="' + esc(t.logo_url) + '" alt="" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
                  '<div class="fin-tx-emoji" style="display:none">' + getCategoryEmoji(t) + '</div>'
                : '<div class="fin-tx-emoji">' + getCategoryEmoji(t) + '</div>';

            html += '<div class="fin-tx-row" data-txid="' + esc(t.transaction_id) + '">' +
                '<div class="fin-tx-left">' +
                    '<div class="fin-tx-logo-wrap">' + logoHtml + '</div>' +
                    '<div>' +
                        '<div class="fin-tx-merchant">' + esc(displayName) + '</div>' +
                        '<div class="fin-tx-date">' + esc(t.date) + '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="fin-tx-center">' +
                    '<div class="fin-tx-desc">' + esc(t.name) + (t.pending ? ' <span class="fin-badge-pending">Pending</span>' : '') + '</div>' +
                '</div>' +
                '<div class="fin-tx-right">' +
                    '<div class="fin-tx-amount ' + (isDebit ? 'debit' : 'credit') + '">' + (isDebit ? '-' : '+') + fmt$(Math.abs(t.amount)) + '</div>' +
                '</div>' +
                '<div class="fin-tx-meta">' +
                    '<span class="fin-cat-badge">' + esc(catLabel) + '</span>' +
                    '<span class="fin-tag ' + (t._project ? 'fin-tag-assigned' : 'fin-tag-none') + '" data-action="tag" data-txid="' + esc(t.transaction_id) + '">' +
                        esc(t._project || '+ project') +
                    '</span>' +
                    '<button class="fin-check' + (t._accountedFor ? ' checked' : '') + '" data-action="check" data-txid="' + esc(t.transaction_id) + '">&#10003;</button>' +
                '</div>' +
            '</div>';

            // Expanded detail
            if (expandedTxId === t.transaction_id) {
                var loc = t.location || {};
                var locStr = [loc.address, loc.city, loc.region, loc.country].filter(Boolean).join(', ') || 'N/A';
                var counterparties = (t.counterparties || []).map(function(c) { return c.name || c.entity_id || ''; }).filter(Boolean).join(', ') || 'N/A';

                html += '<div class="fin-tx-detail">' +
                    '<div class="fin-tx-detail-grid">' +
                        '<div><div class="fin-tx-detail-label">Merchant</div><div class="fin-tx-detail-value">' + esc(t.merchant_name || 'N/A') + '</div></div>' +
                        '<div><div class="fin-tx-detail-label">Amount</div><div class="fin-tx-detail-value" style="color:' + (isDebit ? 'var(--fin-red)' : 'var(--fin-green)') + '">' + (isDebit ? '-' : '+') + fmt$(Math.abs(t.amount)) + '</div></div>' +
                        '<div><div class="fin-tx-detail-label">Category</div><div class="fin-tx-detail-value">' + esc(catLabel) + '</div></div>' +
                        '<div><div class="fin-tx-detail-label">Account</div><div class="fin-tx-detail-value">' + esc(getAccountName(t.account_id)) + '</div></div>' +
                        '<div><div class="fin-tx-detail-label">Payment Channel</div><div class="fin-tx-detail-value">' + esc(t.payment_channel || 'N/A') + '</div></div>' +
                        '<div><div class="fin-tx-detail-label">Pending</div><div class="fin-tx-detail-value">' + (t.pending ? 'Yes' : 'No') + '</div></div>' +
                        '<div><div class="fin-tx-detail-label">Location</div><div class="fin-tx-detail-value">' + esc(locStr) + '</div></div>' +
                        '<div><div class="fin-tx-detail-label">Counterparties</div><div class="fin-tx-detail-value">' + esc(counterparties) + '</div></div>' +
                        '<div style="grid-column:1/-1"><div class="fin-tx-detail-label">Transaction ID</div><div class="fin-tx-detail-value" style="font-family:var(--fin-font-mono);font-size:11px">' + esc(t.transaction_id) + '</div></div>' +
                    '</div>' +
                    '<div class="fin-tx-detail-label" style="margin-bottom:6px">Notes</div>' +
                    '<textarea class="fin-notes-input" data-txid="' + esc(t.transaction_id) + '" placeholder="Add notes...">' + esc(t._notes || '') + '</textarea>' +
                '</div>';
            }
        });
        html += '</div>';
        return html;
    }

    // ── Projects Tab ──

    function renderProjects() {
        var unassigned = transactions.filter(function(t) { return !t._project; });

        var html = '<div class="fin-projects-layout">';

        // Left panel — unassigned
        html += '<div class="fin-projects-left">' +
            '<div class="fin-card-title">Unassigned <span style="color:var(--fin-text-muted);font-weight:400">(' + unassigned.length + ')</span></div>' +
            '<div class="fin-unassigned-list" id="fin-unassigned-list">';
        if (unassigned.length === 0) {
            html += '<div class="fin-empty" style="padding:20px">All transactions assigned!</div>';
        } else {
            unassigned.forEach(function(t) {
                var isDebit = t.amount > 0;
                html += '<div class="fin-unassigned-row" draggable="true" data-txid="' + esc(t.transaction_id) + '">' +
                    '<span class="fin-drag-handle">⠿</span>' +
                    '<div class="fin-unassigned-info">' +
                        '<div class="fin-unassigned-name">' + esc(t.merchant_name || t.name || 'Unknown') + '</div>' +
                        '<div class="fin-tx-amount ' + (isDebit ? 'debit' : 'credit') + '" style="font-size:12px">' + (isDebit ? '-' : '+') + fmt$(Math.abs(t.amount)) + '</div>' +
                    '</div>' +
                    '<button class="fin-assign-btn" data-action="assign-click" data-txid="' + esc(t.transaction_id) + '" title="Assign to project">▸</button>' +
                '</div>';
            });
        }
        html += '</div></div>';

        // Right panel — project columns
        html += '<div class="fin-projects-right">';
        if (projects.length === 0) {
            html += '<div class="fin-empty" style="padding:20px">No projects found. Connect Dropbox to see project folders.</div>';
        } else {
            projects.forEach(function(proj) {
                var assigned = transactions.filter(function(t) { return t._project === proj; });
                var total = assigned.reduce(function(sum, t) { return sum + Math.abs(t.amount); }, 0);

                html += '<div class="fin-project-col" data-project="' + esc(proj) + '">' +
                    '<div class="fin-project-col-header">' +
                        '<div class="fin-project-name">' + esc(proj) + '</div>' +
                        '<div class="fin-project-total">' + fmt$(total) + '</div>' +
                    '</div>' +
                    '<div class="fin-project-drop-zone" data-project="' + esc(proj) + '">';
                if (assigned.length === 0) {
                    html += '<div class="fin-drop-placeholder">Drop transactions here</div>';
                } else {
                    assigned.forEach(function(t) {
                        var isDebit = t.amount > 0;
                        html += '<div class="fin-project-tx">' +
                            '<div class="fin-project-tx-info">' +
                                '<span class="fin-project-tx-name">' + esc(t.merchant_name || t.name || 'Unknown') + '</span>' +
                                '<span class="fin-tx-amount ' + (isDebit ? 'debit' : 'credit') + '" style="font-size:12px">' + (isDebit ? '-' : '+') + fmt$(Math.abs(t.amount)) + '</span>' +
                            '</div>' +
                            '<button class="fin-unassign-btn" data-action="unassign" data-txid="' + esc(t.transaction_id) + '" title="Remove from project">&times;</button>' +
                        '</div>';
                    });
                }
                html += '</div></div>';
            });
        }
        html += '</div></div>';

        return html;
    }

    // ── Connect Tab (preserved) ──

    function renderConnect() {
        var html = '';

        if (!connectionStatus.configured) {
            html += '<div class="fin-connect-cta">' +
                '<h3>Plaid Not Configured</h3>' +
                '<p>Add your PLAID_CLIENT_ID and PLAID_SECRET to the .env file to enable bank connections.</p>' +
            '</div>';
            return html;
        }

        if (!connectionStatus.connected) {
            html += '<div class="fin-connect-cta">' +
                '<h3>Connect Your Bank Account</h3>' +
                '<p>Securely link your business bank account via Plaid to automatically import transactions.</p>' +
                '<button class="fin-btn fin-btn-primary" id="fin-connect-btn">Connect Bank Account</button>' +
            '</div>';
            return html;
        }

        // Connected state
        html += '<div class="fin-card">' +
            '<div class="fin-card-title">Connection Status</div>' +
            '<div class="fin-conn-info">' +
                '<div class="fin-conn-row">' +
                    '<span class="fin-conn-label">Status</span>' +
                    '<span class="fin-conn-value"><span class="fin-status-dot connected"></span>Connected</span>' +
                '</div>' +
                '<div class="fin-conn-row">' +
                    '<span class="fin-conn-label">Connected At</span>' +
                    '<span class="fin-conn-value">' + (connectedAt ? new Date(connectedAt).toLocaleDateString() : connectionStatus.connectedAt ? new Date(connectionStatus.connectedAt).toLocaleDateString() : 'Unknown') + '</span>' +
                '</div>' +
            '</div>' +
        '</div>';

        if (accounts.length > 0) {
            html += '<div class="fin-card">' +
                '<div class="fin-card-title">Linked Accounts</div>';
            accounts.forEach(function(a) {
                var bal = a.balances && a.balances.current != null ? a.balances.current : 0;
                html += '<div class="fin-conn-row">' +
                    '<div>' +
                        '<div style="color:var(--fin-text);font-weight:500;font-size:14px">' + esc(a.name || a.official_name || 'Account') + '</div>' +
                        '<div style="color:var(--fin-text-muted);font-size:12px;margin-top:2px">' + esc(a.subtype || a.type || '') + (a.mask ? ' ••••' + a.mask : '') + '</div>' +
                    '</div>' +
                    '<div style="font-family:var(--fin-font-mono);color:var(--fin-text);font-size:16px;font-weight:600">' + fmt$(bal) + '</div>' +
                '</div>';
            });
            html += '</div>';
        }

        html += '<div style="margin-top:20px;text-align:center">' +
            '<button class="fin-btn fin-btn-danger" id="fin-disconnect-btn">Disconnect Bank</button>' +
        '</div>';

        return html;
    }

    // ── Event binding ──

    function bindEvents() {
        if (!container) return;

        container.addEventListener('click', function(e) {
            // Close any open dropdown
            var existingDd = document.querySelector('.fin-dropdown');
            if (existingDd && !e.target.closest('.fin-dropdown')) {
                existingDd.remove();
            }

            // Tab switching
            var tab = e.target.closest('.fin-tab');
            if (tab) {
                activeTab = tab.dataset.tab;
                if ((activeTab === 'overview' || activeTab === 'transactions') && connectionStatus.connected && transactions.length === 0) {
                    fetchTransactions();
                    return;
                }
                if (activeTab === 'projects' && projects.length === 0) {
                    fetchProjects().then(function() { refresh(); });
                    return;
                }
                refresh();
                return;
            }

            // Time filter pills
            var pill = e.target.closest('.fin-pill[data-days]');
            if (pill) {
                dateRange = parseInt(pill.dataset.days, 10);
                fetchTransactions();
                return;
            }

            // Transaction filter pills
            var txPill = e.target.closest('.fin-pill[data-txfilter]');
            if (txPill) {
                txFilter = txPill.dataset.txfilter;
                refreshContent();
                return;
            }

            // CTA connect / connect btn
            if (e.target.closest('#fin-cta-connect') || e.target.closest('#fin-connect-btn')) {
                startPlaidLink();
                return;
            }

            // Disconnect
            if (e.target.closest('#fin-disconnect-btn')) {
                if (confirm('Disconnect your bank account? Transaction data will remain.')) {
                    disconnectBank();
                }
                return;
            }

            // Project tag dropdown
            var tagEl = e.target.closest('[data-action="tag"]');
            if (tagEl) {
                e.stopPropagation();
                showProjectDropdown(tagEl, tagEl.dataset.txid);
                return;
            }

            // Accounted checkbox
            var checkEl = e.target.closest('[data-action="check"]');
            if (checkEl) {
                e.stopPropagation();
                var txid = checkEl.dataset.txid;
                var tx = transactions.find(function(t) { return t.transaction_id === txid; });
                var newVal = tx ? !tx._accountedFor : true;
                saveMeta(txid, { accountedFor: newVal });
                if (newVal) checkEl.classList.add('checked');
                else checkEl.classList.remove('checked');
                return;
            }

            // Unassign from project
            var unassignBtn = e.target.closest('[data-action="unassign"]');
            if (unassignBtn) {
                e.stopPropagation();
                saveMeta(unassignBtn.dataset.txid, { project: null }).then(function() { refresh(); });
                return;
            }

            // Click-to-assign in projects tab
            var assignBtn = e.target.closest('[data-action="assign-click"]');
            if (assignBtn) {
                e.stopPropagation();
                showProjectDropdown(assignBtn, assignBtn.dataset.txid, true);
                return;
            }

            // Transaction row expand
            var row = e.target.closest('.fin-tx-row');
            if (row && !e.target.closest('[data-action]')) {
                var txid2 = row.dataset.txid;
                expandedTxId = expandedTxId === txid2 ? null : txid2;
                refreshContent();
                return;
            }
        });

        // Search input
        container.addEventListener('input', function(e) {
            if (e.target.id === 'fin-search') {
                searchQuery = e.target.value;
                refreshContent();
            }
            if (e.target.classList.contains('fin-notes-input')) {
                var txid = e.target.dataset.txid;
                var val = e.target.value;
                clearTimeout(e.target._saveTimer);
                e.target._saveTimer = setTimeout(function() {
                    saveMeta(txid, { notes: val });
                }, 600);
            }
        });

        // Drag and drop for projects tab
        container.addEventListener('dragstart', function(e) {
            var row = e.target.closest('.fin-unassigned-row');
            if (row) {
                dragTxId = row.dataset.txid;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', dragTxId);
                row.classList.add('dragging');
            }
        });

        container.addEventListener('dragend', function(e) {
            var row = e.target.closest('.fin-unassigned-row');
            if (row) row.classList.remove('dragging');
            dragTxId = null;
            // Remove all drag-over styles
            container.querySelectorAll('.drag-over').forEach(function(el) { el.classList.remove('drag-over'); });
        });

        container.addEventListener('dragover', function(e) {
            var zone = e.target.closest('.fin-project-drop-zone');
            if (zone && dragTxId) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                zone.classList.add('drag-over');
            }
        });

        container.addEventListener('dragleave', function(e) {
            var zone = e.target.closest('.fin-project-drop-zone');
            if (zone) zone.classList.remove('drag-over');
        });

        container.addEventListener('drop', function(e) {
            var zone = e.target.closest('.fin-project-drop-zone');
            if (zone && dragTxId) {
                e.preventDefault();
                var proj = zone.dataset.project;
                saveMeta(dragTxId, { project: proj }).then(function() {
                    showToast('Assigned to ' + proj);
                    refresh();
                });
                dragTxId = null;
            }
        });
    }

    function showProjectDropdown(anchor, txid, refreshAfter) {
        var existing = document.querySelector('.fin-dropdown');
        if (existing) existing.remove();

        var rect = anchor.getBoundingClientRect();
        var dd = document.createElement('div');
        dd.className = 'fin-dropdown';
        dd.style.top = (rect.bottom + 4) + 'px';
        dd.style.left = rect.left + 'px';

        var html = '';
        projects.forEach(function(p) {
            html += '<div class="fin-dropdown-item" data-project="' + esc(p) + '">' + esc(p) + '</div>';
        });
        html += '<div class="fin-dropdown-item" data-project="" style="color:var(--fin-text-muted);border-top:1px solid var(--fin-border-light);margin-top:4px;padding-top:12px">Clear project</div>';
        dd.innerHTML = html;

        dd.addEventListener('click', function(e) {
            var item = e.target.closest('.fin-dropdown-item');
            if (!item) return;
            var proj = item.dataset.project;
            saveMeta(txid, { project: proj || null }).then(function() {
                if (refreshAfter) refresh();
                else refreshContent();
            });
            dd.remove();
        });

        document.body.appendChild(dd);

        setTimeout(function() {
            document.addEventListener('click', function handler(e2) {
                if (!dd.contains(e2.target)) {
                    dd.remove();
                    document.removeEventListener('click', handler);
                }
            });
        }, 10);
    }

    function refreshContent() {
        if (!container) return;
        var contentEl = container.querySelector('#fin-content');
        if (contentEl) {
            contentEl.innerHTML = loading ? '<div class="fin-loading"><div class="fin-spinner"></div><div style="margin-top:12px">Loading transactions...</div></div>' : renderTab();
        }
    }

    function refresh() {
        if (!container) return;
        container.innerHTML = render();
        bindEvents();
    }

    // ── Public API ──

    return {
        open: async function(bodyEl) {
            container = bodyEl;
            container.innerHTML = render();
            bindEvents();
            await fetchStatus();
            if (connectionStatus.connected) {
                await Promise.all([fetchAccounts(), fetchTransactions(), fetchProjects()]);
            } else {
                refresh();
            }
            loadPlaidLink(function() {});
        },
        close: function() {
            var dd = document.querySelector('.fin-dropdown');
            if (dd) dd.remove();
            var toast = document.querySelector('.fin-toast');
            if (toast) toast.remove();
            container = null;
            activeTab = 'overview';
            expandedTxId = null;
            searchQuery = '';
            txFilter = 'all';
            loading = false;
            dragTxId = null;
        }
    };
})();

window.FinanceUI = FinanceUI;

BuildingRegistry.register('Finance', {
    open: function(bodyEl, opts) { FinanceUI.open(bodyEl, opts); },
    close: function() { FinanceUI.close(); }
});
