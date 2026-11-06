// Archive persistence owns paths, serialization and manifest updates.
// It consumes extracted content and media buffers; it never fetches or parses HTML.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function persist(post, payload, outputDir, format) {
  const base = path.resolve(outputDir);
  const domain = new URL(post.url).hostname.replace(/[^a-z0-9.-]/gi, '-');
  // Feed metadata is untrusted: never interpolate raw dates into a path.
  const date = typeof post.date === 'string' && post.date.trim() ? new Date(post.date) : null;
  const datePart = date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : 'undated';
  const slug = slugify(post.title || 'untitled');
  const dir = path.join(base, domain, `${datePart}-${slug}`);
  await fs.mkdir(path.join(dir, 'media'), { recursive: true });

  for (const file of payload.mediaFiles || []) {
    const filePath = path.join(dir, 'media', file.fileName);
    await fs.writeFile(filePath, file.buffer);
  }

  const metadata = {
    ...payload.metadata,
    saved_at: new Date().toISOString(),
    output_dir: dir
  };
  const frontmatter = renderFrontmatter(metadata);
  const content = `${frontmatter}\n\n${payload.markdown}\n`;
  // Save as index.md (Mike Dion would be proud)
  await fs.writeFile(path.join(dir, 'index.md'), content, 'utf8');
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  await fs.writeFile(path.join(dir, 'original.html'), payload.html || '', 'utf8');

  // Simple manifest per domain
  const manifestPath = path.join(base, domain, 'index.json');
  await appendManifest(manifestPath, {
    url: post.url,
    path: dir,
    title: metadata.title,
    date: metadata.date,
    saved_at: metadata.saved_at,
    format
  });

  return dir;
}

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function renderFrontmatter(meta) {
  const lines = ['---'];
  lines.push(`title: ${yamlEscape(meta.title || '')}`);
  if (meta.url) lines.push(`source_url: ${yamlEscape(meta.url)}`);
  if (meta.date) lines.push(`published: ${yamlEscape(meta.date)}`);
  if (meta.author) lines.push(`author: ${yamlEscape(meta.author)}`);
  lines.push(`tags:${(meta.tags || []).map((t) => `\n  - ${yamlEscape(t)}`).join('') || ' []'}`);
  lines.push('---');
  return lines.join('\n');
}

function yamlEscape(value) {
  // JSON double-quoted strings are also YAML scalars and preserve control characters.
  return JSON.stringify(String(value ?? ''));
}

async function appendManifest(manifestPath, entry) {
  let current = { items: [] };
  try {
    const buf = await fs.readFile(manifestPath, 'utf8');
    current = JSON.parse(buf);
    if (!Array.isArray(current.items)) current.items = [];
  } catch {
    // ignore, new manifest
  }
  current.items.push(entry);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(current, null, 2));
}
