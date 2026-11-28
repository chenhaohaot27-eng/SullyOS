import type { ImageGenerationConfig, VisualIdentityReference } from '../types';
import { blobToDataUrl, resolveRefToDataUrl } from './blobRef';
import { getActiveVisualIdentity, type VisualIdentityHost } from './visualIdentityPresets';
import { buildVisualIdentityPrompt } from './visualIdentityPrompt';

type Subject = VisualIdentityHost & { name: string };

export interface CameraReference {
  label: string;
  data: string;
}

export function planCameraReferences(character: Subject | undefined, player?: Subject) {
  const subjects = [
    { owner: '角色', profile: character },
    { owner: '玩家', profile: player },
  ].flatMap(({ owner, profile }) => {
    if (!profile) return [];
    const identity = getActiveVisualIdentity(profile);
    if (!identity?.enabled || !identity.references?.length) return [];
    const primary = identity.references.find(ref => ref.isPrimary) ?? identity.references[0];
    const seen = new Set<string>();
    const refs = [primary, ...identity.references].filter(ref => {
      if (seen.has(ref.blobRef)) return false;
      seen.add(ref.blobRef);
      return true;
    });
    return [{ label: owner + '「' + profile.name + '」', identity, refs }];
  });

  // Round-robin from each owner's primary. A late primary in either library always has a slot.
  const slots: Array<{ subject: typeof subjects[number]; ref: VisualIdentityReference; primary: boolean }> = [];
  for (let index = 0; index < 5 && slots.length < 5; index++) {
    for (const subject of subjects) {
      if (subject.refs[index] && slots.length < 5) {
        slots.push({ subject, ref: subject.refs[index], primary: index === 0 });
      }
    }
  }
  const references = slots.map(({ subject, ref, primary }, i) => ({
    label: `图 ${i + 1} · ${subject.label} · ${primary ? '主图' : '辅图'}`,
    data: ref.blobRef,
  }));
  const instructions = subjects.map(subject => {
    const numbers = slots.flatMap((slot, i) => slot.subject === subject ? [i + 1] : []);
    return `${subject.label}：仅图 ${numbers.join('、')} 属于此人（首张为主图）。${buildVisualIdentityPrompt(subject.identity, subject.label)}`;
  });
  if (instructions.length) instructions.unshift('身份绑定只适用于原文与镜头中实际出现的人。保留原文的单人、局部、群像或空镜构图。各人的脸、体型、发色和固定特征独立，禁止复制、混合或交换，也不要套用到其他人物。');
  return { references, instructions: instructions.join('\n') };
}

export function cameraReferenceIssue(count: number, config: ImageGenerationConfig) {
  const officialOpenAI = config.provider === 'gpt-images' && /^https:\/\/api\.openai\.com(?:\/|$)/i.test(config.baseUrl);
  if (count && (config.allowReferenceImages === false || config.provider === 'openai-images' ||
      (officialOpenAI && /^dall-e-3$/i.test(config.model)))) {
    return '当前生图预设不支持或未开启参考图，请更换支持参考图的预设。';
  }
  if (count > 1 && (config.singleReferenceOnly || (officialOpenAI && /^dall-e-2$/i.test(config.model)))) {
    return '当前预设仅支持单张参考图。本次需要多张，请更换支持多参考图的预设。';
  }
}

export async function prepareCameraReferences(character: Subject | undefined, player: Subject | undefined, config: ImageGenerationConfig) {
  const plan = planCameraReferences(character, player);
  const issue = cameraReferenceIssue(plan.references.length, config);
  if (issue) throw new Error(issue);
  const references = await Promise.all(plan.references.map(async ref => {
    let data = await resolveRefToDataUrl(ref.data);
    if (/^https?:\/\//i.test(data)) {
      const response = await fetch(data);
      if (!response.ok) throw new Error(ref.label + ' 无法读取');
      data = await blobToDataUrl(await response.blob());
    }
    if (!data?.startsWith('data:image/')) throw new Error(ref.label + ' 无法读取，请恢复备份或重新上传。');
    return { ...ref, data };
  }));
  return { ...plan, references };
}
