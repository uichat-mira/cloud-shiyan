export interface SceneSectionSpec {
  id: string;
  title: string;
  description: string;
}

export interface SceneSpec {
  id: string;
  name: string;
  instruction: string;
  sections: SceneSectionSpec[];
}

export interface StructuredSection {
  id: string;
  items: string[];
}

export interface StructuredOrganization {
  summary: string;
  sections: StructuredSection[];
}

export const SCENE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const SECTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export const SCENE_NAME_MAX_LENGTH = 60;
export const SCENE_INSTRUCTION_MAX_LENGTH = 2000;
export const SECTION_TITLE_MAX_LENGTH = 60;
export const SECTION_DESCRIPTION_MAX_LENGTH = 300;
export const SCENE_MAX_SECTIONS = 8;

/**
 * Built-in scenes ship with the product: users get a stable organization
 * structure without touching any prompt. The meeting scene must cover
 * summary / decisions / todos / risks / open questions (PRD 4.1); the other
 * two scenes reuse the same pipeline with lighter structures.
 */
export const BUILT_IN_SCENES: SceneSpec[] = [
  {
    id: 'meeting',
    name: '会议采集',
    instruction:
      '整理这场会议：先给出一句话到几句话的摘要，再提炼关键决策、待办事项、风险或阻塞，以及尚未确认的问题。保留事实，不要发明会议里没有出现的信息。',
    sections: [
      {
        id: 'decisions',
        title: '关键决策',
        description: '会议中明确做出的决定与结论',
      },
      {
        id: 'todos',
        title: '待办事项',
        description: '需要后续执行的事项；如提到负责人或时间，一并保留',
      },
      {
        id: 'risks',
        title: '风险 / 阻塞',
        description: '当前或潜在的风险、阻塞点',
      },
      {
        id: 'open-questions',
        title: '待确认问题',
        description: '尚未达成一致、需要进一步确认的问题',
      },
    ],
  },
  {
    id: 'quick-note',
    name: '临时口述需求',
    instruction:
      '整理这段口述：提炼需求要点，区分明确的要求、产生的待办和模糊待确认的地方。保留事实，不要补写口述中没有提到的需求。',
    sections: [
      {
        id: 'requirements',
        title: '需求要点',
        description: '口述中提出的需求与要求',
      },
      {
        id: 'todos',
        title: '待办事项',
        description: '由需求直接产生的待办',
      },
      {
        id: 'open-questions',
        title: '待确认问题',
        description: '模糊、矛盾或需要补充信息的地方',
      },
    ],
  },
  {
    id: 'reflection',
    name: '个人复盘 / 想法记录',
    instruction:
      '整理这段复盘或想法记录：提炼核心观点与经验教训，归纳后续行动和还没想清楚的问题。保留事实，不要替用户下结论。',
    sections: [
      {
        id: 'insights',
        title: '关键想法',
        description: '核心观点、灵感与经验教训',
      },
      {
        id: 'actions',
        title: '后续行动',
        description: '打算采取的行动或改变',
      },
      {
        id: 'open-questions',
        title: '待确认问题',
        description: '还没想清楚、需要继续思考的问题',
      },
    ],
  },
];

export const findBuiltInScene = (sceneId: string): SceneSpec | null =>
  BUILT_IN_SCENES.find((scene) => scene.id === sceneId) ?? null;

export const isReservedSceneId = (sceneId: string): boolean =>
  BUILT_IN_SCENES.some((scene) => scene.id === sceneId);

export type SceneValidation =
  | { ok: true; value: SceneSpec }
  | { ok: false; issues: string[] };

const validateSectionSpec = (section: unknown, index: number): string[] => {
  const issues: string[] = [];
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    return [`sections[${index}]: must be an object`];
  }
  const record = section as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== 'string' || !SECTION_ID_PATTERN.test(id)) {
    issues.push(
      `sections[${index}].id: must match ${SECTION_ID_PATTERN.source}`,
    );
  }
  const title = record.title;
  if (typeof title !== 'string' || !title.trim() || title.length > SECTION_TITLE_MAX_LENGTH) {
    issues.push(
      `sections[${index}].title: must be a non-empty string of at most ${SECTION_TITLE_MAX_LENGTH} characters`,
    );
  }
  const description = record.description;
  if (
    typeof description !== 'string' ||
    description.length > SECTION_DESCRIPTION_MAX_LENGTH
  ) {
    issues.push(
      `sections[${index}].description: must be a string of at most ${SECTION_DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
  return issues;
};

/**
 * Custom scenes are limited to name + organize instruction + output structure.
 * This is the only user-controlled surface that reaches prompt composition;
 * complete system prompts stay server-side (PRD 4.2).
 */
export function validateSceneSpec(value: unknown): SceneValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['scene: must be an object'] };
  }
  const record = value as Record<string, unknown>;
  const issues: string[] = [];

  if (typeof record.id !== 'string' || !SCENE_ID_PATTERN.test(record.id)) {
    issues.push(`id: must match ${SCENE_ID_PATTERN.source}`);
  }
  if (
    typeof record.name !== 'string' ||
    !record.name.trim() ||
    record.name.length > SCENE_NAME_MAX_LENGTH
  ) {
    issues.push(`name: must be a non-empty string of at most ${SCENE_NAME_MAX_LENGTH} characters`);
  }
  if (
    typeof record.instruction !== 'string' ||
    !record.instruction.trim() ||
    record.instruction.length > SCENE_INSTRUCTION_MAX_LENGTH
  ) {
    issues.push(
      `instruction: must be a non-empty string of at most ${SCENE_INSTRUCTION_MAX_LENGTH} characters`,
    );
  }
  if (!Array.isArray(record.sections) || record.sections.length === 0) {
    return { ok: false, issues: [...issues, 'sections: must be a non-empty array'] };
  }
  if (record.sections.length > SCENE_MAX_SECTIONS) {
    issues.push(`sections: at most ${SCENE_MAX_SECTIONS} sections are allowed`);
  }

  const sectionIds = new Set<string>();
  record.sections.forEach((section, index) => {
    issues.push(...validateSectionSpec(section, index));
    if (
      typeof section === 'object' &&
      section !== null &&
      typeof (section as Record<string, unknown>).id === 'string'
    ) {
      const id = (section as Record<string, unknown>).id as string;
      if (sectionIds.has(id)) issues.push(`sections: duplicate section id "${id}"`);
      sectionIds.add(id);
    }
  });

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      id: record.id as string,
      name: (record.name as string).trim(),
      instruction: (record.instruction as string).trim(),
      sections: (record.sections as SceneSectionSpec[]).map((section) => ({
        id: section.id,
        title: section.title.trim(),
        description: section.description.trim(),
      })),
    },
  };
}
