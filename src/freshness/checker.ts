import { App, TFile, getAllTags, moment } from 'obsidian';
import { getDailyNotes, getDailyNotesSettings } from '../daily-notes';
import { estimateTokens } from '../token-counter';
import {
  type PackRecord,
  type PackCheckResult,
  type FreshnessSettings,
  type FreshnessLevel,
  TARGET_CONTEXT_LIMIT,
} from './types';

export function packKey(source: PackRecord['source'], target: PackRecord['target']): string {
  return `${source.type}|${source.query}|${target}`;
}

export function buildPackRecord(
  name: string,
  source: PackRecord['source'],
  target: PackRecord['target'],
  files: TFile[],
): PackRecord {
  return {
    name,
    source,
    target,
    files: files.map((f) => ({
      path: f.path,
    })),
  };
}

export function getPackSlug(source: PackRecord['source']): string {
  switch (source.type) {
    case 'tag':
      return `tag-${source.query.replace(/^#/, '').replace(/\//g, '-')}`;
    case 'folder': {
      const folderName = source.query.split('/').filter(Boolean).pop() ?? source.query;
      return `folder-${folderName}`;
    }
    case 'moc': {
      const mocName = source.query.split('/').filter(Boolean).pop()?.replace(/\.md$/, '') ?? source.query;
      return `moc-${mocName}`;
    }
    case 'daily':
      return 'daily-notes';
  }
}

export function findExportedPackFile(
  app: App,
  pack: PackRecord,
  outputFolder?: string,
): TFile | null {
  const folder = outputFolder || '';
  const slug = getPackSlug(pack.source);
  const prefix = `pack-${slug}`;

  // 1. Try exact target match (e.g. pack-tag-export-WooPilot-gemini.md)
  const targetExt = pack.target === 'notebooklm' ? '' : `-${pack.target}`;
  const candidatePath = folder ? `${folder}/${prefix}${targetExt}.md` : `${prefix}${targetExt}.md`;
  const candidate = app.vault.getAbstractFileByPath(candidatePath);
  if (candidate instanceof TFile) return candidate;

  // 2. Try plain match (e.g. pack-daily-notes.md)
  const plainPath = folder ? `${folder}/${prefix}.md` : `${prefix}.md`;
  const plain = app.vault.getAbstractFileByPath(plainPath);
  if (plain instanceof TFile) return plain;

  // 3. Search in output folder for any markdown file starting with prefix
  if (typeof app.vault.getMarkdownFiles === 'function') {
    const allFiles = folder
      ? app.vault.getMarkdownFiles().filter(f => f.path.startsWith(folder + '/'))
      : app.vault.getMarkdownFiles();
    const found = allFiles.find(f => f.name.startsWith(prefix) && f.extension === 'md');
    if (found) return found;
  }

  return null;
}

async function resolveCurrentFiles(app: App, source: PackRecord['source']): Promise<TFile[]> {
  switch (source.type) {
    case 'folder': {
      const prefix = source.query.endsWith('/') ? source.query : source.query + '/';
      return app.vault.getMarkdownFiles().filter(
        (f) => f.path === source.query || f.path.startsWith(prefix),
      );
    }
    case 'tag': {
      const tag = source.query.startsWith('#') ? source.query : '#' + source.query;
      return app.vault.getMarkdownFiles().filter((f) => {
        const cache = app.metadataCache.getFileCache(f);
        const tags = cache ? getAllTags(cache) : null;
        return tags?.includes(tag) ?? false;
      });
    }
    case 'moc': {
      return resolveMocFiles(app, source.query);
    }
    case 'daily': {
      return resolveDailyFiles(app, source.query);
    }
  }
}

function resolveMocFiles(app: App, mocPath: string): TFile[] {
  const moc = app.vault.getAbstractFileByPath(mocPath);
  if (!(moc instanceof TFile)) return [];
  const cache = app.metadataCache.getFileCache(moc);
  const links = cache?.links?.map((l) => l.link) ?? [];
  const files: TFile[] = [];
  for (const link of links) {
    const linked = app.metadataCache.getFirstLinkpathDest(link, mocPath);
    if (linked instanceof TFile && linked.extension === 'md') {
      files.push(linked);
    }
  }
  return files;
}

