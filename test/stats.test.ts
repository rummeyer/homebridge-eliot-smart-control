import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { PostureStats, daysRecorded, readStats, shownSpans, statsPath, totalsFor } from '../src/stats.ts';

const MAC = 'E5:02:4F:BF:74:A2';
const THRESHOLD = 1002;

/** A fresh statistics file in a directory of its own. */
function fresh(t: TestContext): { path: string; stats: PostureStats } {
  const dir = mkdtempSync(join(tmpdir(), 'eliot-stats-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = statsPath(dir, MAC);
  return { path, stats: new PostureStats(path, 'Schreibtisch', MAC, THRESHOLD) };
}

/** Local time on 24.09.2026. */
const at = (h: number, m: number, s = 0) => new Date(2026, 8, 24, h, m, s).getTime();

test('time goes to the posture the previous sample saw', (t) => {
  const { stats } = fresh(t);
  stats.sample(at(9, 0), { counting: true, heightMm: 800 });
  stats.sample(at(9, 0, 30), { counting: true, heightMm: 1204 });
  stats.sample(at(9, 1), { counting: true, heightMm: 1204 });

  assert.deepEqual(stats.days['2026-09-24'], { sitting: 30, standing: 30 });
});

test('the threshold itself counts as standing', (t) => {
  const { stats } = fresh(t);
  stats.sample(at(9, 0), { counting: true, heightMm: THRESHOLD });
  stats.sample(at(9, 0, 30), { counting: true, heightMm: THRESHOLD });

  assert.deepEqual(stats.days['2026-09-24'], { sitting: 0, standing: 30 });
});

test('nothing is counted outside the windows or without a height', (t) => {
  const { stats } = fresh(t);
  stats.sample(at(9, 0), { counting: false, heightMm: 800 });
  stats.sample(at(9, 0, 30), { counting: true, heightMm: null });
  stats.sample(at(9, 1), { counting: true, heightMm: 800 });
  stats.sample(at(9, 1, 30), { counting: false, heightMm: 800 });
  stats.sample(at(9, 2), { counting: false, heightMm: 800 });

  // Only 9:01:00–9:01:30: the one span that started with a counting sample.
  assert.deepEqual(stats.days['2026-09-24'], { sitting: 30, standing: 0 });
});

test('a long gap between samples is not counted', (t) => {
  const { stats } = fresh(t);
  stats.sample(at(9, 0), { counting: true, heightMm: 800 });
  stats.sample(at(9, 10), { counting: true, heightMm: 800 });

  assert.equal(stats.days['2026-09-24'], undefined, 'nobody knows what happened in ten minutes');
});

test('a span across midnight is split between the two days', (t) => {
  const { stats } = fresh(t);
  stats.sample(at(23, 59, 40), { counting: true, heightMm: 800 });
  stats.sample(new Date(2026, 8, 25, 0, 0, 10).getTime(), { counting: true, heightMm: 800 });

  assert.deepEqual(stats.days['2026-09-24'], { sitting: 20, standing: 0 });
  assert.deepEqual(stats.days['2026-09-25'], { sitting: 10, standing: 0 });
});

test('saved, read back and carried on from', (t) => {
  const { path, stats } = fresh(t);
  stats.sample(at(9, 0), { counting: true, heightMm: 1204 });
  stats.sample(at(9, 1), { counting: true, heightMm: 1204 });
  stats.save(new Date(at(9, 1)));

  const data = readStats(path);
  assert.equal(data?.name, 'Schreibtisch');
  assert.equal(data?.thresholdMm, THRESHOLD);
  assert.deepEqual(data?.days['2026-09-24'], { sitting: 0, standing: 60 });

  const again = new PostureStats(path, 'Schreibtisch', MAC, THRESHOLD);
  again.sample(at(10, 0), { counting: true, heightMm: 1204 });
  again.sample(at(10, 0, 30), { counting: true, heightMm: 1204 });
  assert.deepEqual(again.days['2026-09-24'], { sitting: 0, standing: 90 });
});

test('nothing counted means nothing written', (t) => {
  const { path, stats } = fresh(t);
  stats.save();
  assert.throws(() => readFileSync(path), 'no file for a desk that never counted');
});

test('a file deleted by the settings page is not written back', (t) => {
  const { path, stats } = fresh(t);
  stats.sample(at(9, 0), { counting: true, heightMm: 800 });
  stats.sample(at(9, 1), { counting: true, heightMm: 800 });
  stats.save(new Date(at(9, 1)));

  rmSync(path);
  stats.sample(at(9, 1, 30), { counting: true, heightMm: 800 });
  stats.save(new Date(at(9, 1, 30)));
  assert.throws(() => readFileSync(path), 'the reset stands');
  assert.deepEqual(stats.days, {}, 'and what was held in memory went with it');

  // Counting carries on from nothing.
  stats.sample(at(9, 2), { counting: true, heightMm: 800 });
  stats.save(new Date(at(9, 2)));
  assert.deepEqual(readStats(path)?.days['2026-09-24'], { sitting: 30, standing: 0 });
});

test('a hundred days are kept and the day before them is dropped', (t) => {
  const { path } = fresh(t);
  const stats = new PostureStats(path, 'Schreibtisch', MAC, THRESHOLD);
  // 100 days back is one too many; 99 back is the oldest of the hundred.
  for (const day of [new Date(2026, 5, 16, 9), new Date(2026, 5, 17, 9), new Date(2026, 8, 24, 9)]) {
    stats.sample(day.getTime(), { counting: true, heightMm: 800 });
    stats.sample(day.getTime() + 30_000, { counting: true, heightMm: 800 });
    stats.sample(day.getTime() + 600_000, { counting: false, heightMm: 800 });
  }
  stats.save(new Date(at(12, 0)));

  const days = Object.keys(readStats(path)?.days ?? {});
  assert.deepEqual(days.sort(), ['2026-06-17', '2026-09-24']);
});

test('the record reaches back from its first day, gaps included', () => {
  const now = new Date(at(15, 0));
  assert.equal(daysRecorded({}, now), 0);
  assert.equal(daysRecorded({ '2026-09-24': { sitting: 1, standing: 0 } }, now), 1);
  assert.equal(
    daysRecorded(
      { '2026-09-18': { sitting: 1, standing: 0 }, '2026-09-24': { sitting: 1, standing: 0 } },
      now,
    ),
    7,
    'a week, although only two days have data',
  );
  // Across the change back from summer time on 25.10.2026.
  assert.equal(
    daysRecorded({ '2026-10-24': { sitting: 1, standing: 0 } }, new Date(2026, 9, 26, 9)),
    3,
  );
});

test('a span shows once the record reaches past the one before it', () => {
  const now = new Date(at(15, 0));
  const since = (key: string) => shownSpans({ [key]: { sitting: 1, standing: 0 } }, now);
  assert.deepEqual(shownSpans({}, now), [1]);
  assert.deepEqual(since('2026-09-24'), [1]);
  assert.deepEqual(since('2026-09-23'), [1, 3]);
  assert.deepEqual(since('2026-09-22'), [1, 3]);
  assert.deepEqual(since('2026-09-21'), [1, 3, 7]);
  assert.deepEqual(since('2026-09-18'), [1, 3, 7]);
  assert.deepEqual(since('2026-09-17'), [1, 3, 7, 30]);
  assert.deepEqual(since('2026-08-26'), [1, 3, 7, 30]);
  assert.deepEqual(since('2026-08-25'), [1, 3, 7, 30, 100]);
});

test('spans are counted back by calendar day, today included', () => {
  const days = {
    '2026-09-24': { sitting: 100, standing: 50 },
    '2026-09-18': { sitting: 10, standing: 0 },
    '2026-09-17': { sitting: 1000, standing: 1000 },
  };
  const now = new Date(at(15, 0));

  assert.deepEqual(totalsFor(days, 1, now), { sitting: 100, standing: 50 });
  assert.deepEqual(totalsFor(days, 7, now), { sitting: 110, standing: 50 });
  assert.deepEqual(totalsFor(days, 8, now), { sitting: 1110, standing: 1050 });
});
