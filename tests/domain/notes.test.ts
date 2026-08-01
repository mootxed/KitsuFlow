import { describe, expect, it } from 'vitest';
import { createLocalNote, noteToIssueBody, shouldPublishAsIssue } from '../../src/domain/notes';

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
});
