// jarvis-vca.js — 🎞 VCA (CHI'26) tab: annotated explorer of Maleeha Masood's
// VideoContentAnalysis_CHI26 repo (the pipeline behind the CHI 2026 TikTok
// watch-time paper). Self-contained module following the LongQuant pattern:
// jarvis-ui.js mounts it via window.JarvisVCA.mount(root). Data comes from the
// cloned repo bundled into vca-chi26/vca-data.json (repo files + annotations).
(function () {
    'use strict';

    let root = null;
    let data = null;
    let error = null;
    let activeFile = null; // name of the file open in the source viewer

    async function load() {
        if (data || error) return;
        try {
            const resp = await fetch('./buildings/jarvis/vca-chi26/vca-data.json');
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            data = await resp.json();
        } catch (e) {
            error = e.message || String(e);
        }
    }

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function link(href, label) {
        return `<a href="${href}" target="_blank" rel="noopener" style="color:#7c3aed;text-decoration:none;font-weight:600">${label}</a>`;
    }

    function render() {
        if (!root) return;
        if (error) {
            root.innerHTML = `<div style="padding:24px;color:#f87171">VCA bundle failed to load: ${esc(error)}</div>`;
            return;
        }
        if (!data) {
            root.innerHTML = '<div style="padding:24px;color:#64748b">Loading VCA repo…</div>';
            return;
        }
        const m = data.meta;

        const links = [
            link(m.repo, 'GitHub repo'), link(m.paper, 'arXiv'), link(m.paper_pdf, 'Paper PDF'),
            link(m.slides, 'CHI Slides'), link(m.talk, '▶ Recorded talk'),
        ].join(' &nbsp;·&nbsp; ');

        const overview = m.overview.map(p => {
            const i = p.indexOf(':');
            const head = i > 0 ? p.slice(0, i + 1) : '';
            const body = i > 0 ? p.slice(i + 1) : p;
            return `<div style="margin-bottom:10px;font-size:13px;line-height:1.6;color:#cbd5e1"><span style="color:#e2e8f0;font-weight:700">${esc(head)}</span>${esc(body)}</div>`;
        }).join('');

        const pipeline = m.pipeline.map((s, i) => `
            <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:8px">
                <div style="flex:none;width:22px;height:22px;border-radius:50%;background:#7c3aed22;border:1px solid #7c3aed;color:#a78bfa;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center">${i + 1}</div>
                <div style="font-size:12.5px;line-height:1.5"><span style="color:#e2e8f0;font-weight:600">${esc(s.step)}</span><span style="color:#94a3b8"> — ${esc(s.detail)}</span></div>
            </div>`).join('');

        const mapping = m.mapping.map(r => `
            <tr style="border-bottom:1px solid #1e293b">
                <td style="padding:8px 10px;font-size:12px;color:#93c5fd;vertical-align:top">${esc(r.ours)}</td>
                <td style="padding:8px 10px;font-size:12px;color:#fbbf24;vertical-align:top">${esc(r.theirs)}</td>
                <td style="padding:8px 10px;font-size:12px;color:#94a3b8;vertical-align:top">${esc(r.note)}</td>
            </tr>`).join('');

        const fileBtns = data.files.map(f => `
            <button class="vca-file-btn" data-file="${esc(f.name)}" style="display:block;width:100%;text-align:left;background:${activeFile === f.name ? '#7c3aed22' : 'transparent'};border:1px solid ${activeFile === f.name ? '#7c3aed' : '#1e293b'};border-radius:6px;padding:8px 10px;margin-bottom:6px;cursor:pointer;color:#e2e8f0">
                <div style="font-size:12px;font-weight:700">${esc(f.name)}</div>
                <div style="font-size:10.5px;color:#64748b">${f.lines} lines · ${esc(f.lang)}</div>
            </button>`).join('');

        const openFile = data.files.find(f => f.name === activeFile);
        const viewer = openFile ? `
            <div style="background:#0d1526;border:1px solid #1e293b;border-radius:8px;overflow:hidden">
                <div style="padding:10px 14px;border-bottom:1px solid #1e293b;background:#0a1628">
                    <div style="font-size:12px;font-weight:700;color:#e2e8f0">${esc(openFile.name)}</div>
                    <div style="font-size:11.5px;color:#94a3b8;line-height:1.55;margin-top:4px">${esc(openFile.annotation)}</div>
                </div>
                <pre style="margin:0;padding:14px;font-size:11px;line-height:1.5;color:#cbd5e1;overflow:auto;max-height:520px;white-space:pre">${esc(openFile.content)}</pre>
            </div>` : `
            <div style="border:1px dashed #1e293b;border-radius:8px;padding:26px;text-align:center;color:#64748b;font-size:12px">Select a file to read its annotated source</div>`;

        root.innerHTML = `
            <div style="padding:4px 2px">
                <div style="margin-bottom:14px">
                    <div style="font-size:17px;font-weight:800;color:#e2e8f0">🎞 ${esc(m.title)}</div>
                    <div style="font-size:12px;color:#94a3b8;margin:3px 0 6px">${esc(m.author)} · cloned ${esc(m.cloned)} · ${links}</div>
                    <div style="font-size:12.5px;color:#cbd5e1;line-height:1.6;max-width:900px;background:#7c3aed11;border:1px solid #7c3aed44;border-radius:8px;padding:10px 12px">${esc(m.one_liner)}</div>
                </div>

                <div style="display:grid;grid-template-columns:1.15fr 1fr;gap:16px;margin-bottom:16px">
                    <div style="background:#0d1526;border:1px solid #1e293b;border-radius:8px;padding:14px">
                        <div style="font-size:12px;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">What it is</div>
                        ${overview}
                    </div>
                    <div style="background:#0d1526;border:1px solid #1e293b;border-radius:8px;padding:14px">
                        <div style="font-size:12px;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Pipeline</div>
                        ${pipeline}
                    </div>
                </div>

                <div style="background:#0d1526;border:1px solid #1e293b;border-radius:8px;padding:14px;margin-bottom:16px">
                    <div style="font-size:12px;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">How it maps to our stack</div>
                    <table style="width:100%;border-collapse:collapse">
                        <thead><tr style="border-bottom:1px solid #334155">
                            <th style="padding:6px 10px;font-size:11px;color:#64748b;text-align:left">OURS</th>
                            <th style="padding:6px 10px;font-size:11px;color:#64748b;text-align:left">THEIRS</th>
                            <th style="padding:6px 10px;font-size:11px;color:#64748b;text-align:left">TAKEAWAY</th>
                        </tr></thead>
                        <tbody>${mapping}</tbody>
                    </table>
                </div>

                <div style="display:grid;grid-template-columns:220px 1fr;gap:16px">
                    <div>
                        <div style="font-size:12px;font-weight:700;color:#a78bfa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Repo files</div>
                        ${fileBtns}
                    </div>
                    ${viewer}
                </div>
            </div>`;

        root.querySelectorAll('.vca-file-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                activeFile = activeFile === btn.dataset.file ? null : btn.dataset.file;
                render();
            });
        });
    }

    async function mount(el) {
        root = el;
        render();
        await load();
        render();
    }

    window.JarvisVCA = { mount };
})();
