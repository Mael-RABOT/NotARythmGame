import { describe, expect, it } from 'vitest';
import { analyzeDifficulty, lintDifficulty } from '../chart/analysis';
import { TimingMap } from '../chart/TimingMap';
import { buildDemoChart } from './demoSong';

describe('built-in demo charts', () => {
  const chart = buildDemoChart();
  const timing = new TimingMap(chart.timing, chart.audio.offsetMs);
  for (const diff of chart.difficulties) {
    it(`${diff.name} has no lint errors or warnings`, () => {
      const issues = lintDifficulty(chart, diff).filter((i) => i.level !== 'info');
      expect(issues.map((i) => `${timing.beatLabel(i.tick)} ${i.message}`)).toEqual([]);
    });
  }
  it('Hard is denser than Normal', () => {
    const [normal, hard] = chart.difficulties;
    expect(hard.notes.length).toBeGreaterThan(normal.notes.length * 1.5);
    const a = analyzeDifficulty(chart, normal);
    expect(a).toBeTruthy();
  });
});
