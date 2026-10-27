import { Moon, Sun } from 'lucide-react';
import { useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'inbox-theme';

function currentTheme(): Theme {
  return document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light';
}

function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage can be blocked (private mode); the toggle still works for this visit.
  }
}

export function ThemeToggle(): ReactNode {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  function handleToggle(): void {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset['theme'] = next;
    storeTheme(next);
    setTheme(next);
  }

  const label = theme === 'dark' ? 'Usar tema claro' : 'Usar tema oscuro';
  return (
    <button
      type="button"
      onClick={handleToggle}
      aria-label={label}
      title={label}
      className="grid size-9 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      {theme === 'dark' ? (
        <Sun className="size-4" aria-hidden="true" />
      ) : (
        <Moon className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}
