/** The public `codetinder` flow in GitLab's AI Catalog, managed by this project. */
export const CATALOG_ITEM_ID = 'gid://gitlab/Ai::Catalog::Item/1016509';

/**
 * The first version of the flow that routes a sweep. On an older one a sweep's run would claim the
 * sweep and stop without one, so a project needs Update before it sweeps.
 */
export const SWEEP_FLOW_VERSION = '1.5.0';

/**
 * Orders two dotted versions part by part, numerically, a missing part counting as 0: negative
 * when `left` is older, 0 when equal, positive when newer.
 */
export const compareVersions = (left: string, right: string): number => {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const partCount = Math.max(leftParts.length, rightParts.length);
  const differences = Array.from(
    { length: partCount },
    (_part, index) => (leftParts[index] ?? 0) - (rightParts[index] ?? 0),
  );
  return differences.find(difference => difference !== 0) ?? 0;
};

/** Whether a project pinned to `version` can sweep; an unknown pin can't. */
export const canFlowSweep = (version: string | null): boolean =>
  version !== null && compareVersions(version, SWEEP_FLOW_VERSION) >= 0;
