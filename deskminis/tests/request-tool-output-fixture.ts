import { expect } from 'vitest';

/** Request-side assertions keep checking the original result text after validating W1's boundary. */
export function requestToolOutput(value: unknown): string {
  const wire = String(value);
  expect(wire.startsWith('<tool-output>\n'), 'tool output opening boundary').toBe(true);
  expect(wire.endsWith('\n</tool-output>'), 'tool output closing boundary').toBe(true);
  expect(wire.match(/<\/tool-output>/g), 'only one complete closing tag').toHaveLength(1);
  return wire.slice(14, -15);
}
