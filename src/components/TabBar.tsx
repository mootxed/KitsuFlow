import { Plus, X } from 'lucide-react';
import { useAppStore } from '../state/app-store';

export function TabBar() {
  const tabs = useAppStore((state) => state.tabs);
  const selectTab = useAppStore((state) => state.selectTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const openEntity = useAppStore((state) => state.openEntity);
  return (
    <div className="tabbar" role="tablist" aria-label="Открытые вкладки">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          tabIndex={tab.active ? 0 : -1}
          aria-selected={tab.active}
          className={`tab ${tab.active ? 'active' : ''}`}
          onClick={() => void selectTab(tab.id)}
          onMouseDown={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              void closeTab(tab.id);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') void selectTab(tab.id);
          }}
        >
          <span>{tab.title}</span>
          <button
            aria-label={`Закрыть вкладку ${tab.title}`}
            onClick={(event) => {
              event.stopPropagation();
              void closeTab(tab.id);
            }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button
        className="new-tab"
        aria-label="Новая вкладка Все задачи"
        onClick={() => void openEntity({ kind: 'all' }, { newTab: true, duplicate: true })}
      >
        <Plus size={15} />
      </button>
    </div>
  );
}