async function resolveDailyFiles(app: App, query: string): Promise<TFile[]> {
  const [startStr, endStr] = query.split('..');
  if (!startStr || !endStr) return [];
  const start = moment(startStr, 'YYYY-MM-DD').startOf('day').toDate();
  const end = moment(endStr, 'YYYY-MM-DD').endOf('day').toDate();
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];

  const plugin = (app as unknown as { plugins?: { plugins?: Record<string, { settings?: { dailyNotesAutoDetect?: boolean; dailyNotesFolder?: string; dailyNotesFormat?: string } }> } })
    .plugins?.plugins?.['context-pack-for-notebooklm'];
  let config;
  if (plugin?.settings && !plugin.settings.dailyNotesAutoDetect && plugin.settings.dailyNotesFolder) {
    config = { folder: plugin.settings.dailyNotesFolder, format: plugin.settings.dailyNotesFormat || 'YYYY-MM-DD' };
  } else {
    config = await getDailyNotesSettings(app);
  }
  return getDailyNotes(app, config, start, end);
}

export async function checkPack(
  app: App,
  pack: PackRecord,
  settings: FreshnessSettings,
  outputFolder?: string,
): Promise<PackCheckResult> {
  const current = await resolveCurrentFiles(app, pack.source);
  const currentByPath = new Map(current.map((f) => [f.path, f]));
  const recordedByPath = new Map(pack.files.map((r) => [r.path, r]));

  const unchanged: string[] = [];
  const updated: string[] = [];
  const missing: string[] = [];
  const added: string[] = [];

  for (const rec of pack.files) {
    const file = currentByPath.get(rec.path);
    if (!file) {
      missing.push(rec.path);
      continue;
    }
    const changed = (rec.mtime !== undefined && file.stat.mtime > rec.mtime) ||
      (rec.size !== undefined && file.stat.size !== rec.size);
    (changed ? updated : unchanged).push(rec.path);
  }

  for (const f of current) {
    if (!recordedByPath.has(f.path)) added.push(f.path);
  }

  const matchedCount = current.length;
  const staleCount = updated.length + added.length;
  const freshnessScore = matchedCount > 0 ? (matchedCount - staleCount) / matchedCount : 1;

  const staleRatio = 1 - freshnessScore;
  let level: FreshnessLevel = 'fresh';
  if (staleRatio >= settings.staleThreshold) level = 'stale';
  else if (staleRatio > settings.warnThreshold || missing.length > 0) level = 'warn';

  let tokenCount: number | undefined;
  if (typeof app.vault?.cachedRead === 'function') {
    const packFile = findExportedPackFile(app, pack, outputFolder);
    if (packFile) {
      try {
        const text = await app.vault.cachedRead(packFile);
        tokenCount = estimateTokens(text);
      } catch {
        // ignore read error
      }
    } else if (current.length > 0) {
      try {
        let total = 0;
        for (const file of current) {
          const text = await app.vault.cachedRead(file);
          total += estimateTokens(text);
        }
        tokenCount = total;
      } catch {
        // ignore read error
      }
    }
  }

  const contextLimit = TARGET_CONTEXT_LIMIT[pack.target] ?? 1_000_000;

  return {
    key: packKey(pack.source, pack.target),
    level,
    freshnessScore,
    matchedCount,
    unchanged,
    updated,
    added,
    missing,
    tokenCount,
    contextLimit,
  };
}

export async function checkAllPacks(
  app: App,
  packs: PackRecord[],
  settings: FreshnessSettings,
  outputFolder?: string,
): Promise<PackCheckResult[]> {
  return Promise.all(packs.map((p) => checkPack(app, p, settings, outputFolder)));
}

/** ファイル/フォルダのリネーム・移動に合わせて PackRecord 群を更新する（破壊的）。変更があれば true を返す。 */
export function applyRenameToRegistry(
  packs: PackRecord[],
  oldPath: string,
  newPath: string,
  isFolder: boolean,
): boolean {
  let changed = false;

  for (const pack of packs) {
    // source.query の更新
    if (isFolder && pack.source.type === 'folder') {
      if (pack.source.query === oldPath) {
        pack.source.query = newPath;
        changed = true;
      } else if (pack.source.query.startsWith(oldPath + '/')) {
        pack.source.query = newPath + pack.source.query.slice(oldPath.length);
        changed = true;
      }
    }
    if (!isFolder && pack.source.type === 'moc' && pack.source.query === oldPath) {
      pack.source.query = newPath;
      changed = true;
    }

    // files[].path の更新
    for (const rec of pack.files) {
      if (rec.path === oldPath) {
        rec.path = newPath;
        changed = true;
      } else if (isFolder && rec.path.startsWith(oldPath + '/')) {
        rec.path = newPath + rec.path.slice(oldPath.length);
        changed = true;
      }
    }
  }

  return changed;
}
