import { describe, expect, it } from 'vitest';
import { APP_CONFIG } from '../../src/config';
import {
  derivePriority,
  deriveStatus,
  isPullRequest,
  labelsForMove,
  labelsForPriority,
  labelsForStatus,
  normalizeIssue,
  visibleLabels,
} from '../../src/domain/github-mapping';
import { apiIssue } from '../fixtures';

describe('GitHub Issue mapping', () => {
  it('maps an open issue without a system status label to todo', () => {
    expect(deriveStatus(apiIssue({ labels: [{ name: 'bug' }] }))).toEqual({
      status: 'todo',
      conflict: false,
    });
  });

  it('maps in-progress and postponed labels (kf: and legacy km:)', () => {
    expect(deriveStatus(apiIssue({ labels: [APP_CONFIG.labels.status.inProgress] })).status).toBe(
      'in_progress',
    );
    expect(deriveStatus(apiIssue({ labels: ['km:status:in-progress'] })).status).toBe(
      'in_progress',
    );
    expect(deriveStatus(apiIssue({ labels: [APP_CONFIG.labels.status.postponed] })).status).toBe(
      'postponed',
    );
    expect(deriveStatus(apiIssue({ labels: ['km:status:postponed'] })).status).toBe('postponed');
  });

  it('always maps a closed issue to done', () => {
    expect(
      deriveStatus(apiIssue({ state: 'closed', labels: [APP_CONFIG.labels.status.inProgress] })),
    ).toEqual({ status: 'done', conflict: false });
  });

  it('maps priority from system labels (kf: and legacy km:)', () => {
    expect(derivePriority([APP_CONFIG.labels.priority.urgent])).toEqual({
      priority: 'urgent',
      conflict: false,
    });
    expect(derivePriority(['km:priority:high'])).toEqual({
      priority: 'high',
      conflict: false,
    });
    expect(derivePriority([{ name: 'feature' }])).toEqual({ priority: 'none', conflict: false });
  });

  it('hides both kf: and km: system prefixes in visibleLabels', () => {
    const labels = [
      { name: 'bug', color: 'red' },
      { name: 'kf:status:in-progress', color: 'green' },
      { name: 'km:priority:high', color: 'orange' },
      { name: 'feature', color: 'blue' },
    ];
    expect(visibleLabels(labels)).toEqual([
      { name: 'bug', color: 'red' },
      { name: 'feature', color: 'blue' },
    ]);
  });

  it('migrates legacy km: labels to kf: labels on status/priority update', () => {
    const current = ['km:status:postponed', 'km:priority:low', 'enhancement'];
    const updatedStatus = labelsForStatus(current, 'in_progress');
    expect(updatedStatus).toContain('kf:status:in-progress');
    expect(updatedStatus).not.toContain('km:status:postponed');

    const updatedPriority = labelsForPriority(current, 'high');
    expect(updatedPriority).toContain('kf:priority:high');
    expect(updatedPriority).not.toContain('km:priority:low');
  });

  it('atomically moves status and priority via labelsForMove', () => {
    const current = ['km:status:todo', 'km:priority:low', 'bug'];
    const moved = labelsForMove(current, 'in_progress', 'urgent');
    expect(moved).toEqual(['bug', 'kf:status:in-progress', 'kf:priority:urgent']);
  });

  it('detects conflicting system labels without silently resolving them', () => {
    const issue = normalizeIssue(
      'acme/repo',
      apiIssue({
        labels: [
          APP_CONFIG.labels.status.inProgress,
          APP_CONFIG.labels.status.postponed,
          APP_CONFIG.labels.priority.low,
          APP_CONFIG.labels.priority.high,
        ],
      }),
    );
    expect(issue.statusConflict).toBe(true);
    expect(issue.priorityConflict).toBe(true);
    expect(issue.syncState).toBe('conflict');
  });

  it('recognizes pull requests returned by the Issues API', () => {
    expect(isPullRequest(apiIssue({ pull_request: { url: 'test' } }))).toBe(true);
    expect(isPullRequest(apiIssue())).toBe(false);
  });
});
