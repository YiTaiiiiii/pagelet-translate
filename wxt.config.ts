import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  // PAGELET_PROFILE=1 keeps function names readable in CPU profiles; never shipped.
  vite: () => (process.env.PAGELET_PROFILE ? { build: { minify: false } } : {}),
  manifest: {
    name: '原页 · Pagelet',
    description: '用自己的模型 API，在原网页阅读译文。双语、替换，一键恢复。',
    permissions: ['storage', 'activeTab', 'scripting', 'webNavigation'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    icons: { 16: '/icon/16.png', 32: '/icon/32.png', 48: '/icon/48.png', 128: '/icon/128.png' },
    action: { default_title: '原页', default_icon: { 16: '/icon/16.png', 32: '/icon/32.png' } },
    options_ui: { page: 'options.html', open_in_tab: true },
    commands: {
      'toggle-translation': {
        suggested_key: { default: 'Alt+T', mac: 'Alt+T' },
        description: '翻译 / 恢复原文',
      },
    },
  },
});
