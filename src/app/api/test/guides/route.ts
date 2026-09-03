import { NextResponse } from 'next/server';
import { listGuides } from '@/lib/guides';
import { readdirSync, readFileSync } from 'fs';
import yaml from 'js-yaml';
import path from 'path';

interface YamlFront { id?: string; title?: string; }

export async function GET() {
  const GUIDES_DIR = process.env.AEM_GUIDES_DIR || path.join(process.cwd(), 'guides');
  const inlineTest: Record<string, unknown> = {};
  try {
    const files = readdirSync(GUIDES_DIR);
    inlineTest.files = files;
    if (files.length > 0) {
      const fp = path.join(GUIDES_DIR, files[0]);
      const raw = readFileSync(fp, 'utf8');
      inlineTest.fileLength = raw.length;
      inlineTest.first10 = raw.slice(0, 10);
      const closing = raw.indexOf('\n---\n', 3);
      inlineTest.closingIdx = closing;
      if (closing > 0) {
        const yamlText = raw.slice(3, closing);
        try {
          const front = yaml.load(yamlText) as YamlFront;
          inlineTest.front_id = front?.id;
          inlineTest.front_title = front?.title;
        } catch (e) {
          inlineTest.yamlErr = String(e);
        }
      }
    }
  } catch (e) {
    inlineTest.error = String(e);
  }
  const guides = listGuides();
  return NextResponse.json({ inlineTest, libGuidesCount: guides.length });
}
