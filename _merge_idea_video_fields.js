// One-time reconciliation of idea <-> video shared fields so nothing is lost.
// A video links to its Library idea via video.sourceIdeaId. Historically `script`
// (and occasionally other fields) drifted because saves didn't mirror across.
//
// For each linked idea/video pair we reconcile every shared field:
//   - both sides non-empty AND different  -> CONCATENATE (long text) so nothing is
//     overwritten; for identity fields (name/project) prefer the video's value and
//     just report the difference.
//   - one side empty                       -> copy the non-empty value across.
//   - equal                                -> leave it.
// Then write the reconciled value to BOTH records so they're identical afterward.
//
// Usage:
//   node _merge_idea_video_fields.js            # DRY RUN — prints what it would do
//   node _merge_idea_video_fields.js --apply    # actually writes to R2
require('dotenv').config();
require('./cloud-storage').initR2();   // data-store refuses to load until R2 is up
const store = require('./data-store');

const APPLY = process.argv.includes('--apply');
const norm = (s) => (s == null ? '' : String(s)).trim();
const SEP = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚠️ MERGED — the other copy is below (kept so nothing was lost)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

// Long text fields concatenate on conflict; identity fields prefer the video.
const TEXT_FIELDS = ['script', 'context', 'hook'];
const ID_FIELDS = ['name', 'project'];

function reconcile(field, vVal, iVal) {
    const a = norm(vVal), b = norm(iVal);
    if (a === b) return { value: vVal, changed: false };       // already identical
    if (!a) return { value: iVal, changed: true, how: 'copied idea→video (video was empty)' };
    if (!b) return { value: vVal, changed: true, how: 'copied video→idea (idea was empty)' };
    // Both present and different.
    if (TEXT_FIELDS.includes(field)) {
        return { value: vVal + SEP + iVal, changed: true, how: 'CONCATENATED both versions' };
    }
    // Identity field conflict — keep the video's, report it.
    return { value: vVal, changed: true, how: `kept video's "${a}" (idea had "${b}")`, identityConflict: true };
}

(async () => {
    const videos = await store.getAll('videos');
    const ideas = await store.getAll('ideas');
    const ideaById = new Map(ideas.map(i => [i.id, i]));

    let pairs = 0, touched = 0;
    const reports = [];

    for (const v of videos) {
        if (!v.sourceIdeaId) continue;
        const idea = ideaById.get(v.sourceIdeaId);
        if (!idea) continue;
        pairs++;

        const vChanges = {}, iChanges = {};
        const lines = [];
        for (const f of [...TEXT_FIELDS, ...ID_FIELDS]) {
            const r = reconcile(f, v[f], idea[f]);
            if (!r.changed) continue;
            if (norm(r.value) !== norm(v[f])) vChanges[f] = r.value;
            if (norm(r.value) !== norm(idea[f])) iChanges[f] = r.value;
            lines.push(`    • ${f}: ${r.how}`);
        }
        if (!Object.keys(vChanges).length && !Object.keys(iChanges).length) continue;

        touched++;
        reports.push(`  [${v.name || v.id}]\n${lines.join('\n')}`);
        if (APPLY) {
            if (Object.keys(vChanges).length) await store.update('videos', v.id, vChanges);
            if (Object.keys(iChanges).length) await store.update('ideas', idea.id, iChanges);
        }
    }

    console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} — ${pairs} linked idea/video pairs, ${touched} needed reconciling.\n`);
    if (reports.length) console.log(reports.join('\n\n'));
    if (!APPLY && touched) console.log(`\nRe-run with --apply to write these ${touched} reconciliations to R2.`);
    if (APPLY && touched) console.log(`\n✅ Done. Both records now hold the merged value for each field.`);
    if (!touched) console.log('Everything already consistent — nothing to do.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
