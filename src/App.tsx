import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useAppStore } from './state/app-store';
import type { GitHubIssue, LocalNote } from './domain/types';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { Workspace } from './components/Workspace';
import { DetailsPanel } from './components/DetailsPanel';
import { QuickCreateModal } from './components/QuickCreateModal';
import { RepositoryPicker } from './components/RepositoryPicker';
import { ConversionModal } from './components/ConversionModal';
import { AuthModal } from './components/AuthModal';

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest('input, textarea, select, [contenteditable="true"], .markdown-editor'),
  );
};

export function App() {
  const initialize = useAppStore((state) => state.initialize);
  const initialized = useAppStore((state) => state.initialized);
  const setCreateOpen = useAppStore((state) => state.setCreateOpen);
  const createOpen = useAppStore((state) => state.createOpen);
  const repositoryPickerOpen = useAppStore((state) => state.repositoryPickerOpen);
  const conversionNoteId = useAppStore((state) => state.conversionNoteId);
  const auth = useAppStore((state) => state.auth);
  const setRepositoryPickerOpen = useAppStore((state) => state.setRepositoryPickerOpen);
  const setConversionNoteId = useAppStore((state) => state.setConversionNoteId);
  const logout = useAppStore((state) => state.logout);
  const requestConversion = useAppStore((state) => state.requestConversion);
  const changeIssueStatus = useAppStore((state) => state.changeIssueStatus);
  const moveIssue = useAppStore((state) => state.moveIssue);
  const moveIssueToQuestion = useAppStore((state) => state.moveIssueToQuestion);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === 'c' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        setCreateOpen(true);
      }
      if (event.key === 'Escape') {
        if (createOpen) setCreateOpen(false);
        else if (repositoryPickerOpen) setRepositoryPickerOpen(false);
        else if (conversionNoteId) setConversionNoteId(null);
        else if (auth.phase !== 'idle') logout();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    auth.phase,
    conversionNoteId,
    createOpen,
    logout,
    repositoryPickerOpen,
    setConversionNoteId,
    setCreateOpen,
    setRepositoryPickerOpen,
  ]);

  const handleDragEnd = (event: DragEndEvent) => {
    if (!event.over) return;
    const source = event.active.data.current as {
      type: 'note' | 'issue';
      item: LocalNote | GitHubIssue;
    };
    const target = event.over.data.current as
      | { type: 'repository'; repositoryFullName: string }
      | { type: 'status'; status: string; repositoryFullName: string }
      | { type: 'priority'; priority: string; status: string; repositoryFullName: string };
    if (!source || !target) return;
    if (source.type === 'note') {
      const note = source.item as LocalNote;
      if (target.type === 'repository') requestConversion(note.id, target.repositoryFullName);
      else if (target.type === 'status' || target.type === 'priority') {
        requestConversion(note.id, target.repositoryFullName);
      }
      return;
    }
    const issue = source.item as GitHubIssue;
    if (target.type === 'status') {
      if (target.status === 'question') {
        if (window.confirm('Закрыть GitHub Issue и создать локальную копию в "Под вопросом"?')) {
          void moveIssueToQuestion(issue);
        }
      } else void changeIssueStatus(issue, target.status as any);
    }
    if (target.type === 'priority') {
      // Атомарный перенос: один вызов, одна outbox-операция
      void moveIssue(issue, {
        status: target.status as Exclude<import('./domain/types').TaskStatus, 'question'>,
        priority: target.priority as import('./domain/types').IssuePriority,
      });
    }
  };

  if (!initialized)
    return <div className="app-loading">Загрузка локального рабочего пространства…</div>;

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="app-shell">
        <Sidebar />
        <main className="main-shell">
          <TabBar />
          <Workspace />
        </main>
        <DetailsPanel />
      </div>
      <QuickCreateModal />
      <RepositoryPicker />
      <ConversionModal />
      <AuthModal />
      {needRefresh && (
        <div className="update-banner" role="status">
          Доступна новая версия.
          <button onClick={() => void updateServiceWorker(true)}>Перезагрузить</button>
        </div>
      )}
    </DndContext>
  );
}
