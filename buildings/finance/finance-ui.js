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
    let plaidLinkLoaded = false;
    let loading = false;
    let dragTxId = null;
    let projectLastUsed = {}; // projectName → timestamp, updated on assign
    let expandedTxIds = new Set();

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
        { id: 'connect', label: 'Connect' }
    ];

    const TAB_ICONS = {
        overview: '<svg viewBox="0 0 24 24"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>',
        transactions: '<svg viewBox="0 0 24 24"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>',
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

    async function fetchAllTransactions() {
        if (!connectionStatus.connected) return;
        loading = true;
        refresh();
        try {
            var resp = await fetch('/api/finance/transactions?start=2000-01-01&end=' + getEndDate());
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

    async function fetchTransactions() {
        if (!connectionStatus.connected) return;
        loading = true;
        refresh();
        try {
            var start = activeTab === 'transactions' ? '2000-01-01' : getStartDate();
            var resp = await fetch('/api/finance/transactions?start=' + start + '&end=' + getEndDate());
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

        // Compute metrics from transactions (filtered by dateRange)
        var totalIncome = 0, totalSpent = 0;
        transactions.forEach(function(t) {
            if (t.amount < 0) totalIncome += Math.abs(t.amount);
            else totalSpent += t.amount;
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
        '</div>';

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

    // ── Transactions Tab — split-screen categorizer ──

    function getSortedProjects() {
        var sorted = projects.slice();
        sorted.sort(function(a, b) {
            var tA = projectLastUsed[a] || 0;
            var tB = projectLastUsed[b] || 0;
            return tB - tA;
        });
        return sorted;
    }

    function renderTxDetail(t) {
        var fields = [];

        if (t.merchant_name) fields.push(['Merchant', esc(t.merchant_name)]);
        if (t.name && t.name !== t.merchant_name) fields.push(['Description', esc(t.name)]);

        var dateStr = esc(t.date);
        if (t.authorized_date && t.authorized_date !== t.date) dateStr += ' (auth: ' + esc(t.authorized_date) + ')';
        fields.push(['Date', dateStr]);

        var isDebit = t.amount > 0;
        fields.push(['Amount', '<span class="fin-tx-amount ' + (isDebit ? 'debit' : 'credit') + '">' + (isDebit ? '-' : '+') + fmt$(Math.abs(t.amount)) + '</span>']);

        fields.push(['Account', esc(getAccountName(t.account_id))]);

        if (t.payment_channel) fields.push(['Payment Channel', esc(t.payment_channel)]);
        fields.push(['Pending', t.pending ? 'Yes' : 'No']);

        // Location
        if (t.location) {
            var locParts = [];
            if (t.location.address) locParts.push(t.location.address);
            if (t.location.city) locParts.push(t.location.city);
            if (t.location.region) locParts.push(t.location.region);
            if (t.location.country) locParts.push(t.location.country);
            if (locParts.length > 0) fields.push(['Location', esc(locParts.join(', '))]);
        }

        // Counterparties
        if (t.counterparties && t.counterparties.length > 0) {
            var cpHtml = t.counterparties.map(function(cp) {
                return esc(cp.name || 'Unknown') + (cp.type ? ' (' + esc(cp.type) + ')' : '');
            }).join(', ');
            fields.push(['Counterparties', cpHtml]);
        }

        // Category
        if (t.personal_finance_category) {
            var catStr = esc(t.personal_finance_category.primary || '');
            if (t.personal_finance_category.detailed) catStr += ' › ' + esc(t.personal_finance_category.detailed);
            if (catStr) fields.push(['Category', catStr]);
        }

        fields.push(['Transaction ID', '<span style="font-family:var(--fin-font-mono);font-size:11px">' + esc(t.transaction_id) + '</span>']);

        if (t.website) fields.push(['Website', esc(t.website)]);

        var html = '<div class="fin-expand-detail">';
        fields.forEach(function(f) {
            html += '<div class="fin-detail-row">' +
                '<span class="fin-detail-label">' + f[0] + '</span>' +
                '<span class="fin-detail-value">' + f[1] + '</span>' +
            '</div>';
        });

        // Notes textarea
        html += '<div class="fin-detail-row" style="flex-direction:column;align-items:stretch;gap:4px">' +
            '<span class="fin-detail-label">Notes</span>' +
            '<textarea class="fin-notes-input fin-expand-notes" data-txid="' + esc(t.transaction_id) + '" placeholder="Add notes...">' + esc(t._notes || '') + '</textarea>' +
        '</div>';

        // Quick-assign project dropdown
        html += '<div class="fin-detail-row" style="margin-top:6px">' +
            '<span class="fin-detail-label">Assign Project</span>' +
            '<select class="fin-expand-project-select fin-select" data-txid="' + esc(t.transaction_id) + '" style="font-size:12px;padding:4px 8px;flex:1">' +
                '<option value="">— none —</option>';
        getSortedProjects().forEach(function(p) {
            html += '<option value="' + esc(p) + '"' + (t._project === p ? ' selected' : '') + '>' + esc(p) + '</option>';
        });
        html += '</select></div>';

        html += '</div>';
        return html;
    }

    function renderTransactions() {
        var uncategorized = transactions.filter(function(t) { return !t._project; });
        var sortedProjects = getSortedProjects();

        var html = '<div class="fin-projects-layout">';

        // LEFT panel — uncategorized transactions
        html += '<div class="fin-projects-left">' +
            '<div class="fin-card-title">Uncategorized <span style="color:var(--fin-text-muted);font-weight:400;font-size:13px;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:10px;margin-left:6px">' + uncategorized.length + '</span></div>' +
            '<div class="fin-unassigned-list" id="fin-unassigned-list">';
        if (uncategorized.length === 0) {
            html += '<div class="fin-empty" style="padding:20px">All transactions categorized!</div>';
        } else {
            uncategorized.forEach(function(t) {
                var isDebit = t.amount > 0;
                var isExpanded = expandedTxIds.has(t.transaction_id);
                html += '<div class="fin-unassigned-item' + (isExpanded ? ' expanded' : '') + '" data-txid="' + esc(t.transaction_id) + '">' +
                    '<div class="fin-unassigned-row" draggable="true" data-txid="' + esc(t.transaction_id) + '" data-action="toggle-expand">' +
                        '<span class="fin-drag-handle">⠿</span>' +
                        '<div class="fin-unassigned-info">' +
                            '<div class="fin-unassigned-name">' + esc(t.merchant_name || t.name || 'Unknown') + '</div>' +
                            '<div style="font-size:11px;color:var(--fin-text-muted)">' + esc(t.date) + '</div>' +
                        '</div>' +
                        '<div class="fin-tx-amount ' + (isDebit ? 'debit' : 'credit') + '" style="font-size:12px;white-space:nowrap">' + (isDebit ? '-' : '+') + fmt$(Math.abs(t.amount)) + '</div>' +
                        '<button class="fin-assign-btn" data-action="assign-click" data-txid="' + esc(t.transaction_id) + '" title="Assign to project">▸</button>' +
                    '</div>';
                if (isExpanded) {
                    html += renderTxDetail(t);
                }
                html += '</div>';
            });
        }
        html += '</div></div>';

        // RIGHT panel — project columns stacked vertically
        html += '<div class="fin-projects-right">';
        if (sortedProjects.length === 0) {
            html += '<div class="fin-empty" style="padding:20px">No projects found. Connect Dropbox to see project folders.</div>';
        } else {
            sortedProjects.forEach(function(proj) {
                var assigned = transactions.filter(function(t) { return t._project === proj; });
                var total = assigned.reduce(function(sum, t) { return sum + Math.abs(t.amount); }, 0);

                html += '<div class="fin-project-col" data-project="' + esc(proj) + '">' +
                    '<div class="fin-project-col-header">' +
                        '<div>' +
                            '<div class="fin-project-name">' + esc(proj) + '</div>' +
                            '<div style="font-size:11px;color:var(--fin-text-muted);margin-top:2px">' + assigned.length + ' transaction' + (assigned.length === 1 ? '' : 's') + '</div>' +
                        '</div>' +
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

    function assignToProject(txid, proj) {
        projectLastUsed[proj] = Date.now();
        saveMeta(txid, { project: proj }).then(function() {
            showToast('Assigned to ' + proj);
            refreshContent();
        });
    }

    function unassignFromProject(txid) {
        saveMeta(txid, { project: null }).then(function() {
            refreshContent();
        });
    }

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
                if (activeTab === 'overview' && connectionStatus.connected) {
                    fetchTransactions();
                    return;
                }
                if (activeTab === 'transactions' && connectionStatus.connected) {
                    // Always fetch all transactions for categorizer
                    fetchAllTransactions();
                    if (projects.length === 0) fetchProjects().then(function() { refresh(); });
                    return;
                }
                refresh();
                return;
            }

            // Time filter pills (overview only)
            var pill = e.target.closest('.fin-pill[data-days]');
            if (pill) {
                dateRange = parseInt(pill.dataset.days, 10);
                fetchTransactions();
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

            // Unassign from project
            var unassignBtn = e.target.closest('[data-action="unassign"]');
            if (unassignBtn) {
                e.stopPropagation();
                unassignFromProject(unassignBtn.dataset.txid);
                return;
            }

            // Click-to-assign in transactions tab
            var assignBtn = e.target.closest('[data-action="assign-click"]');
            if (assignBtn) {
                e.stopPropagation();
                showProjectDropdown(assignBtn, assignBtn.dataset.txid);
                return;
            }

            // Toggle expand/collapse on row header click
            var expandRow = e.target.closest('[data-action="toggle-expand"]');
            if (expandRow && !e.target.closest('.fin-drag-handle') && !e.target.closest('.fin-assign-btn')) {
                var txid = expandRow.dataset.txid;
                if (expandedTxIds.has(txid)) {
                    expandedTxIds.delete(txid);
                } else {
                    expandedTxIds.add(txid);
                }
                refreshContent();
                return;
            }
        });

        // Notes auto-save on blur
        container.addEventListener('focusout', function(e) {
            if (e.target.classList.contains('fin-expand-notes')) {
                var txid = e.target.dataset.txid;
                saveMeta(txid, { notes: e.target.value });
            }
        });

        // Quick-assign project select in expanded detail
        container.addEventListener('change', function(e) {
            if (e.target.classList.contains('fin-expand-project-select')) {
                var txid = e.target.dataset.txid;
                var proj = e.target.value;
                if (proj) {
                    assignToProject(txid, proj);
                } else {
                    unassignFromProject(txid);
                }
            }
        });

        // Search input (unused now but keep for future)
        container.addEventListener('input', function(e) {
            if (e.target.classList.contains('fin-notes-input')) {
                var txid = e.target.dataset.txid;
                var val = e.target.value;
                clearTimeout(e.target._saveTimer);
                e.target._saveTimer = setTimeout(function() {
                    saveMeta(txid, { notes: val });
                }, 600);
            }
        });

        // Prevent drag handle clicks from toggling expand
        container.addEventListener('mousedown', function(e) {
            if (e.target.closest('.fin-drag-handle')) {
                e.target.closest('.fin-drag-handle')._isDrag = true;
            }
        });

        // Drag and drop for transactions tab
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
                assignToProject(dragTxId, proj);
                dragTxId = null;
            }
        });
    }

    function showProjectDropdown(anchor, txid) {
        var existing = document.querySelector('.fin-dropdown');
        if (existing) existing.remove();

        var rect = anchor.getBoundingClientRect();
        var dd = document.createElement('div');
        dd.className = 'fin-dropdown';
        dd.style.top = (rect.bottom + 4) + 'px';
        dd.style.left = rect.left + 'px';

        var sortedProjects = getSortedProjects();
        var html = '';
        sortedProjects.forEach(function(p) {
            html += '<div class="fin-dropdown-item" data-project="' + esc(p) + '">' + esc(p) + '</div>';
        });
        html += '<div class="fin-dropdown-item" data-project="" style="color:var(--fin-text-muted);border-top:1px solid var(--fin-border-light);margin-top:4px;padding-top:12px">Clear project</div>';
        dd.innerHTML = html;

        dd.addEventListener('click', function(e) {
            var item = e.target.closest('.fin-dropdown-item');
            if (!item) return;
            var proj = item.dataset.project;
            if (proj) {
                assignToProject(txid, proj);
            } else {
                unassignFromProject(txid);
            }
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
                await Promise.all([fetchAccounts(), fetchAllTransactions(), fetchProjects()]);
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
