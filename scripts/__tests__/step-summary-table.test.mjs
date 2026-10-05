import { describe, it, expect, vi } from 'vitest';
import { buildStepSummaryTable, appendStepSummaryTable } from '../lib/step-summary-table.mjs';

describe('buildStepSummaryTable', () => {
  it('renders a markdown table with the given title and rows', () => {
    const md = buildStepSummaryTable('Example Summary', [
      ['Scanned', 3],
      ['Skipped', 1],
    ]);
    expect(md).toBe(
      [
        '## Example Summary',
        '',
        '| Metric | Value |',
        '|--------|-------|',
        '| Scanned | 3 |',
        '| Skipped | 1 |',
        '',
        '',
      ].join('\n'),
    );
  });

  it('renders an empty table body when there are no rows', () => {
    const md = buildStepSummaryTable('No Rows', []);
    expect(md).toBe(['## No Rows', '', '| Metric | Value |', '|--------|-------|', '', ''].join('\n'));
  });
});

describe('appendStepSummaryTable', () => {
  it('appends the rendered table when GITHUB_STEP_SUMMARY is set', () => {
    const appendFile = vi.fn();
    appendStepSummaryTable('Title', [['Count', 5]], {
      env: { GITHUB_STEP_SUMMARY: '/tmp/fake-summary' },
      appendFile,
    });
    expect(appendFile).toHaveBeenCalledTimes(1);
    const [path, content, encoding] = appendFile.mock.calls[0];
    expect(path).toBe('/tmp/fake-summary');
    expect(content).toContain('## Title');
    expect(content).toContain('| Count | 5 |');
    expect(encoding).toBe('utf8');
  });

  it('does nothing when GITHUB_STEP_SUMMARY is unset', () => {
    const appendFile = vi.fn();
    appendStepSummaryTable('Title', [['Count', 5]], { env: {}, appendFile });
    expect(appendFile).not.toHaveBeenCalled();
  });
});
