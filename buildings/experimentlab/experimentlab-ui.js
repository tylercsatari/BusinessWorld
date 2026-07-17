/* Dedicated Shorts experimentation surface. The implementation stays in JarvisRetention. */
const ExperimentLabUI = (() => {
    let container = null;

    function open(bodyEl) {
        container = bodyEl;
        container.innerHTML = `
            <section class="experiment-lab-panel">
                <header class="experiment-lab-header">
                    <div class="experiment-lab-mark" aria-hidden="true">
                        <span class="experiment-lab-flask">⚗</span>
                    </div>
                    <div class="experiment-lab-title-block">
                        <div class="experiment-lab-kicker">Shorts Quant</div>
                        <h2>Experiment Lab</h2>
                        <p>Quantitative Shorts workspace</p>
                    </div>
                    <div class="experiment-lab-status" title="Uses the same scorer and saved data as Jarvis">
                        <span></span> Shared with Jarvis
                    </div>
                </header>
                <div id="experiment-lab-workspace" class="experiment-lab-workspace"></div>
            </section>`;
        const workspace = container.querySelector('#experiment-lab-workspace');
        if (!window.JarvisRetention || typeof window.JarvisRetention.mountExperiment !== 'function') {
            workspace.innerHTML = '<div class="experiment-lab-error">The Shorts experiment engine did not load. Reload Business World and try again.</div>';
            return;
        }
        window.JarvisRetention.mountExperiment(workspace);
    }

    function close() {
        container = null;
    }

    return { open, close };
})();

BuildingRegistry.register('Experiment Lab', {
    open: function (bodyEl) { ExperimentLabUI.open(bodyEl); },
    close: function () { ExperimentLabUI.close(); },
});
