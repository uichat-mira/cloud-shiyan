import type { SceneSpec, StructuredOrganization, StructuredSection } from './scenes';

export const SUMMARY_MAX_LENGTH = 4000;
export const ITEM_MAX_LENGTH = 500;
export const SECTION_MAX_ITEMS = 50;

export type StructuredValidation =
  | { ok: true; value: StructuredOrganization }
  | { ok: false; issues: string[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validateItems = (value: unknown, path: string, issues: string[]): string[] | null => {
  if (!Array.isArray(value)) {
    issues.push(`${path}: must be an array of strings`);
    return null;
  }
  if (value.length > SECTION_MAX_ITEMS) {
    issues.push(`${path}: at most ${SECTION_MAX_ITEMS} items are allowed`);
    return null;
  }
  const items: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      issues.push(`${path}[${index}]: must be a non-empty string`);
      return;
    }
    if (item.length > ITEM_MAX_LENGTH) {
      issues.push(`${path}[${index}]: must be at most ${ITEM_MAX_LENGTH} characters`);
      return;
    }
    items.push(item.trim());
  });
  return items;
};

/**
 * Server-side validation for provider structured output. Invalid JSON must
 * never be treated as a success: every rejection carries an explicit path so
 * the failure is diagnosable without dumping provider payloads.
 */
export function validateStructuredOrganization(
  scene: SceneSpec,
  value: unknown,
): StructuredValidation {
  const issues: string[] = [];

  if (!isPlainObject(value)) {
    return { ok: false, issues: ['root: must be a JSON object'] };
  }

  const summary = value.summary;
  if (typeof summary !== 'string' || !summary.trim()) {
    issues.push('summary: must be a non-empty string');
  } else if (summary.length > SUMMARY_MAX_LENGTH) {
    issues.push(`summary: must be at most ${SUMMARY_MAX_LENGTH} characters`);
  }

  if (!Array.isArray(value.sections)) {
    return {
      ok: false,
      issues: [...issues, 'sections: must be an array'],
    };
  }

  const allowedIds = scene.sections.map((section) => section.id);
  const byId = new Map<string, StructuredSection>();
  const seen = new Set<string>();

  value.sections.forEach((section, index) => {
    const path = `sections[${index}]`;
    if (!isPlainObject(section)) {
      issues.push(`${path}: must be an object`);
      return;
    }
    const id = section.id;
    if (typeof id !== 'string') {
      issues.push(`${path}.id: must be a string`);
      return;
    }
    if (!allowedIds.includes(id)) {
      issues.push(
        `${path}.id: unknown section "${id}" (allowed: ${allowedIds.join(', ')})`,
      );
      return;
    }
    if (seen.has(id)) {
      issues.push(`${path}.id: duplicate section "${id}"`);
      return;
    }
    seen.add(id);
    const items = validateItems(section.items, `${path}.items`, issues);
    if (items) byId.set(id, { id, items });
  });

  for (const allowedId of allowedIds) {
    if (!seen.has(allowedId)) {
      issues.push(`sections: missing required section "${allowedId}"`);
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  // Canonical order is the scene order, not the provider order, so the three
  // built-in scenes produce stable structures regardless of model behavior.
  const sections = allowedIds.map(
    (id) => byId.get(id) as StructuredSection,
  );

  return {
    ok: true,
    value: {
      summary: (summary as string).trim(),
      sections,
    },
  };
}

/**
 * Tolerant on extraction, strict on validation: some providers wrap JSON in
 * markdown fences even in JSON mode, but the payload itself must still parse.
 */
export const extractJsonText = (content: string): string => {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
};

export const parseStructuredContent = (
  content: string,
): { ok: true; value: unknown } | { ok: false; message: string } => {
  const text = extractJsonText(content);
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      message: 'structured output is not valid JSON',
    };
  }
};
