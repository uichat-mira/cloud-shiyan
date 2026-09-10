import type { SceneSpec } from './scenes';

const SYSTEM_BASE = [
  'You are the Shiyan organization service.',
  'You organize a raw speech transcript into a structured result for the user.',
  'You must answer with a single JSON object and nothing else: no markdown fences, no commentary, no extra keys.',
  'The JSON object shape is: {"summary": string, "sections": [{"id": string, "items": string[]}]}.',
  'sections must contain every section id listed in the request, each exactly once.',
  'summary is 1-5 sentences. Every item is one short, concrete, self-contained statement.',
  'Use the same language as the transcript. Never invent facts that the transcript does not support.',
  'If a section has no relevant content, return an empty items array for it instead of inventing content.',
].join(' ');

const sectionLines = (scene: SceneSpec): string =>
  scene.sections
    .map(
      (section) =>
        `- id: ${section.id} | title: ${section.title} | what belongs here: ${section.description}`,
    )
    .join('\n');

export interface PromptMessages {
  system: string;
  user: string;
}

export const buildOrganizeMessages = (
  scene: SceneSpec,
  title: string,
  transcriptText: string,
  language?: string,
): PromptMessages => ({
  system: [
    SYSTEM_BASE,
    language ? `The transcript language is ${language}.` : '',
  ]
    .filter(Boolean)
    .join(' '),
  user: [
    `场景名称 / Scene name: ${scene.name}`,
    `整理要求 / Organize instruction: ${scene.instruction}`,
    `输出结构 / Output sections (use exactly these ids):`,
    sectionLines(scene),
    `标题 / Capture title: ${title}`,
    '',
    '转写原文 / Transcript:',
    transcriptText,
  ].join('\n'),
});

export const buildAdjustMessages = (
  scene: SceneSpec,
  title: string,
  transcriptText: string,
  currentStructuredJson: string,
  instruction: string,
  language?: string,
): PromptMessages => ({
  system: [
    SYSTEM_BASE,
    'This request is an adjustment: you receive the current structured draft, the user adjustment instruction, and the original transcript.',
    'Apply the instruction faithfully, keep every section id, and output the complete adjusted JSON object.',
    'Keep content grounded in the transcript; the instruction and transcript together define what may change.',
    language ? `The transcript language is ${language}.` : '',
  ]
    .filter(Boolean)
    .join(' '),
  user: [
    `场景名称 / Scene name: ${scene.name}`,
    `整理要求 / Organize instruction: ${scene.instruction}`,
    `输出结构 / Output sections (use exactly these ids):`,
    sectionLines(scene),
    `标题 / Capture title: ${title}`,
    '',
    `用户调整指令 / User adjustment instruction: ${instruction}`,
    '',
    '当前结构化草稿 / Current structured draft (JSON):',
    currentStructuredJson,
    '',
    '转写原文 / Transcript:',
    transcriptText,
  ].join('\n'),
});
