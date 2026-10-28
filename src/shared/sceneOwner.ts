import type {
  CaptureTaskOwner,
  CaptureTaskOwnerDatabase,
} from './captureTaskOwner';
import { assertCaptureTaskOwner } from './captureTaskOwner';
import {
  findBuiltInScene,
  SCENE_ID_PATTERN,
  validateSceneSpec,
  type SceneSpec,
} from './scenes';

type StoredScene = {
  id: string;
  name: string;
  instruction: string;
  sections_json: string;
};

/**
 * Resolve a built-in or persisted custom Scene for an already trusted task
 * owner. Cloud identity comes from signed Cloud Account sub, never a device id.
 *
 * This is an internal selector only: SHY-013 admits Cloud Scene HTTP routes;
 * SHY-014/015 will wire account-owned tasks into the organize/adjust path.
 */
export async function resolveOwnedScene(
  db: CaptureTaskOwnerDatabase,
  owner: CaptureTaskOwner,
  sceneId: string,
): Promise<SceneSpec | null> {
  assertCaptureTaskOwner(owner);
  const builtIn = findBuiltInScene(sceneId);
  if (builtIn) return builtIn;
  if (!SCENE_ID_PATTERN.test(sceneId)) return null;

  const cloud = owner.kind === 'cloud-account';
  const query = cloud
    ? 'SELECT id, name, instruction, sections_json FROM cloud_scenes WHERE cloud_account_id = ? AND id = ? LIMIT 1'
    : 'SELECT id, name, instruction, sections_json FROM scenes WHERE device_id = ? AND id = ? LIMIT 1';
  const ownerId = cloud ? owner.cloudAccountId : owner.legacyDeviceId;
  const row = await db.prepare(query).bind(ownerId, sceneId).first<StoredScene>();
  if (!row) return null;

  let sections: unknown;
  try {
    sections = JSON.parse(row.sections_json);
  } catch {
    return null;
  }
  const validated = validateSceneSpec({
    id: row.id,
    name: row.name,
    instruction: row.instruction,
    sections,
  });
  return validated.ok ? validated.value : null;
}
