// finance-ui.js — Finance building dashboard with Plaid bank integration
const FinanceUI = (() => {
    let container = null;
    let activeTab = 'overview';
    let transactions = [];
    let accounts = [];
    let connectedAt = null;
    let connectionStatus = { configured: false, connected: false, connectedAt: null };
    let transactionMeta = {}; // { transactionId: { project, category, accountedFor, notes } }
    let expandedTxId = null;
    let searchQuery = '';
    let dateFilter = '90d';
    let projectFilter = 'all';
    let accountedFilter = 'all';
    let customProjects = [];
    let plaidLinkLoaded = false;
    let loading = false;

    const STORAGE_KEY = 'finance-custom-projects';

    const DEFAULT_PROJECTS = ['Chocolate Bar', 'Videos', 'Equipment', 'Office/Admin', 'Personal', 'Other'];

    const PROJECT_TAG_CLASS = {
        'Chocolate Bar': 'fin-tag-choc',
        'Videos': 'fin-tag-videos',
        'Equipment': 'fin-tag-equipment',
        'Office/Admin': 'fin-tag-office',
        'Personal': 'fin-tag-personal',
        'Other': 'fin-tag-other'
    };

    const PROJECT_COLORS = {
        'Chocolate Bar': '#d4915c',
        'Videos': '#60a5fa',
        'Equipment': '#c084fc',
        'Office/Admin': '#fbbf24',
        'Personal': '#94a3b8',
        'Other': '#64748b'
    };

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

    function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    function fmt$(n) {
        var num = parseFloat(n) || 0;
        var neg = num < 0;
        var abs = Math.abs(num).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (neg ? '-' : '') + '$' + abs;
    }

    function getAllProjects() {
        return DEFAULT_PROJECTS.concat(customProjects);
    }

    function loadCustomProjects() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) customProjects = JSON.parse(raw);
        } catch (e) { /* ignore */ }
    }

    function saveCustomProjects() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(customProjects));
    }

    function getDateRange() {
        var end = new Date();
        var start = new Date();
        if (dateFilter === '7d') start.setDate(end.getDate() - 7);
        else if (dateFilter === '30d') start.setDate(end.getDate() - 30);
        else if (dateFilter === '90d') start.setDate(end.getDate() - 90);
        else { start.setFullYear(end.getFullYear() - 2); } // 'all'
        return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
    }

    // API calls
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
            var range = getDateRange();
            var resp = await fetch('/api/finance/transactions?start=' + range.start + '&end=' + range.end);
            var data = await resp.json();
            if (data.transactions) {
                transactions = data.transactions;
                accounts = data.accounts || [];
                connectedAt = data.connectedAt;
                // Build local meta map from merged data
                transactions.forEach(function(t) {
                    if (t._project || t._category || t._accountedFor || t._notes) {
                        transactionMeta[t.transaction_id] = {
                            project: t._project,
                            category: t._category,
                            accountedFor: t._accountedFor,
                            notes: t._notes
                        };
                    }
                });
            }
        } catch (e) {
            console.error('Finance: fetch transactions failed', e);
        }
        loading = false;
        refresh();
    }

    async function saveMeta(transactionId, updates) {
        var existing = transactionMeta[transactionId] || {};
        var merged = Object.assign({}, existing, updates);
        transactionMeta[transactionId] = merged;
        try {
            await fetch('/api/finance/transaction-meta', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transactionId: transactionId,
                    project: merged.project || null,
                    category: merged.category || null,
                    accountedFor: !!merged.accountedFor,
                    notes: merged.notes || ''
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

    // Plaid Link
    function loadPlaidLink(callback) {
        if (plaidLinkLoaded) { callback(); return; }
        var script = document.createElement('script');
        script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
        script.onload = function() { plaidLinkLoaded = true; callback(); };
        script.onerror = function() { showToast('Failed to load Plaid Link'); };
        document.head.appendChild(script);
    }

    async function startPlaidLink() {
        try {
            var resp = await fetch('/api/finance/link-token', { method: 'POST' });
            var data = await resp.json();
            if (!data.link_token) { showToast(data.error || 'Failed to get link token'); return; }
            loadPlaidLink(function() {
                var handler = Plaid.create({
                    token: data.link_token,
                    onSuccess: async function(publicToken, metadata) {
                        showToast('Connecting...');
                        try {
                            await fetch('/api/finance/exchange-token', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ public_token: publicToken })
                            });
                            showToast('Bank connected!');
                            await fetchStatus();
                            await fetchTransactions();
                        } catch (e) {
                            showToast('Failed to connect bank');
                        }
                    },
                    onExit: function(err) {
                        if (err) console.warn('Plaid Link exited with error', err);
                    }
                });
                handler.open();
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

    // Filtering
    function getFilteredTransactions() {
        var list = transactions;
        if (searchQuery) {
            var q = searchQuery.toLowerCase();
            list = list.filter(function(t) {
                return (t.name || '').toLowerCase().includes(q) ||
                       (t.merchant_name || '').toLowerCase().includes(q) ||
                       (t.transaction_id || '').toLowerCase().includes(q);
            });
        }
        if (projectFilter !== 'all') {
            if (projectFilter === 'unassigned') {
                list = list.filter(function(t) {
                    var m = transactionMeta[t.transaction_id];
                    return !m || !m.project;
                });
            } else {
                list = list.filter(function(t) {
                    var m = transactionMeta[t.transaction_id];
                    return m && m.project === projectFilter;
                });
            }
        }
        if (accountedFilter === 'unaccounted') {
            list = list.filter(function(t) {
                var m = transactionMeta[t.transaction_id];
                return !m || !m.accountedFor;
            });
        } else if (accountedFilter === 'accounted') {
            list = list.filter(function(t) {
                var m = transactionMeta[t.transaction_id];
                return m && m.accountedFor;
            });
        }
        return list;
    }

    // Render functions
    function render() {
        var html = '<div class="fin-panel">' +
            '<div class="fin-header">' +
                '<h2 class="fin-header-title">Finance</h2>' +
                '<div class="fin-header-subtitle">Personal CFO Dashboard</div>' +
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
        return html;
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

    function renderOverview() {
        // Account balances
        var totalBalance = 0;
        var accountHtml = '';
        accounts.forEach(function(a) {
            var bal = a.balances && a.balances.current != null ? a.balances.current : 0;
            totalBalance += bal;
            accountHtml += '<div class="fin-summary-row">' +
                '<span>' + esc(a.name || a.official_name || 'Account') + '</span>' +
                '<span style="font-family:var(--fin-font-mono);color:var(--fin-text)">' + fmt$(bal) + '</span>' +
            '</div>';
        });

        // Monthly income/spend
        var now = new Date();
        var monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        var monthTx = transactions.filter(function(t) { return t.date >= monthStart; });
        var monthSpend = 0;
        var monthIncome = 0;
        monthTx.forEach(function(t) {
            var amt = t.amount || 0;
            if (amt > 0) monthSpend += amt;
            else monthIncome += Math.abs(amt);
        });

        // Top categories
        var catTotals = {};
        transactions.forEach(function(t) {
            if (t.amount > 0) {
                var cat = (t.personal_finance_category && t.personal_finance_category.primary) || (t.category && t.category[0]) || 'Other';
                catTotals[cat] = (catTotals[cat] || 0) + t.amount;
            }
        });
        var catSorted = Object.entries(catTotals).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 6);
        var catMax = catSorted.length > 0 ? catSorted[0][1] : 1;

        var catColors = ['#4ade80', '#60a5fa', '#c084fc', '#fbbf24', '#f87171', '#94a3b8'];
        var catBarsHtml = catSorted.map(function(entry, i) {
            var pct = Math.round((entry[1] / catMax) * 100);
            return '<div class="fin-bar-row">' +
                '<div class="fin-bar-label">' + esc(entry[0]) + '</div>' +
                '<div class="fin-bar-track"><div class="fin-bar-fill" style="width:' + pct + '%;background:' + catColors[i % catColors.length] + '"></div></div>' +
                '<div class="fin-bar-value">' + fmt$(entry[1]) + '</div>' +
            '</div>';
        }).join('');

        // Unaccounted count
        var unaccounted = transactions.filter(function(t) {
            var m = transactionMeta[t.transaction_id];
            return !m || !m.accountedFor;
        }).length;

        var html = '';

        if (unaccounted > 0) {
            html += '<div class="fin-banner fin-banner-warn">' + unaccounted + ' transaction' + (unaccounted === 1 ? '' : 's') + ' need review</div>';
        }

        // Metrics
        html += '<div class="fin-metrics">' +
            '<div class="fin-metric">' +
                '<div class="fin-metric-value" style="color:var(--fin-text)">' + fmt$(totalBalance) + '</div>' +
                '<div class="fin-metric-label">Net Balance</div>' +
            '</div>' +
            '<div class="fin-metric">' +
                '<div class="fin-metric-value" style="color:var(--fin-red)">' + fmt$(monthSpend) + '</div>' +
                '<div class="fin-metric-label">Spending (This Month)</div>' +
            '</div>' +
            '<div class="fin-metric">' +
                '<div class="fin-metric-value" style="color:var(--fin-green)">' + fmt$(monthIncome) + '</div>' +
                '<div class="fin-metric-label">Income (This Month)</div>' +
            '</div>' +
            '<div class="fin-metric">' +
                '<div class="fin-metric-value">' + transactions.length + '</div>' +
                '<div class="fin-metric-label">Transactions</div>' +
            '</div>' +
        '</div>';

        // Accounts
        if (accountHtml) {
            html += '<div class="fin-card">' +
                '<div class="fin-card-title">Accounts</div>' +
                accountHtml +
            '</div>';
        }

        // Category chart
        if (catBarsHtml) {
            html += '<div class="fin-card">' +
                '<div class="fin-card-title">Top Spending Categories</div>' +
                '<div class="fin-bar-chart">' + catBarsHtml + '</div>' +
            '</div>';
        }

        return html;
    }

    function renderTransactions() {
        var filtered = getFilteredTransactions();
        var unaccounted = transactions.filter(function(t) {
            var m = transactionMeta[t.transaction_id];
            return !m || !m.accountedFor;
        }).length;

        var html = '';

        if (unaccounted > 0) {
            html += '<div class="fin-banner fin-banner-warn">' + unaccounted + ' transaction' + (unaccounted === 1 ? '' : 's') + ' need review</div>';
        }

        // Filters
        var projectOpts = '<option value="all">All Projects</option><option value="unassigned">Unassigned</option>';
        getAllProjects().forEach(function(p) {
            projectOpts += '<option value="' + esc(p) + '"' + (projectFilter === p ? ' selected' : '') + '>' + esc(p) + '</option>';
        });

        html += '<div class="fin-filters">' +
            '<input type="text" class="fin-search" id="fin-search" placeholder="Search transactions..." value="' + esc(searchQuery) + '">' +
            '<select class="fin-select" id="fin-date-filter">' +
                '<option value="7d"' + (dateFilter === '7d' ? ' selected' : '') + '>Last 7 days</option>' +
                '<option value="30d"' + (dateFilter === '30d' ? ' selected' : '') + '>Last 30 days</option>' +
                '<option value="90d"' + (dateFilter === '90d' ? ' selected' : '') + '>Last 90 days</option>' +
                '<option value="all"' + (dateFilter === 'all' ? ' selected' : '') + '>All time</option>' +
            '</select>' +
            '<select class="fin-select" id="fin-project-filter">' + projectOpts + '</select>' +
            '<select class="fin-select" id="fin-accounted-filter">' +
                '<option value="all"' + (accountedFilter === 'all' ? ' selected' : '') + '>All</option>' +
                '<option value="unaccounted"' + (accountedFilter === 'unaccounted' ? ' selected' : '') + '>Unaccounted</option>' +
                '<option value="accounted"' + (accountedFilter === 'accounted' ? ' selected' : '') + '>Accounted</option>' +
            '</select>' +
        '</div>';

        if (filtered.length === 0) {
            html += '<div class="fin-empty">No transactions match your filters</div>';
            return html;
        }

        html += '<div class="fin-tx-list">';
        filtered.forEach(function(t) {
            var meta = transactionMeta[t.transaction_id] || {};
            var isDebit = t.amount > 0;
            var project = meta.project || null;
            var tagClass = project ? (PROJECT_TAG_CLASS[project] || 'fin-tag-other') : 'fin-tag-none';
            var tagLabel = project || '+ project';
            var checked = meta.accountedFor ? ' checked' : '';

            html += '<div class="fin-tx-row" data-txid="' + esc(t.transaction_id) + '">' +
                '<div class="fin-tx-date">' + esc(t.date) + '</div>' +
                '<div class="fin-tx-desc" title="' + esc(t.name) + '">' + esc(t.name || t.merchant_name || 'Unknown') + '</div>' +
                '<div class="fin-tx-amount ' + (isDebit ? 'debit' : 'credit') + '">' + (isDebit ? '-' : '+') + fmt$(Math.abs(t.amount)) + '</div>' +
                '<div class="fin-tag ' + tagClass + '" data-action="tag" data-txid="' + esc(t.transaction_id) + '">' + esc(tagLabel) + '</div>' +
                '<div style="text-align:center"><button class="fin-check' + checked + '" data-action="check" data-txid="' + esc(t.transaction_id) + '">&#10003;</button></div>' +
                '<div></div>' +
            '</div>';

            // Expanded detail
            if (expandedTxId === t.transaction_id) {
                html += '<div class="fin-tx-detail">' +
                    '<div class="fin-tx-detail-grid">' +
                        '<div><div class="fin-tx-detail-label">Merchant</div><div class="fin-tx-detail-value">' + esc(t.merchant_name || 'N/A') + '</div></div>' +
                        '<div><div class="fin-tx-detail-label">Amount</div><div class="fin-tx-detail-value" style="color:' + (isDebit ? 'var(--fin-red)' : 'var(--fin-green)') + '">' + (isDebit ? '-' : '+') + fmt$(Math.abs(t.amount)) + '</div></div>' +
                        '<div><div class="fin-tx-detail-label">Category</div><div class="fin-tx-detail-value">' + esc((t.personal_finance_category && t.personal_finance_category.primary) || (t.category && t.category[0]) || 'N/A') + '</div></div>' +
                        '<div><div class="fin-tx-detail-label">Account</div><div class="fin-tx-detail-value">' + esc(t.account_id ? t.account_id.slice(0, 8) + '...' : 'N/A') + '</div></div>' +
                        '<div><div class="fin-tx-detail-label">Transaction ID</div><div class="fin-tx-detail-value" style="font-family:var(--fin-font-mono);font-size:11px">' + esc(t.transaction_id) + '</div></div>' +
                        '<div><div class="fin-tx-detail-label">Pending</div><div class="fin-tx-detail-value">' + (t.pending ? 'Yes' : 'No') + '</div></div>' +
                    '</div>' +
                    '<div class="fin-tx-detail-label" style="margin-bottom:6px">Notes</div>' +
                    '<textarea class="fin-notes-input" data-txid="' + esc(t.transaction_id) + '" placeholder="Add notes...">' + esc(meta.notes || '') + '</textarea>' +
                '</div>';
            }
        });
        html += '</div>';

        return html;
    }

    function renderProjects() {
        var allProj = getAllProjects();
        var totalSpend = 0;
        var projectData = {};

        allProj.forEach(function(p) { projectData[p] = { total: 0, count: 0 }; });
        projectData['Unassigned'] = { total: 0, count: 0 };

        transactions.forEach(function(t) {
            if (t.amount <= 0) return; // Only count debits
            var meta = transactionMeta[t.transaction_id] || {};
            var proj = meta.project || 'Unassigned';
            if (!projectData[proj]) projectData[proj] = { total: 0, count: 0 };
            projectData[proj].total += t.amount;
            projectData[proj].count++;
            totalSpend += t.amount;
        });

        var html = '<div class="fin-project-grid">';

        // Show all projects including unassigned
        var projEntries = Object.entries(projectData).filter(function(e) { return e[1].count > 0 || allProj.includes(e[0]); });
        projEntries.forEach(function(entry) {
            var name = entry[0];
            var data = entry[1];
            var pct = totalSpend > 0 ? Math.round((data.total / totalSpend) * 100) : 0;
            var color = PROJECT_COLORS[name] || '#64748b';

            html += '<div class="fin-project-card">' +
                '<div class="fin-project-name">' + esc(name) + '</div>' +
                '<div class="fin-project-stat"><span>Total Spent</span><span class="fin-project-stat-value">' + fmt$(data.total) + '</span></div>' +
                '<div class="fin-project-stat"><span>Transactions</span><span class="fin-project-stat-value">' + data.count + '</span></div>' +
                '<div class="fin-project-stat"><span>% of Total</span><span class="fin-project-stat-value">' + pct + '%</span></div>' +
                '<div class="fin-progress"><div class="fin-progress-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
            '</div>';
        });

        html += '</div>';

        // Add custom project button
        html += '<div style="margin-top:20px;text-align:center">' +
            '<button class="fin-btn fin-btn-secondary" id="fin-add-project">+ Add Custom Project</button>' +
        '</div>';

        return html;
    }

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

        // Account list
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

    // Event binding
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
                if (activeTab === 'overview' || activeTab === 'transactions') {
                    if (connectionStatus.connected && transactions.length === 0) {
                        fetchTransactions();
                        return;
                    }
                }
                refresh();
                return;
            }

            // CTA connect button
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

            // Add custom project
            if (e.target.closest('#fin-add-project')) {
                var name = prompt('Enter project name:');
                if (name && name.trim()) {
                    name = name.trim();
                    if (!getAllProjects().includes(name)) {
                        customProjects.push(name);
                        saveCustomProjects();
                        refresh();
                    }
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
                var meta = transactionMeta[txid] || {};
                var newVal = !meta.accountedFor;
                saveMeta(txid, { accountedFor: newVal });
                if (newVal) {
                    checkEl.classList.add('checked');
                } else {
                    checkEl.classList.remove('checked');
                }
                return;
            }

            // Transaction row expand
            var row = e.target.closest('.fin-tx-row');
            if (row && !e.target.closest('[data-action]')) {
                var txid2 = row.dataset.txid;
                expandedTxId = expandedTxId === txid2 ? null : txid2;
                refresh();
                return;
            }
        });

        // Search input
        container.addEventListener('input', function(e) {
            if (e.target.id === 'fin-search') {
                searchQuery = e.target.value;
                refreshContent();
            }
            // Notes auto-save
            if (e.target.classList.contains('fin-notes-input')) {
                var txid = e.target.dataset.txid;
                var val = e.target.value;
                clearTimeout(e.target._saveTimer);
                e.target._saveTimer = setTimeout(function() {
                    saveMeta(txid, { notes: val });
                }, 600);
            }
        });

        // Select filters
        container.addEventListener('change', function(e) {
            if (e.target.id === 'fin-date-filter') {
                dateFilter = e.target.value;
                fetchTransactions();
            }
            if (e.target.id === 'fin-project-filter') {
                projectFilter = e.target.value;
                refreshContent();
            }
            if (e.target.id === 'fin-accounted-filter') {
                accountedFilter = e.target.value;
                refreshContent();
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

        var projects = getAllProjects();
        var html = '';
        projects.forEach(function(p) {
            html += '<div class="fin-dropdown-item" data-project="' + esc(p) + '">' + esc(p) + '</div>';
        });
        html += '<div class="fin-dropdown-item" data-project="" style="color:var(--fin-text-muted);border-top:1px solid var(--fin-border-light);margin-top:4px;padding-top:12px">Clear project</div>';
        html += '<div class="fin-dropdown-item" data-project="__new" style="color:var(--fin-accent)">+ New project</div>';
        dd.innerHTML = html;

        dd.addEventListener('click', function(e) {
            var item = e.target.closest('.fin-dropdown-item');
            if (!item) return;
            var proj = item.dataset.project;
            if (proj === '__new') {
                var name = prompt('Enter project name:');
                if (name && name.trim()) {
                    name = name.trim();
                    if (!getAllProjects().includes(name)) {
                        customProjects.push(name);
                        saveCustomProjects();
                    }
                    saveMeta(txid, { project: name });
                }
            } else {
                saveMeta(txid, { project: proj || null });
            }
            dd.remove();
            refresh();
        });

        document.body.appendChild(dd);

        // Close on outside click
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
        // Re-bind won't be needed since we use event delegation on container
    }

    function refresh() {
        if (!container) return;
        container.innerHTML = render();
        bindEvents();
    }

    // Public API
    return {
        open: async function(bodyEl) {
            container = bodyEl;
            loadCustomProjects();
            container.innerHTML = render();
            bindEvents();
            // Fetch status, then auto-load
            await fetchStatus();
            if (connectionStatus.connected) {
                await fetchTransactions();
            } else {
                refresh();
            }
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
            loading = false;
        }
    };
})();

window.FinanceUI = FinanceUI;

BuildingRegistry.register('Finance', {
    open: function(bodyEl, opts) { FinanceUI.open(bodyEl, opts); },
    close: function() { FinanceUI.close(); }
});
