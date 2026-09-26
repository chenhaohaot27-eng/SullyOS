/**
 * 视觉身份标准包（Phase 2D）：ZIP 导入 / 导出。
 *
 * 包结构：
 *   VisualIdentity.zip
 *   ├─ manifest.json   （version / appearanceSummary / fixedTraits / variableTraits /
 *   │                    identityStrength / references[{file, role, isPrimary}]）
 *   └─ images/
 *      ├─ primary_face.png
 *      └─ ...
 *
 * 规则：
 * - 图片一律走现有 blobRef 管线写入 blob_assets（putImageBlob），不写 base64 进 localStorage
 * - 导入只作用于调用方指定的当前 characterId（本模块本身不绑角色，由 UI 层写入）
 * - 长期参考图上限仍为 MAX_VISUAL_IDENTITY_REFERENCES（5 张），超出部分进入 skippedFiles
 * - 导入失败（缺文件 / manifest 损坏）会清理本次已写入的全部 Blob，不残留孤儿
 * - 无 manifest 的普通 ZIP：提取图片 → role=other、首图主图，交给 UI 人工整理流程
 * - 导出只含 visualIdentity 数据与参考图，不含聊天/记忆/API Key/其他角色数据
 */

import JSZip from 'jszip';
import type {
    VisualIdentity,
    VisualIdentityReference,
    VisualIdentityReferenceRole,
    VisualIdentityStrength,
} from '../types';
import { deleteBlobRef, putImageBlob } from './blobRef';
import { resolveVisualIdentityReferences } from './visualIdentity';
import { MAX_VISUAL_IDENTITY_REFERENCES } from './visualIdentityUi';

export const VISUAL_IDENTITY_MANIFEST_NAME = 'manifest.json';
export const VISUAL_IDENTITY_IMAGES_DIR = 'images';
export const VISUAL_IDENTITY_PACKAGE_VERSION = 1;

/** manifest.json 结构。 */
export interface VisualIdentityManifest {
    version: number;
    appearanceSummary?: string;
    fixedTraits?: string[];
    variableTraits?: string[];
    identityStrength?: VisualIdentityStrength;
    references: Array<{
        /** 相对包根的图片路径，如 images/primary_face.png */
        file: string;
        role: VisualIdentityReferenceRole;
        isPrimary?: boolean;
    }>;
}

/** 导入结果：visualIdentity 已构建完成（含新 blobRef），由 UI 写入当前角色。 */
export interface VisualIdentityZipImport {
    visualIdentity: VisualIdentity;
    /** 是否为带 manifest 的标准包（false = 普通 ZIP，进入人工整理流程） */
    hadManifest: boolean;
    /** 因超过 5 张上限等原因被忽略的文件名（提示用户选择） */
    skippedFiles: string[];
}

const EXT_MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
};

const ROLE_TO_FILENAME: Record<VisualIdentityReferenceRole, string> = {
    'primary-face': 'primary_face',
    front: 'front',
    'three-quarter': 'three_quarter',
    profile: 'profile',
    'full-body': 'full_body',
    body: 'body',
    other: 'other',
};

const VALID_ROLES: readonly VisualIdentityReferenceRole[] = [
    'primary-face', 'front', 'three-quarter', 'profile', 'full-body', 'body', 'other',
];

function extOf(name: string): string {
    const m = /\.([a-z0-9]+)$/i.exec(name.trim());
    return m ? m[1].toLowerCase() : '';
}

function mimeFor(name: string): string | undefined {
    return EXT_MIME[extOf(name)];
}

function isImagePath(path: string): boolean {
    return !!mimeFor(path);
}

/**
 * 导出视觉身份标准包：manifest + images/（图片从 blobRef 解析出原始 Blob）。
 * 解析失败的参考图会被跳过（包内仍保持自洽，可再次导入）。
 */
