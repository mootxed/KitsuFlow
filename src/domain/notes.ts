import type { ChecklistItem, ConversionDraft, LocalNote, TaskStatus } from './types';

export function validateLocalNote(note: LocalNote): void {
  if (!note.title.trim()) throw new Error('Название обязательно');
  if (note.status === 'question' && !note.repositoryFullName) {
    throw new Error('Статус «Под вопросом» доступен только внутри репозитория');
  }
}

export function shouldPublishAsIssue(
  repositoryFullName: string | null,
  status: TaskStatus,
): boolean {
  return Boolean(repositoryFullName && status !== 'question');
}

export function checklistToMarkdown(items: ChecklistItem[]): string {
  return items.map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`).join('\n');
}

export function noteToIssueBody(note: LocalNote, matchedTags: string[]): string {
  const sections = [note.description.trim(), checklistToMarkdown(note.checklist)];
  const unmatched = note.localTags.filter((tag) => !matchedTags.includes(tag));
  if (unmatched.length) sections.push(`Local tags: ${unmatched.join(', ')}`);
  return sections.filter(Boolean).join('\n\n');
}

export function createLocalNote(input: {
  title: string;
  description?: string;
  status: TaskStatus;
  repositoryFullName?: string | null;
  localTags?: string[];
  checklist?: ChecklistItem[];
  pendingConversionData?: ConversionDraft;
}): LocalNote {
  const now = new Date().toISOString();
  const note: LocalNote = {
    id: crypto.randomUUID(),
    title: input.title.trim(),
    description: input.description || '',
    status: input.status,
    repositoryFullName: input.repositoryFullName || null,
    localTags: input.localTags || [],
    checklist: input.checklist || [],
    createdAt: now,
    updatedAt: now,
    syncState: 'local',
  };
  if (input.pendingConversionData) note.pendingConversionData = input.pendingConversionData;
  validateLocalNote(note);
  return note;
}
