import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    css: {
      postcss: {
        plugins: [
          require('@tailwindcss/postcss'),
          require('autoprefixer'),
        ],
      },
    },
  }),
  manifest: {
    name: 'Tabi',
    short_name: 'Tabi',
    version: '1.0.0',
    description: 'Tabi works across your tabs for you: it reads pages, fills in forms and carries out tasks, using your own AI provider key.',
    // The toolbar icon: one colour, never animated; the worker swaps in the dark-toolbar ink and the amber dot
    action: {
      default_title: 'Tabi',
      default_icon: {
        '16': 'icons/toolbar-light-16.png',
        '32': 'icons/toolbar-light-32.png',
        '48': 'icons/toolbar-light-48.png',
        '128': 'icons/toolbar-light-128.png',
      },
    },
    // No popup: the toolbar icon opens the side panel (entrypoints/sidepanel), as do Alt+T and the right-click menu.
    // Alt+T, not Ctrl+G: the browser's own shortcuts win, and Ctrl+G is Find next. The key is only a
    // suggestion applied at install; people change it on the browser's shortcuts page (Settings links there).
    permissions: ['activeTab', 'scripting', 'storage', 'debugger', 'alarms', 'notifications', 'tabGroups', 'sidePanel', 'contextMenus'],
    commands: {
      _execute_action: { suggested_key: { default: 'Alt+T' }, description: 'Open Tabi' },
    },
    // <all_urls> covers every LLM provider, including a local Ollama
    host_permissions: ['<all_urls>'],
    // The app icon (extensions page, store, notifications): a white mark on a cobalt rounded square
    icons: {
      '16': 'icons/icon16.png',
      '32': 'icons/icon32.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png',
    },
  },
});
