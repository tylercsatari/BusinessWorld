#!/usr/bin/env node
'use strict';

const assert = require('assert');
const writer = require('../buildings/jarvis/shorts-transcript-writer');

function main() {
    const population = writer.sourcePopulation();
    assert.strictEqual(
        population.length,
        208,
        'the transcript writer must join every Tyler video with aligned word timestamps to its measured outcome'
    );
    assert(
        population.every((record, index) => (
            index === 0
            || population[index - 1].keepRate >= record.keepRate
        )),
        'measured examples must use deterministic descending actual keep rate'
    );
    assert(
        population.every(record => (
            record.id
            && record.transcript
            && Number.isFinite(record.keepRate)
        )),
        'every source example must have joined measured evidence'
    );

    assert.strictEqual(
        writer.measuredEvidenceSchema,
        'shorts-measured-opening-examples-v1'
    );
    assert.strictEqual(
        population.find(record => record.id === 'YFNOSHumPZc').transcript,
        "this is 3d printed batman armor wait it's already but can i make it bulletproof",
        'the transcript must use the exact aligned first-five-second words, not a duration-ratio estimate'
    );

    const examples = writer.sourceExamples();
    assert.strictEqual(examples.length, 12);
    const cadence = writer.cadenceProfile(population);
    assert.strictEqual(cadence.sourceCount, 208);
    assert.strictEqual(cadence.measuredWindowSeconds, 5);
    assert.strictEqual(cadence.marginMultiplier, 1.5);
    assert.strictEqual(cadence.hardWordCap, 30);
    assert(Math.abs(
        cadence.averageWordsPerSecond - 3.9326923076923075
    ) < 1e-12);
    const messages = writer.buildMessages({
        videoIdea: 'Test a spill-proof machine',
        hookTreatment: 'Escalate the test until it nearly fails',
        panels: ['setup', 'pour', 'shake', 'impact', 'reveal'],
        examples,
        population,
    });
    assert.strictEqual(messages.length, 2);
    assert(messages[0].content.includes('structural evidence only'));
    assert(messages[0].content.includes('Never add an object'));
    assert(messages[0].content.includes('no more than 30 words'));
    assert(messages[1].content.includes('IMMUTABLE VIDEO IDEA'));
    assert(messages[1].content.includes('REAL HIGH-KEEP TYLER OPENINGS'));
    assert(messages[1].content.includes('HARD MAXIMUM: 30 spoken words'));
    assert.strictEqual(
        (messages[1].content.match(/EXAMPLE \d+:/g) || []).length,
        12
    );

    const parsed = writer.parseResult({
        transcript: 'This machine cannot spill, so I tried to break it.',
        beat_alignment: ['This machine', 'cannot spill'],
    }, { cadence });
    assert.strictEqual(
        parsed.transcript,
        'This machine cannot spill, so I tried to break it.'
    );
    assert.deepStrictEqual(parsed.beatAlignment, [
        'This machine',
        'cannot spill',
        '',
        '',
        '',
    ]);
    assert.strictEqual(parsed.wordCount, 10);
    assert.strictEqual(parsed.originalWordCount, 10);
    assert.strictEqual(parsed.wasTruncated, false);
    assert.deepStrictEqual(parsed.wordBudget, cadence);

    const overlong = writer.parseResult({
        transcript: Array.from(
            { length: 42 },
            (_, index) => `word${index + 1}`
        ).join(' '),
    }, { cadence });
    assert.strictEqual(overlong.wordCount, 30);
    assert.strictEqual(overlong.originalWordCount, 42);
    assert.strictEqual(overlong.wasTruncated, true);
    assert.strictEqual(
        overlong.transcript.split(/\s+/).length,
        30,
        'provider output must be deterministically capped even if it ignores the prompt'
    );
    assert.throws(
        () => writer.parseResult({ transcript: ' ' }),
        /returned no spoken opening/
    );

    console.log('shorts transcript writer contract: ok');
}

main();
