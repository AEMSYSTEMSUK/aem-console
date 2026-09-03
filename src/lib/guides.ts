import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

export interface GuideFrontMatter {
  id: string;
  title: string;
  tags?: string[];
  'applies-to'?: { 'server-class'?: string[]; 'domain-class'?: string[] };
  proof?: { 'first-verified'?: string; 'domains-proved'?: string[] };
  checks?: Array<{ id: string; type: string; [k: string]: unknown }>;
  'last-updated'?: string;
}

export interface Guide {
  slug: string;
  front: GuideFrontMatter;
  body: string;
  mtime: string;
}

export function listGuides(): Guide[] {
  const dir = process.env.AEM_GUIDES_DIR || path.join(process.cwd(), 'guides');
  const out: Guide[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch (e) {
    console.error('[guides] readdir fail:', dir, e);
    return [];
  }
  for (const f of files) {
    const fp = path.join(dir, f);
    try {
      const raw = readFileSync(fp, 'utf8');
      if (!raw.startsWith('---')) { console.error('[guides] no --- start:', fp); continue; }
      const closing = raw.indexOf('\n---\n', 3);
      if (closing < 0) { console.error('[guides] no closing ---:', fp); continue; }
      const yamlText = raw.slice(3, closing).replace(/^\n/, '');
      const body = raw.slice(closing + 5);
      const front = yaml.load(yamlText) as GuideFrontMatter;
      if (!front?.id) { console.error('[guides] no id:', fp, front); continue; }
      const stat = statSync(fp);
      out.push({ slug: front.id, front, body, mtime: stat.mtime.toISOString() });
    } catch (e) {
      console.error('[guides] parse fail:', fp, e);
    }
  }
  return out.sort((a, b) => String(b.front['last-updated'] ?? '').localeCompare(String(a.front['last-updated'] ?? '')));
}

export function getGuide(slug: string): Guide | null {
  return listGuides().find((g) => g.slug === slug) ?? null;
}

export function allTags(): string[] {
  const set = new Set<string>();
  for (const g of listGuides()) {
    for (const t of g.front.tags ?? []) set.add(t);
  }
  return Array.from(set).sort();
}
