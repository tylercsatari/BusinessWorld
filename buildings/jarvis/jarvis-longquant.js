/* ── jarvis-longquant.js ── "🎬 Long Quant" ──────────────────────────────────
 * Long-form (horizontal) video analysis — the long-form sibling of Shorts Quant.
 * Phase 1: the public thumbnail+title corpus. This tab shows the live crawler
 * progress and the growing data sheet (longform-crawler.js → /api/longquant/*).
 * Later phases: thumbnail+title embeddings (→ views), and an account-level
 * CTR + retention + 30s-retention + duration → views predictor.
 * Self-contained module; JarvisUI hands it a root div via mount().
 * ──────────────────────────────────────────────────────────────────────────── */
const JarvisLongQuant = (function () {
    const COL = {
        bg: '#0e1116', card: '#161b22', card2: '#1c2230', border: '#2a3040', border2: '#3a4252',
        text: '#e6edf3', dim: '#9aa4b2', mute: '#6b7686', accent: '#4a9eff', green: '#3fb950',
        amber: '#d29922', red: '#f85149', purple: '#a371f7',
    };

    let root = null, state = { stats: null, videos: [], sort: 'recent', loading: true, err: null };
    let pollT = null;

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    function fmtViews(n) {
        n = +n || 0;
        if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(n);
    }
    function fmtDur(s) {
        s = Math.round(+s || 0); if (!s) return '—';
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
    }

    async function load() {
        try {
            const [statsR, vidsR] = await Promise.all([
                fetch('/api/longquant/stats').then(r => r.json()).catch(() => null),
                fetch('/api/longquant/videos?limit=200&sort=' + state.sort).then(r => r.json()).catch(() => ({ videos: [] })),
            ]);
            state.stats = statsR || state.stats;
            state.videos = (vidsR && vidsR.videos) || [];
            state.loading = false; state.err = null;
        } catch (e) { state.err = e.message; state.loading = false; }
        render();
    }

    function statCard(label, value, color) {
        return `<div style="background:${COL.card2};border:1px solid ${COL.border};border-radius:9px;padding:12px 16px;min-width:120px">
            <div style="font-size:11px;color:${COL.mute};text-transform:uppercase;letter-spacing:.5px">${label}</div>
            <div style="font-size:22px;font-weight:700;color:${color || COL.text};margin-top:3px">${value}</div></div>`;
    }

    function render() {
        if (!root) return;
        const s = state.stats || {};
        const stored = s.stored || 0, disc = s.discovered || 0, target = s.target || 50000;
        const pct = Math.min(100, (stored / target) * 100);
        const b = s.viewBuckets || {};

        let h = `<div style="padding:22px 26px;color:${COL.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
            <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
                <div style="font-size:20px;font-weight:800">🎬 Long Quant</div>
                <div style="font-size:12px;color:${COL.dim}">Long-form (horizontal) corpus · thumbnail + title → views</div>
            </div>
            <div style="font-size:12px;color:${COL.mute};margin-top:6px;max-width:820px;line-height:1.5">
                The long-form sibling of Shorts Quant. A background crawler collects tens of thousands of last-year
                horizontal videos — thumbnail, title, views, duration, channel &amp; subs — into the data sheet below.
                Next up: thumbnail+title embeddings scored against views, then an account-level CTR + retention + duration → views model.
            </div>`;

        if (state.err) h += `<div style="margin-top:16px;color:${COL.red};font-size:13px">Error: ${esc(state.err)}</div>`;

        // ── stats row ──
        h += `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:18px">
            ${statCard('Collected', fmtViews(stored), COL.green)}
            ${statCard('Discovered', fmtViews(disc), COL.accent)}
            ${statCard('Target', fmtViews(target), COL.dim)}
            ${statCard('3×+ outliers', fmtViews(s.outliers3x || 0), COL.purple)}
        </div>`;

        // ── progress bar ──
        h += `<div style="margin-top:16px">
            <div style="height:9px;background:${COL.card2};border:1px solid ${COL.border};border-radius:6px;overflow:hidden">
                <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,${COL.accent},${COL.green})"></div>
            </div>
            <div style="font-size:11px;color:${COL.mute};margin-top:5px">${pct.toFixed(1)}% of target · ${stored.toLocaleString()} / ${target.toLocaleString()} collected</div>
        </div>`;

        // ── view buckets ──
        const bucketOrder = ['10k-100k', '100k-1M', '1M-10M', '10M-100M', '100M+'];
        if (Object.keys(b).length) {
            h += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">` +
                bucketOrder.map(k => `<div style="background:${COL.card};border:1px solid ${COL.border};border-radius:7px;padding:7px 11px">
                    <span style="font-size:11px;color:${COL.mute}">${k}</span>
                    <span style="font-size:13px;font-weight:700;margin-left:7px">${(b[k] || 0).toLocaleString()}</span></div>`).join('') + `</div>`;
        }

        // ── data sheet ──
        const sortBtn = (id, label) => `<button data-lq-sort="${id}" style="cursor:pointer;border:1px solid ${state.sort === id ? COL.accent : COL.border};background:${state.sort === id ? COL.accent : COL.card2};color:${state.sort === id ? '#fff' : COL.dim};border-radius:6px;padding:5px 11px;font-size:12px;font-weight:600">${label}</button>`;
        h += `<div style="display:flex;align-items:center;gap:10px;margin-top:24px;margin-bottom:10px">
            <div style="font-size:14px;font-weight:700">Data sheet</div>
            <div style="font-size:11px;color:${COL.mute}">showing ${state.videos.length}</div>
            <div style="flex:1"></div>
            <span style="font-size:11px;color:${COL.mute}">sort</span>
            ${sortBtn('recent', 'Recent')} ${sortBtn('views', 'Views')} ${sortBtn('outlier', 'Outlier')}
        </div>`;

        if (!state.videos.length) {
            h += `<div style="background:${COL.card};border:1px dashed ${COL.border2};border-radius:9px;padding:34px;text-align:center;color:${COL.mute};font-size:13px">
                ${state.loading ? 'Loading…' : 'No videos collected yet — the crawler is warming up. This panel auto-refreshes.'}</div>`;
        } else {
            h += `<div style="overflow-x:auto;border:1px solid ${COL.border};border-radius:9px">
            <table style="border-collapse:collapse;width:100%;font-size:12.5px;min-width:820px">
                <thead><tr style="background:${COL.card2};color:${COL.dim};text-align:left">
                    <th style="padding:9px 12px;font-weight:600">Thumb</th>
                    <th style="padding:9px 12px;font-weight:600">Title</th>
                    <th style="padding:9px 12px;font-weight:600">Channel</th>
                    <th style="padding:9px 12px;font-weight:600;text-align:right">Views</th>
                    <th style="padding:9px 12px;font-weight:600;text-align:right">Subs</th>
                    <th style="padding:9px 12px;font-weight:600;text-align:right">Outlier</th>
                    <th style="padding:9px 12px;font-weight:600;text-align:right">Dur</th>
                    <th style="padding:9px 12px;font-weight:600">Posted</th>
                </tr></thead><tbody>`;
            for (const v of state.videos) {
                const oc = (v.outlier || 0) >= 3 ? COL.purple : (v.outlier || 0) >= 1 ? COL.green : COL.dim;
                h += `<tr style="border-top:1px solid ${COL.border}">
                    <td style="padding:6px 12px"><a href="${esc(v.url)}" target="_blank" rel="noopener"><img src="${esc(v.thumb)}" loading="lazy" style="width:104px;height:58px;object-fit:cover;border-radius:4px;background:${COL.card2};display:block"/></a></td>
                    <td style="padding:6px 12px;max-width:340px"><a href="${esc(v.url)}" target="_blank" rel="noopener" style="color:${COL.text};text-decoration:none">${esc(v.title)}</a></td>
                    <td style="padding:6px 12px;color:${COL.dim};max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v.channel)}</td>
                    <td style="padding:6px 12px;text-align:right;font-variant-numeric:tabular-nums">${fmtViews(v.views)}</td>
                    <td style="padding:6px 12px;text-align:right;color:${COL.dim};font-variant-numeric:tabular-nums">${v.subs != null ? fmtViews(v.subs) : '—'}</td>
                    <td style="padding:6px 12px;text-align:right;color:${oc};font-weight:600;font-variant-numeric:tabular-nums">${v.outlier != null ? v.outlier + '×' : '—'}</td>
                    <td style="padding:6px 12px;text-align:right;color:${COL.dim};font-variant-numeric:tabular-nums">${fmtDur(v.durationSec)}</td>
                    <td style="padding:6px 12px;color:${COL.mute};white-space:nowrap">${esc(v.publishedAt || v.uploadDate || '')}</td>
                </tr>`;
            }
            h += `</tbody></table></div>`;
        }

        h += `</div>`;
        root.innerHTML = h;

        root.querySelectorAll('[data-lq-sort]').forEach(btn => btn.addEventListener('click', () => {
            const ns = btn.getAttribute('data-lq-sort');
            if (ns !== state.sort) { state.sort = ns; load(); }
        }));
    }

    function mount(el) {
        root = el;
        state.loading = true;
        render();
        load();
        clearInterval(pollT);
        pollT = setInterval(() => { if (root && document.body.contains(root)) load(); else clearInterval(pollT); }, 15000);
    }

    return { mount };
})();
if (typeof window !== 'undefined') window.JarvisLongQuant = JarvisLongQuant;
if (typeof module !== 'undefined' && module.exports) module.exports = JarvisLongQuant;
