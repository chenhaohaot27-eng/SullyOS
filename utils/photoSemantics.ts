/**
 * 摄影语义与现实感修正层（Phase 2E）。
 *
 * 目标：减少「动作不符合摄影逻辑」（如第三人称拍到角色举手机自拍）与明显 AI 味
 * （塑料皮肤、过度锐化、商业海报感）。
 *
 * 规则：
 * - 只在 prompt 末尾补充约束，绝不覆盖 / 改写剧情原 prompt
 * - 自拍（selfie/自拍）→ 前置摄像头第一视角自拍约束
 * - 镜子自拍（mirror selfie/镜子自拍）→ 才允许手机入画 + 合理镜面构图
 * - 他拍/街拍/candid → 才允许第三人称镜头完整看到角色（和手机）
 * - 明确海报/商业摄影/插画 → 不强压「手机随手拍」现实感
 * - 视觉身份启用（或 prompt 带拍照语境）的角色生活照 → 轻量现实摄影约束（中英双语）
 * - 不依赖 visualIdentity：enabled=false 时仍可对普通角色照片生效
 */

export type PhotoSceneKind =
    | 'selfie'            // 前置摄像头第一视角自拍
    | 'mirror-selfie'     // 镜子自拍（手机可入画）
    | 'third-person'      // 他拍 / 街拍 / candid
    | 'commercial'        // 海报 / 商业摄影 / 插画（不强压现实感）
    | 'general';          // 普通角色照片

export interface PhotoSemanticsResult {
    kind: PhotoSceneKind;
    /** 是否命中拍照语境（决定普通照片是否加现实感约束） */
    photoContext: boolean;
    /** 需要追加的约束文本；空字符串 = 不注入 */
    constraint: string;
}

const RE_MIRROR_SELFIE = /镜子自拍|镜中自拍|mirror[\s-]?selfie/i;
const RE_SELFIE = /自拍|selfie/i;
const RE_THIRD_PERSON = /他拍|别人拍|他人拍摄|旁人拍摄|街拍|偷拍|candid|第三人称(拍摄|视角|镜头)/i;
const RE_COMMERCIAL = /海报|商业摄影|艺术照|杂志封面|写真集|海报风|poster|commercial\s*(photography|shoot)|magazine\s*cover|studio\s*(poster|portrait)|插画|illustration|anime[\s-]?(style|art)/i;
const RE_PHOTO_CONTEXT = /照片|拍照|拍摄|生活照|随手拍|镜头|相机|出片|photo|picture|snapshot|shot\b|camera/i;

const REALISM_PROMPT = [
    '默认按普通智能手机随手拍呈现（ordinary smartphone photography）：',
    'natural human anatomy（自然的身体比例与关节），',
    'realistic hands and arms（手部结构自然、手指数量正确），',
    'subtle, natural veins only（只保留若隐若现的自然血管），',
    'realistic skin texture with slight natural imperfections（真实皮肤质感与轻微自然瑕疵），',
    'natural ambient light（自然环境光，不打棚灯）；',
    '避免：no exaggerated vascularity（暴起的夸张血管）、no plastic CGI skin（塑料感/CG 皮肤）、',
    'no over-sharpening（过度锐化）、no over-retouching（过度磨皮修图）、',
    'no commercial studio-poster look unless explicitly requested（除非明确要求，不要商业棚拍海报感）。',
].join('');

const SELFIE_PROMPT = [
    '自拍摄影语义（front-camera first-person selfie POV）：',
    '本图为角色用前置摄像头自拍的第一人称视角；画面中通常不出现手机本体',
    '（the phone itself is usually NOT visible），',
    '可以出现轻微伸出的手臂或肩膀（a slightly outstretched arm or shoulder is natural）；',
    '禁止第三人称视角拍到角色举着手机自拍',
    '（do NOT depict the character from a third-person view holding up a phone）；',
    '禁止手机屏幕朝外等不合常理的构图（no phone screen facing outward）。',
].join('');

const MIRROR_SELFIE_PROMPT = [
    '镜子自拍语义（mirror selfie）：手机可以出现在画面中（手持手机对着镜子拍），',
    '使用合理的镜面构图（realistic mirror composition：镜中影像与真实姿态一致，反射符合透视）；',
    '仍按照镜自拍的视角理解，不要变成第三人称他拍。',
].join('');

const THIRD_PERSON_PROMPT = [
    '他拍语义（candid photo taken by someone else）：允许第三人称镜头完整看到角色',
    '（a third-person view showing the character fully is appropriate）；',
    '若剧情中角色正在使用手机，可自然呈现角色手持手机的画面。',
].join('');

/** 分析 prompt 的摄影场景类型与拍照语境。 */
export function analyzePhotoSemantics(prompt: string): Pick<PhotoSemanticsResult, 'kind' | 'photoContext'> {
    if (RE_MIRROR_SELFIE.test(prompt)) return { kind: 'mirror-selfie', photoContext: true };
    if (RE_SELFIE.test(prompt)) return { kind: 'selfie', photoContext: true };
    if (RE_THIRD_PERSON.test(prompt)) return { kind: 'third-person', photoContext: true };
    if (RE_COMMERCIAL.test(prompt)) return { kind: 'commercial', photoContext: RE_PHOTO_CONTEXT.test(prompt) };
    return { kind: 'general', photoContext: RE_PHOTO_CONTEXT.test(prompt) };
}

/**
 * 生成需要追加的摄影约束文本。
 * @param prompt          原始剧情 prompt
 * @param identityActive  角色视觉身份是否启用（启用的角色照片默认按生活照加现实感约束）
 */
export function buildPhotoSemanticsConstraint(prompt: string, identityActive: boolean): string {
    const { kind, photoContext } = analyzePhotoSemantics(prompt);
    const parts: string[] = [];

    if (kind === 'mirror-selfie') {
        parts.push(MIRROR_SELFIE_PROMPT);
    } else if (kind === 'selfie') {
        parts.push(SELFIE_PROMPT);
    } else if (kind === 'third-person') {
        parts.push(THIRD_PERSON_PROMPT);
    }

    // 现实感约束：明确商业/海报/插画请求不强压；其余自拍/他拍/生活照（或视觉身份启用）都加
    const isCommercial = kind === 'commercial';
    const wantRealism = !isCommercial && (kind !== 'general' || identityActive || photoContext);
    if (wantRealism) parts.push(REALISM_PROMPT);

    return parts.join('\n');
}

/**
 * 在 prompt 末尾追加摄影语义约束（无约束时原样返回同一字符串）。
 * 只补充，不覆盖；剧情原文完整保留在开头。
 */
export function applyPhotoSemantics(prompt: string, options?: { identityActive?: boolean }): string {
    const constraint = buildPhotoSemanticsConstraint(prompt, options?.identityActive ?? false);
    if (!constraint) return prompt;
    return `${prompt}\n\n[摄影约束] ${constraint}`;
}
