/* Dedicated Shorts experimentation shell. JarvisRetention owns every workflow. */
const ExperimentLabUI = (() => {
    const VIEWS = Object.freeze({
        create: {
            title: 'Auto',
            subtitle: 'Generate new openings automatically',
        },
        score: {
            title: 'Score',
            subtitle: 'Upload, build, or score from a link',
        },
        hooks: {
            title: 'Saved hooks',
            subtitle: 'Your private library and folders',
        },
        team: {
            title: 'Team',
            subtitle: 'Read-only owner oversight',
        },
    });
    const SCORE_DESTINATIONS = [
        '[data-genscore]',
        '[data-grindopen]',
        '[data-savedopen]',
        '[data-labteamhook]',
    ].join(',');
    const PRIMARY_VIEW_KEYS = Object.freeze(
        Object.keys(VIEWS).filter(key => key !== 'team')
    );

    let container = null;
    let panel = null;
    let workspace = null;
    let contextHandler = null;
    let scoreReadyHandler = null;
    let mutationObserver = null;
    let activeView = 'create';
    let currentContext = null;
    const scrollPositions = {
        create: 0,
        score: 0,
        hooks: 0,
        team: 0,
    };

    function viewButton(key) {
        const view = VIEWS[key];
        return `<button class="experiment-lab-tab" type="button" role="tab" data-lab-view="${key}" aria-selected="${key === activeView}" tabindex="${key === activeView ? 0 : -1}"><span>${view.title}</span>${key === 'hooks' ? '<small data-lab-hook-count></small>' : ''}</button>`;
    }

    function shellMarkup() {
        const view = VIEWS[activeView];
        return `
            <section class="experiment-lab-panel" data-view="${activeView}">
                <header class="experiment-lab-header">
                    <div class="experiment-lab-header-inner">
                        <div class="experiment-lab-brand">
                            <div class="experiment-lab-mark" aria-hidden="true">EL</div>
                            <div class="experiment-lab-title-block">
                                <div class="experiment-lab-kicker">Shorts intelligence</div>
                                <h2>Experiment Lab</h2>
                                <p data-experiment-lab-account>Connecting your workspace</p>
                            </div>
                        </div>
                        <div class="experiment-lab-status" data-state="loading" data-experiment-lab-status title="Canonical Shorts Quant engine in a private workspace">
                            <span aria-hidden="true"></span>
                            <b>Connecting</b>
                        </div>
                    </div>
                </header>
                <nav class="experiment-lab-tabs" aria-label="Experiment Lab" role="tablist">
                    <div class="experiment-lab-tabs-inner">${PRIMARY_VIEW_KEYS.map(viewButton).join('')}</div>
                </nav>
                <div class="experiment-lab-view-heading">
                    <div>
                        <h3 data-lab-view-title>${view.title}</h3>
                        <p data-lab-view-subtitle>${view.subtitle}</p>
                    </div>
                    <span class="experiment-lab-engine-state"><i aria-hidden="true"></i><span data-lab-activity>Ready</span></span>
                </div>
                <div id="experiment-lab-workspace" class="experiment-lab-workspace" data-lab-view="${activeView}" role="tabpanel"></div>
            </section>`;
    }

    function open(bodyEl) {
        close();
        activeView = 'create';
        currentContext = null;
        container = bodyEl;
        const modal = document.getElementById('modal');
        if (modal) modal.classList.add('experiment-lab-modal');
        container.classList.add('experiment-lab-modal-body');
        container.innerHTML = shellMarkup();
        panel = container.querySelector('.experiment-lab-panel');
        workspace = container.querySelector('#experiment-lab-workspace');
        panel.addEventListener('click', onShellClick);
        panel.addEventListener('keydown', onShellKeyDown);
        workspace.addEventListener('click', onWorkspaceClick, true);

        if (!window.JarvisRetention || typeof window.JarvisRetention.mountShortsExperiment !== 'function') {
            workspace.innerHTML = '<div class="experiment-lab-error">The Shorts experiment engine did not load. Reload Business World and try again.</div>';
            return;
        }

        contextHandler = event => renderContext(event.detail);
        scoreReadyHandler = event => revealScore(event.detail);
        workspace.addEventListener('experiment-lab-context', contextHandler);
        workspace.addEventListener(
            'experiment-lab-score-ready',
            scoreReadyHandler
        );
        mutationObserver = new MutationObserver(updateActivity);
        mutationObserver.observe(workspace, { childList: true, subtree: true });
        applyView(false);
        Promise.resolve(
            window.JarvisRetention.mountShortsExperiment(
                workspace,
                { surface: 'experiment-lab' }
            )
        ).then(() => {
            renderContext(window.JarvisRetention.getExperimentContext());
            applyView(false);
        }).catch(error => {
            setStatus('error', 'Workspace unavailable');
            workspace.innerHTML = `<div class="experiment-lab-error">${escapeHtml(error && error.message || error)}</div>`;
        });
    }

    function close() {
        if (
            workspace
            && window.JarvisRetention
            && typeof window.JarvisRetention.unmountShortsExperiment === 'function'
        ) {
            window.JarvisRetention.unmountShortsExperiment(workspace);
        }
        if (mutationObserver) mutationObserver.disconnect();
        mutationObserver = null;
        if (panel) {
            panel.removeEventListener('click', onShellClick);
            panel.removeEventListener('keydown', onShellKeyDown);
        }
        if (workspace) {
            workspace.removeEventListener('click', onWorkspaceClick, true);
            if (contextHandler) {
                workspace.removeEventListener('experiment-lab-context', contextHandler);
            }
            if (scoreReadyHandler) {
                workspace.removeEventListener(
                    'experiment-lab-score-ready',
                    scoreReadyHandler
                );
            }
        }
        const modal = document.getElementById('modal');
        if (modal) modal.classList.remove('experiment-lab-modal');
        if (container) container.classList.remove('experiment-lab-modal-body');
        container = null;
        panel = null;
        workspace = null;
        contextHandler = null;
        scoreReadyHandler = null;
        currentContext = null;
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[character]);
    }

    function setStatus(state, label) {
        if (!panel) return;
        const status = panel.querySelector('[data-experiment-lab-status]');
        if (!status) return;
        status.dataset.state = state;
        const text = status.querySelector('b');
        if (text) text.textContent = label;
    }

    function syncTeamNavigation(teamAccess) {
        if (!panel) return;
        const navigation = panel.querySelector(
            '.experiment-lab-tabs-inner'
        );
        let teamTab = panel.querySelector(
            '.experiment-lab-tab[data-lab-view="team"]'
        );
        if (!teamAccess) {
            if (activeView === 'team') setView('hooks');
            if (teamTab) teamTab.remove();
            return;
        }
        if (!teamTab && navigation) {
            navigation.insertAdjacentHTML(
                'beforeend',
                viewButton('team')
            );
            teamTab = navigation.querySelector(
                '.experiment-lab-tab[data-lab-view="team"]'
            );
        }
        if (teamTab) teamTab.hidden = false;
    }

    function renderContext(context) {
        if (!panel) return;
        currentContext = context || null;
        const accountLabel = panel.querySelector('[data-experiment-lab-account]');
        const hookCount = panel.querySelector('[data-lab-hook-count]');
        const active = context && context.activeAccount;
        const owner = !!(context && context.owner);
        const teamAccess = !!(context && context.teamAccess);
        syncTeamNavigation(teamAccess);
        if (!active) {
            setStatus('error', 'Workspace unavailable');
            if (accountLabel) accountLabel.textContent = 'Account scope unavailable';
            if (hookCount) hookCount.textContent = '';
            if (activeView === 'team') setView('hooks');
            return;
        }
        const counts = context.summary && context.summary.counts || {};
        const accountName = active.name || active.email || 'Private workspace';
        const mode = context.readOnly
            ? 'Read-only inspection'
            : owner ? 'Owner workspace' : 'Private workspace';
        setStatus('ready', mode);
        if (accountLabel) {
            accountLabel.textContent = context.readOnly
                ? `${accountName} / inspected by ${context.viewer && (context.viewer.name || context.viewer.email) || 'owner'}`
                : accountName;
        }
        if (hookCount) {
            const savedHooks = context.savedHooks || null;
            const savedState = savedHooks && savedHooks.state;
            if (savedState === 'loading') {
                hookCount.textContent = '…';
                hookCount.title = 'Loading your saved-hook library';
            } else if (savedState === 'error') {
                hookCount.textContent = '!';
                hookCount.title = savedHooks.error
                    || 'Saved-hook library unavailable';
            } else {
                const count = savedHooks
                    && Number.isFinite(+savedHooks.count)
                    ? +savedHooks.count
                    : Number.isFinite(+counts.hooks)
                        ? +counts.hooks
                        : null;
                hookCount.textContent = count == null
                    ? ''
                    : String(count);
                hookCount.title = savedState === 'saving'
                    ? `${savedHooks.pendingCount || 0} saving; ${savedHooks.canonicalCount || 0} saved`
                    : `${count || 0} saved hook${count === 1 ? '' : 's'}`;
            }
        }
        if (!teamAccess && activeView === 'team') setView('hooks');
    }

    function onShellClick(event) {
        const tab = event.target.closest('.experiment-lab-tab[data-lab-view]');
        if (!tab || tab.hidden || !panel.contains(tab)) return;
        setView(tab.dataset.labView, true);
    }

    function onShellKeyDown(event) {
        const tab = event.target.closest('.experiment-lab-tab[data-lab-view]');
        if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = Array.from(panel.querySelectorAll('.experiment-lab-tab[data-lab-view]:not([hidden])'));
        const current = tabs.indexOf(tab);
        if (current < 0) return;
        event.preventDefault();
        const next = event.key === 'Home'
            ? 0
            : event.key === 'End'
                ? tabs.length - 1
                : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        setView(tabs[next].dataset.labView, true);
        tabs[next].focus();
    }

    function onWorkspaceClick(event) {
        if (!event.target.closest(SCORE_DESTINATIONS)) return;
        window.setTimeout(() => setView('score'), 0);
    }

    function revealScore(detail) {
        if (!panel || !workspace) return;
        setView('score', false);
        const title = detail && detail.title || 'Opening';
        const count = Number(detail && detail.coordinateCount) || 0;
        const saved = detail && detail.savedId;
        const activity = panel.querySelector('[data-lab-activity]');
        if (activity) {
            activity.textContent = saved
                ? `${count} coordinates saved`
                : `${count} coordinates scored`;
        }
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                if (!workspace) return;
                const analysis = workspace.querySelector(
                    '[data-canonical-score-analysis]'
                );
                if (!analysis) return;
                analysis.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                });
                analysis.focus({ preventScroll: true });
                analysis.setAttribute(
                    'aria-label',
                    `${title} complete score analysis`
                );
            });
        });
    }

    function setView(nextView, restoreScroll) {
        if (!VIEWS[nextView] || !panel || !workspace) return;
        if (
            nextView === 'team'
            && !(currentContext && currentContext.teamAccess)
        ) return;
        scrollPositions[activeView] = workspace.scrollTop;
        activeView = nextView;
        if (
            window.JarvisRetention
            && typeof window.JarvisRetention.setExperimentLabLibraryView === 'function'
        ) {
            window.JarvisRetention.setExperimentLabLibraryView(
                nextView === 'team' ? 'team' : 'hooks'
            );
        }
        applyView(restoreScroll);
    }

    function applyView(restoreScroll) {
        if (!panel || !workspace) return;
        const view = VIEWS[activeView];
        panel.dataset.view = activeView;
        workspace.dataset.labView = activeView;
        const title = panel.querySelector('[data-lab-view-title]');
        const subtitle = panel.querySelector('[data-lab-view-subtitle]');
        if (title) title.textContent = view.title;
        if (subtitle) subtitle.textContent = view.subtitle;
        panel.querySelectorAll('.experiment-lab-tab[data-lab-view]').forEach(tab => {
            const selected = tab.dataset.labView === activeView;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
        });
        if (restoreScroll) {
            requestAnimationFrame(() => {
                if (workspace) workspace.scrollTop = scrollPositions[activeView] || 0;
            });
        }
        updateActivity();
    }

    function updateActivity() {
        if (!panel || !workspace) return;
        const state = window.JarvisRetention && window.JarvisRetention.__st
            ? window.JarvisRetention.__st()
            : {};
        let label = 'Ready';
        let busy = false;
        const queue = Array.isArray(state.rawUploads)
            ? state.rawUploads
            : [];
        const activeQueue = queue.filter(item => item && [
            'queued',
            'loading',
            'waiting',
            'scoring',
            'processing',
        ].includes(item._scoreQueueStatus || (
            item.score_ledger ? 'ready' : 'processing'
        ))).length;
        if (workspace.querySelector('[data-grindstop]') || state.grindStarting) {
            label = 'Grinding';
            busy = true;
        } else if (state.rawUploading || state.rawYtBusy) {
            label = activeQueue > 1
                ? `${activeQueue} analyses active`
                : 'Scoring';
            busy = true;
        } else if (activeQueue || state.savedDetailLoading) {
            label = activeQueue > 1
                ? `${activeQueue} analyses queued`
                : 'Loading analysis';
            busy = true;
        } else if (state.expGenBusy || state.rawGenBusy) {
            label = 'Generating';
            busy = true;
        }
        const activity = panel.querySelector('[data-lab-activity]');
        if (activity) activity.textContent = label;
        panel.classList.toggle('is-busy', busy);
    }

    return { open, close };
})();

BuildingRegistry.register('Experiment Lab', {
    open: function (bodyEl) { ExperimentLabUI.open(bodyEl); },
    close: function () { ExperimentLabUI.close(); },
});
