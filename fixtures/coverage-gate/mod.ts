// Fixture for the coverage-gate self-test. Deliberately under-tested: only `covered`
// is exercised by mod.spec.ts, so a high coverage threshold must fail this directory.

export function covered(a: number, b: number): number {
  return a + b;
}

export function uncovered(value: number): string {
  if (value > 0) {
    return 'positive';
  }
  if (value < 0) {
    return 'negative';
  }
  return 'zero';
}
