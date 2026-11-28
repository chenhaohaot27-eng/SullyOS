import type { CharacterProfile, ImageGenerationConfig, UserProfile } from '../types';
import { DB } from './db';
import { prepareCameraReferences, type CameraReference } from './sceneCameraReferences';
import { getActiveVisualIdentity } from './visualIdentityPresets';
import { photoSubjects, type PhotoSubjects } from './photoSubjects';

export async function bindPhotoIdentity(
  subjects: PhotoSubjects | 'unspecified', prompt: string, char: CharacterProfile, player: UserProfile | null | undefined,
  config: ImageGenerationConfig,
) {
  const identity = player && getActiveVisualIdentity(player);
  const withPlayer = subjects === 'both' || subjects === 'player'
    || (subjects === 'unspecified' && !!(identity?.enabled && identity.references?.length));
  const withChar = subjects !== 'other' && subjects !== 'player';
  if (withPlayer && !(identity?.enabled && identity.references?.length)) {
    throw new Error('这张图需要玩家本人。请在「个人档案 → 我的档案 → 玩家视觉身份」启用参考图，再重试。');
  }
  // Older character records may have only an avatar. Keep its owner explicit, including in two-person requests.
  const charIdentity = getActiveVisualIdentity(char);
  let host = withChar ? char : undefined;
  if (host && !(charIdentity?.enabled && charIdentity.references?.length)) {
    if (/^(?:blobref:|data:image\/|https?:\/\/)/i.test(char.avatar || '')) {
      host = { ...char, activeVisualIdentityPresetId: undefined, visualIdentity: {
        enabled: true, mode: 'simple', references: [
          { id: 'avatar', role: 'primary-face', isPrimary: true, createdAt: 0, blobRef: char.avatar },
        ],
      } };
    } else if (subjects === 'both') {
      throw new Error('双人照片需要独立的角色参考图。请在角色档案设置视觉身份，再重试。');
    }
  }
  const binding = await prepareCameraReferences(host, withPlayer ? player ?? undefined : undefined, config);
  const composition = !binding.references.length ? '' : subjects === 'player' ? '玩家是唯一的身份主体，角色为拍摄者或叙述者，不要出镜。'
    : subjects === 'character' ? '画面中的角色使用角色身份，玩家不出镜。' : '';
  return { references: binding.references, options: {
    prompt: [prompt, composition, binding.instructions].filter(Boolean).join('\n\n'),
    referenceImages: binding.references.map(ref => ref.data),
    ...(binding.references.length ? { identityActive: true } : {}),
  } };
}

export async function bindMessagePhoto(
  char: CharacterProfile, intent: Parameters<typeof photoSubjects>[0] & { style?: string }, config: ImageGenerationConfig,
) {
  const player = await DB.getUserProfile();
  const subjects = photoSubjects(intent, player?.name, char.name);
  const binding = await bindPhotoIdentity(subjects, intent.prompt, char, player, config);
  return { ...binding, options: { ...binding.options, style: intent.style || undefined } };
}

/** Bound both dimensions, preserving aspect ratio for portraits and full-body references. */
async function resizeReference(data: string, edge: number, quality: number): Promise<string> {
  const img = new Image();
  img.src = data;
  await img.decode();
  const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('设备无法处理参考图');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/** Worker accepts a 900 KiB encrypted JSON envelope. Leave room for prompt, JSON and encryption/base64 overhead. */
export async function fitCloudPhotoReferences(references: CameraReference[]) {
  const budget = 620 * 1024;
  if (references.reduce((sum, ref) => sum + ref.data.length, 0) <= budget) return references;
  for (const edge of [1024, 768, 512, 384]) {
    const fitted: CameraReference[] = [];
    for (const ref of references) {
      const resized = await resizeReference(ref.data, edge, 0.8);
      fitted.push(resized.length < ref.data.length ? { data: resized, label: ref.label + '（云端压缩）' } : ref);
    }
    if (fitted.reduce((sum, ref) => sum + ref.data.length, 0) <= budget) return fitted;
  }
  throw new Error('保留全部身份参考图后仍超过云端大小限制，请缩小图片或关闭云端后台生图。');
}

/** Small historical previews survive edits to the library without duplicating full portraits in every message. */
export async function photoReferencePreviews(references: CameraReference[]): Promise<CameraReference[]> {
  const previews: CameraReference[] = [];
  for (const ref of references) {
    try {
      previews.push({ label: ref.label, data: await resizeReference(ref.data, 144, 0.78) });
    } catch {
      previews.push({ label: ref.label, data: '' });
    }
  }
  return previews;
}