export async function exportVisualIdentityZip(vi: VisualIdentity): Promise<Blob> {
    const resolved = await resolveVisualIdentityReferences(vi.references);
    if (resolved.length === 0) {
        throw new Error('没有可导出的参考图（图片可能已丢失），请先重新上传');
    }

    const zip = new JSZip();
    const imagesDir = zip.folder(VISUAL_IDENTITY_IMAGES_DIR)!;
    const usedNames = new Set<string>();
    const manifest: VisualIdentityManifest = {
        version: VISUAL_IDENTITY_PACKAGE_VERSION,
        appearanceSummary: vi.appearanceSummary?.trim() || undefined,
        fixedTraits: vi.fixedTraits?.length ? vi.fixedTraits : undefined,
        variableTraits: vi.variableTraits?.length ? vi.variableTraits : undefined,
        identityStrength: vi.identityStrength,
        references: [],
    };

    for (const { reference, blob } of resolved) {
        const ext = Object.keys(EXT_MIME).find(key => EXT_MIME[key] === blob.type) || 'png';
        const base = ROLE_TO_FILENAME[reference.role] ?? 'other';
        let name = `${base}.${ext}`;
        for (let i = 2; usedNames.has(name); i++) name = `${base}_${i}.${ext}`;
        usedNames.add(name);

        // JSZip 在 Node 环境不能直接消费 Blob，统一转 Uint8Array（浏览器同样兼容）
        imagesDir.file(name, new Uint8Array(await blob.arrayBuffer()));
        manifest.references.push({
            file: `${VISUAL_IDENTITY_IMAGES_DIR}/${name}`,
            role: reference.role,
            isPrimary: reference.isPrimary ? true : undefined,
        });
    }

    zip.file(VISUAL_IDENTITY_MANIFEST_NAME, JSON.stringify(manifest, null, 2));
    return zip.generateAsync({ type: 'blob' });
}

/** 失败时清理本次已创建的全部 Blob，避免半残数据。 */
async function cleanupBlobRefs(refs: string[]): Promise<void> {
    await Promise.allSettled(refs.map(ref => deleteBlobRef(ref)));
}

function normalizeRole(role: unknown): VisualIdentityReferenceRole {
    return VALID_ROLES.includes(role as VisualIdentityReferenceRole)
        ? (role as VisualIdentityReferenceRole)
        : 'other';
}

