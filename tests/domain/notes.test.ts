import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  createLocalNote,
  extractChecklistFromMarkdown,
  noteToIssueBody,
  shouldPublishAsIssue,
  stripSystemLabels,
} from '../../src/domain/notes';

describe('local note invariants', () => {
  it('never adds priority to a local note', () => {
    const note = createLocalNote({ title: 'Local', status: 'todo' });
    expect(note).not.toHaveProperty('priority');
  });

  it('does not allow question without repository', () => {
    expect(() => createLocalNote({ title: 'Question', status: 'question' })).toThrow(
      'только внутри репозитория',
    );
  });

  it('never publishes question to GitHub', () => {
    expect(shouldPublishAsIssue('acme/repo', 'question')).toBe(false);
  });

  it('publishes a repository task with any synchronized status', () => {
    expect(shouldPublishAsIssue('acme/repo', 'todo')).toBe(true);
    expect(shouldPublishAsIssue('acme/repo', 'done')).toBe(true);
    expect(shouldPublishAsIssue(null, 'todo')).toBe(false);
  });

  it('moves checklist and unmatched local tags to Issue body', () => {
    const note = createLocalNote({
      title: 'Publish',
      status: 'question',
      repositoryFullName: 'acme/repo',
      description: 'Details',
      localTags: ['bug', 'private'],
      checklist: [{ id: '1', text: 'Verify', checked: true }],
    });
    expect(noteToIssueBody(note, ['bug'])).toContain('- [x] Verify');
    expect(noteToIssueBody(note, ['bug'])).toContain('Local tags: private');
  });

  it('extracts checklist items from Markdown body correctly', () => {
    const body = `Some description header\n\n- [ ] Task one\n- [x] Task two\n\nFooter note`;
    const { checklist, description } = extractChecklistFromMarkdown(body);
    expect(checklist).toHaveLength(2);
    expect(checklist[0]).toEqual(expect.objectContaining({ text: 'Task one', checked: false }));
    expect(checklist[1]).toEqual(expect.objectContaining({ text: 'Task two', checked: true }));
    expect(description).toBe('Some description header\n\nFooter note');
  });

  it('strips both km: and kf: system labels', () => {
    const labels = [
      { name: 'bug' },
      { name: 'km:status:in-progress' },
      { name: 'kf:priority:high' },
      'frontend',
    ];
    expect(stripSystemLabels(labels)).toEqual(['bug', 'frontend']);
  });

  it('preserves round-trip conversion without duplicate checklist items', () => {
    const body = `Header\n\n- [ ] Item A\n- [x] Item B`;
    const { checklist, description } = extractChecklistFromMarkdown(body);

    const note = createLocalNote({
      title: 'Roundtrip Test',
      description,
      checklist,
      status: 'question',
      repositoryFullName: 'acme/repo',
    });

    const regeneratedBody = noteToIssueBody(note, []);
    expect(regeneratedBody).toBe(body);
  });

  it('ensures MIT license is preserved in package.json and LICENSE file', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'));
    expect(pkg.license).toBe('MIT');

    const licenseText = readFileSync(resolve(__dirname, '../../LICENSE'), 'utf-8');
    expect(licenseText).toContain('MIT License');
  });
});
