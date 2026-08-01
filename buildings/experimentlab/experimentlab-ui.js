/* Dedicated Shorts experimentation surface. The implementation stays in JarvisRetention. */
const ExperimentLabUI = (() => {
    let container = null;
    let workspace = null;
    let contextHandler = null;

    function renderContext(context) {
        if (!container) return;
        const status = container.querySelector(
            '[data-experiment-lab-status]'
        );
        const account = container.querySelector(
            '[data-experiment-lab-account]'
        );
        if (!status || !account) return;
        if (!context || !context.activeAccount) {
            status.dataset.state = 'error';
            status.querySelector('b').textContent =
                'Workspace unavailable';
            account.textContent = 'Account scope unavailable';
            return;
        }
        const active = context.activeAccount;
        const viewer = context.viewer || {};
        status.dataset.state = 'ready';
        status.querySelector('b').textContent = context.readOnly
            ? 'Read-only inspection'
            : context.owner
                ? 'Owner workspace'
                : 'Private workspace';
        account.textContent = context.readOnly
            ? `${active.name || active.email} · viewed by ${viewer.name || viewer.email}`
            : active.name || active.email || 'Private account';
    }

    function open(bodyEl) {
        container = bodyEl;
        const modal = document.getElementById('modal');
        if (modal) modal.classList.add('experiment-lab-modal');
        container.classList.add('experiment-lab-modal-body');
        container.innerHTML = `
            <section class="experiment-lab-panel">
                <header class="experiment-lab-header">
                    <div class="experiment-lab-mark" aria-hidden="true">
                        <span>EL</span>
                        <small>01</small>
                    </div>
                    <div class="experiment-lab-title-block">
                        <div class="experiment-lab-kicker">Shorts Quant / Field Instrument</div>
                        <h2>Experiment Lab</h2>
                        <p data-experiment-lab-account>Resolving private account</p>
                    </div>
                    <div class="experiment-lab-status" data-state="loading" data-experiment-lab-status title="Canonical Jarvis experiment engine with a private account workspace">
                        <span></span>
                        <b>Connecting</b>
                    </div>
                </header>
                <div id="experiment-lab-workspace" class="experiment-lab-workspace"></div>
            </section>`;
        workspace = container.querySelector('#experiment-lab-workspace');
        if (!window.JarvisRetention || typeof window.JarvisRetention.mountShortsExperiment !== 'function') {
            workspace.innerHTML = '<div class="experiment-lab-error">The Shorts experiment engine did not load. Reload Business World and try again.</div>';
            return;
        }
        contextHandler = event => renderContext(event.detail);
        workspace.addEventListener(
            'experiment-lab-context',
            contextHandler
        );
        Promise.resolve(
            window.JarvisRetention.mountShortsExperiment(
                workspace,
                { surface: 'experiment-lab' }
            )
        ).then(() => {
            renderContext(
                window.JarvisRetention.getExperimentContext()
            );
        }).catch(error => {
            const status = container && container.querySelector(
                '[data-experiment-lab-status]'
            );
            if (status) {
                status.dataset.state = 'error';
                status.querySelector('b').textContent =
                    'Workspace unavailable';
            }
            workspace.innerHTML =
                `<div class="experiment-lab-error">${String(
                    error && error.message || error
                )}</div>`;
        });
    }

    function close() {
        if (
            workspace
            && window.JarvisRetention
            && typeof window.JarvisRetention
                .unmountShortsExperiment === 'function'
        ) {
            window.JarvisRetention.unmountShortsExperiment(workspace);
        }
        const modal = document.getElementById('modal');
        if (modal) modal.classList.remove('experiment-lab-modal');
        if (container) container.classList.remove('experiment-lab-modal-body');
        if (workspace && contextHandler) {
            workspace.removeEventListener(
                'experiment-lab-context',
                contextHandler
            );
        }
        workspace = null;
        contextHandler = null;
        container = null;
    }

    return { open, close };
})();

BuildingRegistry.register('Experiment Lab', {
    open: function (bodyEl) { ExperimentLabUI.open(bodyEl); },
    close: function () { ExperimentLabUI.close(); },
});
