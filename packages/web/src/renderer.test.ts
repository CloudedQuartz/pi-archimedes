import { describe, it, expect, vi } from 'vitest';
import { Text } from '@earendil-works/pi-tui';
import { reuseText, sanitizeStatus, renderWebSearchCall, renderGetSearchContentResult } from './renderer.js';

describe('renderer', () => {
  it('reuseText recycles existing Text component', () => {
    const existing = new Text('existing', 0, 0);
    const context = { lastComponent: existing };
    expect(reuseText(context)).toBe(existing);
  });

  it('reuseText creates new Text if not exists', () => {
    const result = reuseText({});
    expect(result).toBeInstanceOf(Text);
    expect(result.render(100)).toEqual([]);
  });

  it('sanitizeStatus strips control characters', () => {
    expect(sanitizeStatus('hello\nworld')).toBe('hello world');
    expect(sanitizeStatus('tab\tspace')).toBe('tab space');
    expect(sanitizeStatus('control\x00char')).toBe('control char');
  });

  it('exception resilience: renderer does not throw on malformed input', () => {
    const mockTheme = { fg: () => "" } as any;
    const mockContext = { lastComponent: new Text("", 0, 0) };
    expect(() => {
        renderWebSearchCall(null, mockTheme, mockContext);
    }).not.toThrow();
  });
});

describe('renderGetSearchContentResult', () => {
  // Records the theme token each fragment is coloured with, so a test can tell
  // an error row ("error" token, ✗) from a success row ("success", ✓).
  const theme = { fg: (token: string, s: string) => `${token}:${s}`, bold: (s: string) => s } as any;
  // One context per call: reuseText() recycles `lastComponent`, and the
  // collapsed and expanded rows under test must not share a component.
  const fresh = () => ({ lastComponent: new Text('', 0, 0) });
  const row = (result: unknown, expanded: boolean) =>
    renderGetSearchContentResult(result, { expanded, isPartial: false }, theme, fresh()).render(200).join('\n');

  // The cache-miss result exactly as `get_search_content` returns it: reported
  // with isError, so the row must not read as a successful retrieval.
  const miss = {
    content: [{ type: 'text', text: 'Response not found' }],
    details: { responseId: 'web_missing', error: 'Response not found' },
    isError: true,
  };

  it('collapses to an error row naming the failure, not "Content retrieved"', () => {
    const rendered = row(miss, false);
    expect(rendered).toContain('✗');
    expect(rendered).toContain('error:');
    expect(rendered).toContain('Response not found');
    expect(rendered).not.toContain('Content retrieved');
    expect(rendered).not.toContain('✓');
  });

  it('expands to the failure text, not the "No content found" placeholder', () => {
    const rendered = row(miss, true);
    expect(rendered).toContain('Response not found');
    expect(rendered).not.toContain('No content found');
  });

  it('a successful retrieval still renders its success row (the fix is not a blanket error)', () => {
    const ok = { content: [{ type: 'text', text: 'cached body' }], details: { content: 'cached body' } };
    const rendered = row(ok, false);
    expect(rendered).toContain('✓');
    expect(rendered).toContain('11 characters');
  });

  it('a passages row still renders its passage count', () => {
    const ok = { content: [{ type: 'text', text: '[]' }], details: { matches: [{ passage: 'p', offset: 0, match: 'm' }] } };
    expect(row(ok, false)).toContain('Found 1 passages');
  });
});
