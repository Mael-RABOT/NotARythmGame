import bundled from 'virtual:bundled-charts';
import { describe, expect, it } from 'vitest';
import { lintDifficulty } from './analysis';
import { parseChart } from './serialize';
import { TimingMap } from './TimingMap';

describe('built-in charts (charts/*.narg)', () => {
  it('ships at least the title-screen song', () => {
    expect(bundled.map((b) => b.file)).toContain('fearless-pt2.narg');
  });

  it('have unique ids', () => {
    const ids = bundled.map((b) => parseChart(b.chart).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const { file, chart: raw } of bundled) {
    const chart = parseChart(raw);
    const timing = new TimingMap(chart.timing, chart.audio.offsetMs);
    for (const diff of chart.difficulties) {
      it(`${file} / ${diff.name} has no lint errors or warnings`, () => {
        const issues = lintDifficulty(chart, diff).filter((i) => i.level !== 'info');
        expect(issues.map((i) => `${timing.beatLabel(i.tick)} ${i.message}`)).toEqual([]);
      });
    }
  }
});
