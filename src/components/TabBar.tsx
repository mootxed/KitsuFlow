import { Menu, Plus, X } from 'lucide-react';
import { useAppStore } from '../state/app-store';

export function TabBar({ onToggleMobileMenu }: { onToggleMobileMenu?: () => void }) {
  const tabs = useAppStore((state) => state.tabs);
  const selectTab = useAppStore((state) => state.selectTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const openEntity = useAppStore((state) => state.openEntity);

  return (
    <div className="tabbar" role="tablist" aria-label="Открытые вкладки">
      {onToggleMobileMenu && (
        <button
          className="icon-btn mobile-menu"
          aria-label="Открыть навигацию"
          onClick={onToggleMobileMenu}
        >
          <Menu size={18} />
        </button>
      )}
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
          <span className="tab-label">{tab.title}</span>
          <button
            className="tab-close"
            aria-label={`Закрыть вкладку ${tab.title}`}
            onClick={(event) => {
              event.stopPropagation();
              void closeTab(tab.id);
            }}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <button
        className="new-tab"
        aria-label="Новая вкладка Все задачи"
        onClick={() => void openEntity({ kind: 'all' }, { newTab: true, duplicate: true })}
      >
        <Plus size={16} />
      </button>
    </div>
  );
}
