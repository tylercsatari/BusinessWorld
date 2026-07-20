'use strict';

const CasinoUI = (() => {
    const VIEWER_URL = 'https://app.gtobase.com/viewer?id=109&q=20#onePlayer-strategy';
    let container = null;

    function render() {
        return `
            <section class="casino-panel" aria-label="Casino poker strategy room">
                <header class="casino-toolbar">
                    <div class="casino-heading">
                        <span class="casino-chip" aria-hidden="true">♠</span>
                        <div>
                            <h2>Casino</h2>
                            <p>GTO poker strategy room · MTT 9-max · 20bb</p>
                        </div>
                    </div>
                    <div class="casino-actions">
                        <button class="casino-button casino-button-secondary" type="button" data-casino-action="reload">Reload chart</button>
                        <a class="casino-button casino-button-primary" href="${VIEWER_URL}" target="_blank" rel="noopener noreferrer">Open GTOBase</a>
                    </div>
                </header>
                <div class="casino-viewer-wrap">
                    <iframe
                        class="casino-viewer"
                        title="GTOBase MTT 9-max 20bb poker strategy viewer"
                        src="${VIEWER_URL}"
                        referrerpolicy="strict-origin-when-cross-origin"
                        loading="eager"
                        allowfullscreen></iframe>
                </div>
                <footer class="casino-help">
                    <span class="casino-status" data-casino-status>Loading the 20bb range chart…</span>
                    <span>If GTOBase asks you to sign in, use <strong>Open GTOBase</strong>, sign in there, then return and reload the chart.</span>
                </footer>
            </section>`;
    }

    function bindEvents() {
        const frame = container.querySelector('.casino-viewer');
        const status = container.querySelector('[data-casino-status]');
        const reload = container.querySelector('[data-casino-action="reload"]');

        frame.addEventListener('load', () => {
            status.textContent = 'GTOBase viewer loaded';
            status.classList.add('is-ready');
        });

        reload.addEventListener('click', () => {
            status.textContent = 'Reloading the 20bb range chart…';
            status.classList.remove('is-ready');
            frame.src = VIEWER_URL;
        });
    }

    return {
        open(bodyEl) {
            container = bodyEl;
            container.innerHTML = render();
            bindEvents();
        },
        close() {
            if (!container) return;
            const frame = container.querySelector('.casino-viewer');
            if (frame) frame.src = 'about:blank';
            container.innerHTML = '';
            container = null;
        }
    };
})();

window.CasinoUI = CasinoUI;

BuildingRegistry.register('Casino', {
    open: (bodyEl, opts) => CasinoUI.open(bodyEl, opts),
    close: () => CasinoUI.close()
});
