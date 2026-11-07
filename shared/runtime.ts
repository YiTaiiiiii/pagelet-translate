import { version } from '../package.json';

// Compile into every entrypoint: runtime.getManifest() alone cannot identify
// an old worker still running after unpacked extension files are overwritten.
export const BUILD_VERSION = version;
export const RELOAD_EXTENSION = '扩展已更新，请重新加载扩展，再刷新网页。';
export const REFRESH_PAGE = '网页仍在使用旧版翻译脚本，请刷新网页后重试。';
export class ExtensionUpdateError extends Error {
  constructor() { super(RELOAD_EXTENSION); }
}
