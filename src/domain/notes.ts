import { isSystemLabel } from '../config';
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

/**
 * Извлекает checklist-строки из Markdown body и возвращает их отдельно,
 * а описание — без checklist-строк.
 * Работает по спецификации GFM: `- [ ] …` и `- [x] …`
 */
export function extractChecklistFromMarkdown(body: string): {
  checklist: ChecklistItem[];
  description: string;
} {
  const lines = body.split('\n');
  const checklist: ChecklistItem[] = [];
  const descriptionLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*- \[([ xX])\]\s+(.+)$/);
    if (match) {
      checklist.push({
        id: crypto.randomUUID(),
        checked: match[1]?.toLowerCase() === 'x',
        text: match[2]?.trim() || '',
      });
    } else {
      descriptionLines.push(line);
    }
  }

  // Убираем лишние пустые строки в конце описания
  const description = descriptionLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { checklist, description };
}

/**
 * Возвращает копию массива labels без системных labels (km:* и kf:*).
 * Используется при переносе Issue в «Под вопросом».
 */
export function stripSystemLabels(labels: Array<{ name: string } | string>): string[] {
  return labels
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter((name) => !isSystemLabel(name));
}

/**
 * Составляет тело GitHub Issue из LocalNote.
 * Checklist не дублируется, если он уже является частью description.
 */
export function noteToIssueBody(note: LocalNote, matchedTags: string[]): string {
  // Убираем checklist из description на случай если он туда попал
  const { description } = extractChecklistFromMarkdown(note.description);
  const checklistMd = checklistToMarkdown(note.checklist);
  const sections = [description, checklistMd];
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
