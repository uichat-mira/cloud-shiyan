import type { SceneSpec, StructuredOrganization } from './scenes';

/**
 * Single renderer from validated structured JSON to the Markdown AI Draft.
 * Destinations consume this markdown directly and must never re-call the LLM
 * to reinterpret content (MOB-020 hard constraint).
 */
export function renderOrganizedMarkdown(
  title: string,
  scene: SceneSpec,
  value: StructuredOrganization,
): string {
  const lines: string[] = [`# ${title}`, '', '## 摘要', '', value.summary, ''];

  for (const spec of scene.sections) {
    const section = value.sections.find((candidate) => candidate.id === spec.id);
    lines.push(`## ${spec.title}`, '');
    const items = section?.items ?? [];
    if (items.length === 0) {
      lines.push('（本节暂无内容）');
    } else {
      for (const item of items) lines.push(`- ${item}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