function genRefId(): string {
    return `viref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 导入视觉身份 ZIP。
 * - 标准 ZIP（含 manifest.json）：恢复主图 / role / 文字字段
 * - 普通 ZIP（无 manifest）：提取图片（≤5 张，多余记入 skippedFiles），role=other、首图主图，
 *   由 UI 进入人工整理流程
 * - 任一步失败：抛错（message 可直接 toast），并清理已写入的 Blob
 */
export async function importVisualIdentityZip(file: Blob): Promise<VisualIdentityZipImport> {
    let zip: JSZip;
    try {
        // 先统一转 Uint8Array：JSZip 在 Node 环境不能直接解析 Blob（浏览器同样兼容）
        const bytes = new Uint8Array(await file.arrayBuffer());
        zip = await JSZip.loadAsync(bytes);
    } catch {
        throw new Error('无法读取该 ZIP 文件，请确认是有效的视觉身份包');
    }

    const manifestEntry = zip.file(VISUAL_IDENTITY_MANIFEST_NAME)
        ?? zip.file(new RegExp(`^([^/]+/)?${VISUAL_IDENTITY_MANIFEST_NAME}$`))[0];

    if (manifestEntry) {
        return importStandardZip(zip, manifestEntry);
    }
    return importPlainZip(zip);
}

async function importStandardZip(zip: JSZip, manifestEntry: JSZip.JSZipObject): Promise<VisualIdentityZipImport> {
    let manifest: VisualIdentityManifest;
    try {
        manifest = JSON.parse(await manifestEntry.async('text'));
    } catch {
        throw new Error('manifest.json 解析失败，不是有效的视觉身份包');
    }
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.references)) {
        throw new Error('manifest.json 缺少 references 字段，不是有效的视觉身份包');
    }

    const entries = manifest.references.slice(0, MAX_VISUAL_IDENTITY_REFERENCES);
    const skippedFiles = manifest.references.length > entries.length
        ? manifest.references.slice(MAX_VISUAL_IDENTITY_REFERENCES).map(ref => String(ref.file))
        : [];

    const createdRefs: string[] = [];
    const references: VisualIdentityReference[] = [];
    try {
        for (const ref of entries) {
            const filePath = String(ref?.file || '').replace(/^\/+/, '');
            const entry = zip.file(filePath);
            if (!entry) throw new Error(`包内缺少图片：${filePath}`);
            const mime = mimeFor(filePath);
            if (!mime) throw new Error(`不支持的图片格式：${filePath}`);
            const data = await entry.async('arraybuffer');
            const blobRef = await putImageBlob(new Blob([data], { type: mime }));
            createdRefs.push(blobRef);
            references.push({
                id: genRefId(),
                role: normalizeRole(ref.role),
                blobRef,
                isPrimary: ref.isPrimary ? true : undefined,
                createdAt: Date.now(),
            });
        }
    } catch (error) {
        await cleanupBlobRefs(createdRefs);
        throw error instanceof Error ? error : new Error('视觉身份包导入失败');
    }

    // 标准包未标记主图时，默认提升第一张，保证简易/精细模式可用
    if (references.length > 0 && !references.some(r => r.isPrimary)) {
        references[0] = { ...references[0], isPrimary: true };
    }

    return {
        visualIdentity: {
            enabled: true,
            mode: 'advanced',
            appearanceSummary: typeof manifest.appearanceSummary === 'string' ? manifest.appearanceSummary : undefined,
            fixedTraits: Array.isArray(manifest.fixedTraits) ? manifest.fixedTraits.filter((t): t is string => typeof t === 'string') : undefined,
            variableTraits: Array.isArray(manifest.variableTraits) ? manifest.variableTraits.filter((t): t is string => typeof t === 'string') : undefined,
            identityStrength: manifest.identityStrength,
            references,
        },
        hadManifest: true,
        skippedFiles,
    };
}

async function importPlainZip(zip: JSZip): Promise<VisualIdentityZipImport> {
    const imageEntries = Object.values(zip.files)
        .filter(entry => !entry.dir && isImagePath(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));

    if (imageEntries.length === 0) {
        throw new Error('ZIP 内没有找到图片（支持 png / jpg / jpeg / webp / gif / bmp）');
    }

    const accepted = imageEntries.slice(0, MAX_VISUAL_IDENTITY_REFERENCES);
    const skippedFiles = imageEntries.slice(MAX_VISUAL_IDENTITY_REFERENCES).map(entry => entry.name);

    const createdRefs: string[] = [];
    const references: VisualIdentityReference[] = [];
    try {
        for (let i = 0; i < accepted.length; i++) {
            const entry = accepted[i];
            const data = await entry.async('arraybuffer');
            const blobRef = await putImageBlob(new Blob([data], { type: mimeFor(entry.name)! }));
            createdRefs.push(blobRef);
            references.push({
                id: genRefId(),
                role: 'other',
                blobRef,
                isPrimary: i === 0 ? true : undefined,
                createdAt: Date.now(),
            });
        }
    } catch (error) {
        await cleanupBlobRefs(createdRefs);
        throw error instanceof Error ? error : new Error('ZIP 图片导入失败');
    }

    return {
        // 普通 ZIP：进入人工整理流程（UI 提示选主图 / role / 删除多余），不覆盖文字字段
        visualIdentity: {
            enabled: true,
            mode: 'advanced',
            references,
        },
        hadManifest: false,
        skippedFiles,
    };
}

