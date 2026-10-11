// Stands in for every non-English catalog in src/lib/i18n/locales/ in the Tizen
// build (see vite.config.ts). The TV ships English only for now, and
// installTizenPlatform limits the language pickers to match.
const catalog: Record<string, string> = {};
export default catalog;
