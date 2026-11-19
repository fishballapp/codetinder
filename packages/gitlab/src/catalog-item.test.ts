import { describe, expect, it } from '@effect/vitest';
import { canFlowSweep, compareVersions } from './catalog-item';

describe('compareVersions', () => {
  it('orders versions part by part, numerically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.4.9', '1.5.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });

  it('counts a missing part as 0', () => {
    expect(compareVersions('1.5', '1.5.0')).toBe(0);
    expect(compareVersions('1.5', '1.5.1')).toBeLessThan(0);
  });
});

describe('canFlowSweep', () => {
  it('is the sweep’s version or any later one', () => {
    expect(canFlowSweep('1.5.0')).toBe(true);
    expect(canFlowSweep('1.5.1')).toBe(true);
    expect(canFlowSweep('1.10.0')).toBe(true);
    expect(canFlowSweep('2.0.0')).toBe(true);
  });

  it('is not an older version, nor an unknown pin', () => {
    expect(canFlowSweep('1.4.0')).toBe(false);
    expect(canFlowSweep('1.4.9')).toBe(false);
    expect(canFlowSweep('0.9.0')).toBe(false);
    expect(canFlowSweep(null)).toBe(false);
  });
});
