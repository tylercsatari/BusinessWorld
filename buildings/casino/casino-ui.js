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
                </header>
                <main class="casino-launcher">
                    <div class="casino-table" aria-hidden="true">
                        <span class="casino-card casino-card-one">A♠</span>
                        <span class="casino-card casino-card-two">K♠</span>
                        <span class="casino-table-chip">20<small>bb</small></span>
                    </div>
                    <div class="casino-copy">
                        <span class="casino-eyebrow">Preflop range room</span>
                        <h3>Play the 20bb chart full screen</h3>
                        <p>GTOBase must open as its own page on mobile so Google login and your paid solver session work correctly.</p>
                    </div>
                    <dl class="casino-spot">
                        <div><dt>Game</dt><dd>MTT</dd></div>
                        <div><dt>Table</dt><dd>9-max</dd></div>
                        <div><dt>Stack</dt><dd>20bb</dd></div>
                        <div><dt>Start</dt><dd>UTG</dd></div>
                    </dl>
                    <a class="casino-launch-button" href="${VIEWER_URL}" target="_blank" rel="noopener noreferrer">
                        <span>Open 20bb range chart</span>
                        <span aria-hidden="true">→</span>
                    </a>
                    <p class="casino-return-note">When you finish checking a hand, return to the Business World tab to reopen the Casino.</p>
                </main>
            </section>`;
    }

    return {
        open(bodyEl) {
            container = bodyEl;
            container.innerHTML = render();
        },
        close() {
            if (!container) return;
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
