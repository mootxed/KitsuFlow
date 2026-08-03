import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useAppStore } from './state/app-store';
import type { GitHubIssue, IssuePriority, LocalNote, TaskStatus } from './domain/types';
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
  const createDialog = useAppStore((state) => state.createDialog);
  const repositoryPickerOpen = useAppStore((state) => state.repositoryPickerOpen);
  const conversionDialog = useAppStore((state) => state.conversionDialog);
  const auth = useAppStore((state) => state.auth);
  const tabs = useAppStore((state) => state.tabs);
  const setRepositoryPickerOpen = useAppStore((state) => state.setRepositoryPickerOpen);
  const setConversionNoteId = useAppStore((state) => state.setConversionNoteId);
  const logout = useAppStore((state) => state.logout);
  const updateNote = useAppStore((state) => state.updateNote);
  const requestConversion = useAppStore((state) => state.requestConversion);
  const changeIssueStatus = useAppStore((state) => state.changeIssueStatus);
  const moveIssue = useAppStore((state) => state.moveIssue);
  const moveIssueToQuestion = useAppStore((state) => state.moveIssueToQuestion);

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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
        const activeTab = tabs.find((t) => t.active);
        const repoFullName =
          activeTab?.entity.kind === 'repository' ? activeTab.entity.repositoryFullName : undefined;
        setCreateOpen(true, { initialRepositoryFullName: repoFullName });
      }
      if (event.key === 'Escape') {
        if (mobileMenuOpen) setMobileMenuOpen(false);
        else if (createDialog.open) setCreateOpen(false);
        else if (repositoryPickerOpen) setRepositoryPickerOpen(false);
        else if (conversionDialog.noteId) setConversionNoteId(null);
        else if (auth.phase !== 'idle') logout();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    auth.phase,
    conversionDialog.noteId,
    createDialog.open,
    logout,
    mobileMenuOpen,
    repositoryPickerOpen,
    setConversionNoteId,
    setCreateOpen,
    setRepositoryPickerOpen,
    tabs,
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
      if (target.type === 'repository') {
        requestConversion(note.id, {
          repositoryFullName: target.repositoryFullName,
          status: 'todo',
          priority: 'none',
        });
      } else if (target.type === 'status') {
        if (target.status === 'question') {
          void updateNote(note.id, {
            repositoryFullName: target.repositoryFullName,
            status: 'question',
          });
        } else {
          requestConversion(note.id, {
            repositoryFullName: target.repositoryFullName,
            status: target.status as TaskStatus,
            priority: 'none',
          });
        }
      } else if (target.type === 'priority') {
        requestConversion(note.id, {
          repositoryFullName: target.repositoryFullName,
          status: target.status as TaskStatus,
          priority: target.priority as IssuePriority,
        });
      }
      return;
    }

    const issue = source.item as GitHubIssue;
    if (target.type === 'status') {
      if (target.status === 'question') {
        if (window.confirm('Закрыть GitHub Issue и создать локальную копию в "Под вопросом"?')) {
          void moveIssueToQuestion(issue);
        }
      } else {
        void changeIssueStatus(issue, target.status as Exclude<TaskStatus, 'question'>);
      }
    }
    if (target.type === 'priority') {
      void moveIssue(issue, {
        status: target.status as Exclude<TaskStatus, 'question'>,
        priority: target.priority as IssuePriority,
      });
    }
  };

  if (!initialized)
    return <div className="app-loading">Загрузка локального рабочего пространства…</div>;

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="app-shell">
        {mobileMenuOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
        )}
        <Sidebar open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)} />

        <main className="main-shell">
          <TabBar onToggleMobileMenu={() => setMobileMenuOpen((prev) => !prev)} />
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
