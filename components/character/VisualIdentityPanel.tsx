import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
    VisualIdentity,
    VisualIdentityReference,
    VisualIdentityReferenceRole,
    VisualIdentityStrength,
} from '../../types';
import {
    addVisualIdentityReference,
    normalizeVisualIdentity,
    removeVisualIdentityReference,
    validateVisualIdentity,
} from '../../utils/visualIdentity';
import { getBlobForRef } from '../../utils/blobRef';
import {
    clampVisualIdentityReferenceUpload,
    joinTraitInput,
    MAX_VISUAL_IDENTITY_REFERENCES,
    parseTraitInput,
    removeVisualIdentityReferenceFromList,
    setPrimaryVisualIdentityReference,
    setVisualIdentityMode,
    updateVisualIdentityReferenceRole,
    VISUAL_IDENTITY_ROLE_OPTIONS,
    VISUAL_IDENTITY_STRENGTH_OPTIONS,
} from '../../utils/visualIdentityUi';

/**
 * 角色视觉身份面板（Phase 2B UI）。
 *
 * - 数据只写当前角色的 CharacterProfile.visualIdentity（调用方传 onChange），
 *   高清参考图一律走 utils/visualIdentity.ts + blobRef 存 IndexedDB blob_assets，
 *   绝不把 base64 塞进 localStorage / Profile 字段。
 * - 简易模式（默认）：开关 + 多选上传（≤5 张）+ 缩略图 + 主图标记 + 删除即可用；
 *   精细模式额外提供每张图的 role、外观总结、固定/可变特质、身份强度。
 * - 旧角色无 visualIdentity 时 normalize 出默认禁用结构，界面照常工作。
 * - 本阶段不接实际生图请求，也不做 ZIP 导入导出。
 */
const VisualIdentityPanel: React.FC<{
    visualIdentity?: VisualIdentity;
    onChange: (next: VisualIdentity) => void;
    addToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}> = ({ visualIdentity, onChange, addToast }) => {
    const vi = useMemo(() => normalizeVisualIdentity(visualIdentity), [visualIdentity]);
    const [uploading, setUploading] = useState(false);
    const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
    const [fixedTraitsDraft, setFixedTraitsDraft] = useState(() => joinTraitInput(vi.fixedTraits));
    const [variableTraitsDraft, setVariableTraitsDraft] = useState(() => joinTraitInput(vi.variableTraits));
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    // 缩略图：blobref 令牌 → objectURL（卸载 / 列表变化时回收，避免移动端内存泄漏）
    const referencesKey = vi.references.map(ref => `${ref.id}:${ref.isPrimary ? 1 : 0}`).join('|');
    const references = vi.references;
    useEffect(() => {
        let cancelled = false;
        const created: string[] = [];
        (async () => {
            const next: Record<string, string> = {};
            for (const ref of references) {
                const blob = await getBlobForRef(ref.blobRef);
                if (blob && !cancelled) {
                    const url = URL.createObjectURL(blob);
                    created.push(url);
                    next[ref.id] = url;
                }
            }
            if (!cancelled) setThumbUrls(next);
        })();
        return () => {
            cancelled = true;
            created.forEach(url => URL.revokeObjectURL(url));
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [referencesKey]);

    const patch = (partial: Partial<VisualIdentity>) => onChange({ ...vi, ...partial });

    const handleFiles = async (files: FileList | null) => {
        if (!files || files.length === 0) return;
        const images = Array.from(files).filter(file => file.type.startsWith('image/'));
        if (images.length === 0) {
            addToast?.('请选择图片文件', 'error');
            return;
        }
        const { accepted, rejected } = clampVisualIdentityReferenceUpload(vi.references.length, images.length);
        if (accepted <= 0) {
            addToast?.(`参考图最多 ${MAX_VISUAL_IDENTITY_REFERENCES} 张，请先删除旧图`, 'error');
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }
        setUploading(true);
        try {
            const nextRefs = [...vi.references];
            for (let i = 0; i < accepted; i++) {
                // 第一张图自动成为主参考图，简易模式无需任何额外操作即可保存
                const makePrimary = nextRefs.length === 0;
                nextRefs.push(await addVisualIdentityReference(images[i], 'other', makePrimary));
            }
            onChange({ ...vi, references: nextRefs });
            if (rejected > 0) {
                addToast?.(`已添加 ${accepted} 张，超出上限的 ${rejected} 张已忽略`, 'info');
            } else {
                addToast?.(`已添加 ${accepted} 张参考图`, 'success');
            }
        } catch {
            addToast?.('图片保存失败，请重试', 'error');
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const handleRemove = async (ref: VisualIdentityReference) => {
        onChange({ ...vi, references: removeVisualIdentityReferenceFromList(vi.references, ref.id) });
        try {
            await removeVisualIdentityReference(ref, vi.references);
        } catch { /* 删除孤儿 Blob 失败不影响元数据 */ }
    };

    const handleSetPrimary = (referenceId: string) => {
        patch({ references: setPrimaryVisualIdentityReference(vi.references, referenceId) });
    };

    const handleRole = (referenceId: string, role: VisualIdentityReferenceRole) => {
        patch({ references: updateVisualIdentityReferenceRole(vi.references, referenceId, role) });
    };

    const validationErrors = vi.enabled ? validateVisualIdentity(vi) : [];
    const roleLabelOf = (role: VisualIdentityReferenceRole) =>
        VISUAL_IDENTITY_ROLE_OPTIONS.find(option => option.value === role)?.label ?? role;

    return (
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100 space-y-4">
            {/* 标题 + 启用开关 */}
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <label className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest block">视觉身份 (Visual Identity)</label>
                    <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                        固定角色的长相：上传参考图后，生图时保持形象一致（本阶段仅保存，不影响现有生图）。
                    </p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={vi.enabled}
                    aria-label="启用固定视觉身份"
                    onClick={() => patch({ enabled: !vi.enabled })}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${vi.enabled ? 'bg-primary' : 'bg-slate-200'}`}
                >
                    <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${vi.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
            </div>

            {/* 简易 / 精细模式切换 */}
            <div className="grid grid-cols-2 gap-2">
                <button
                    type="button"
                    onClick={() => onChange(setVisualIdentityMode(vi, 'simple'))}
                    className={`rounded-xl border px-3 py-2 text-xs font-bold transition ${vi.mode === 'simple' ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white/70 text-slate-500'}`}
                >
                    简易模式
                    <span className="mt-0.5 block text-[9px] font-normal opacity-70">选图 + 主图即可</span>
                </button>
                <button
                    type="button"
                    onClick={() => onChange(setVisualIdentityMode(vi, 'advanced'))}
                    className={`rounded-xl border px-3 py-2 text-xs font-bold transition ${vi.mode === 'advanced' ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white/70 text-slate-500'}`}
                >
                    精细模式
                    <span className="mt-0.5 block text-[9px] font-normal opacity-70">角色标记 + 特质描述</span>
                </button>
            </div>

            {/* 上传区（相册多选，移动端优先） */}
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-violet-100 bg-violet-50/50 p-3">
                <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-600">参考图 {vi.references.length}/{MAX_VISUAL_IDENTITY_REFERENCES}</p>
                    <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">从相册多选；原图存本机，不压缩、不上传。</p>
                </div>
                <button
                    type="button"
                    disabled={uploading || vi.references.length >= MAX_VISUAL_IDENTITY_REFERENCES}
                    onClick={() => fileInputRef.current?.click()}
                    className="shrink-0 rounded-xl bg-primary px-4 py-2.5 text-xs font-bold text-white shadow-sm transition active:scale-95 disabled:opacity-40"
                >
                    {uploading ? '保存中…' : '+ 添加图片'}
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={event => { void handleFiles(event.target.files); }}
                />
            </div>

            {/* 缩略图网格 */}
            {vi.references.length > 0 ? (
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2.5">
                    {vi.references.map(ref => (
                        <div key={ref.id} className="space-y-1.5">
                            <div className="relative aspect-square rounded-2xl overflow-hidden border border-slate-100 bg-slate-50">
                                {thumbUrls[ref.id]
                                    ? <img src={thumbUrls[ref.id]} alt={`参考图 ${roleLabelOf(ref.role)}`} className="h-full w-full object-cover" />
                                    : <div className="h-full w-full animate-pulse bg-slate-100" />}
                                <button
                                    type="button"
                                    onClick={() => handleSetPrimary(ref.id)}
                                    title={ref.isPrimary ? '当前主参考图' : '设为主参考图'}
                                    className={`absolute left-1 top-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold backdrop-blur transition ${ref.isPrimary ? 'bg-amber-400/90 text-white' : 'bg-black/35 text-white/80'}`}
                                >
                                    {ref.isPrimary ? '★ 主图' : '☆ 设主图'}
                                </button>
                                <button
                                    type="button"
                                    aria-label="删除参考图"
                                    onClick={() => { void handleRemove(ref); }}
                                    className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/40 text-[11px] font-bold text-white backdrop-blur transition active:scale-90"
                                >
                                    ×
                                </button>
                            </div>
                            {vi.mode === 'advanced' ? (
                                <select
                                    value={ref.role}
                                    onChange={event => handleRole(ref.id, event.target.value as VisualIdentityReferenceRole)}
                                    aria-label="参考图角色标记"
                                    className="w-full rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-[10px] text-slate-600 outline-none focus:border-violet-300"
                                >
                                    {VISUAL_IDENTITY_ROLE_OPTIONS.map(option => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                </select>
                            ) : (
                                <p className="truncate text-center text-[10px] text-slate-400">{roleLabelOf(ref.role)}</p>
                            )}
                        </div>
                    ))}
                </div>
            ) : (
                <p className="rounded-2xl border border-dashed border-slate-200 px-3 py-4 text-center text-[11px] text-slate-300">
                    还没有参考图；关闭开关也可以先保存其他设置。
                </p>
            )}

            {/* 校验提示 */}
            {validationErrors.length > 0 && (
                <div className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-600">
                    {validationErrors.map(error => <p key={error}>· {error}</p>)}
                </div>
            )}

            {/* 精细模式扩展字段 */}
            {vi.mode === 'advanced' && (
                <div className="space-y-4 border-t border-slate-100 pt-3">
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">外观总结 (Appearance Summary)</label>
                        <textarea
                            value={vi.appearanceSummary ?? ''}
                            onChange={event => patch({ appearanceSummary: event.target.value })}
                            className="w-full h-24 bg-white rounded-2xl p-3.5 text-sm shadow-sm resize-none focus:ring-1 focus:ring-primary/20"
                            placeholder="用一段话总结角色的固定长相：发型、瞳色、气质等（建议 100-300 字）"
                        />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">固定特征（每行一条）</label>
                            <textarea
                                value={fixedTraitsDraft}
                                onChange={event => setFixedTraitsDraft(event.target.value)}
                                onBlur={() => patch({ fixedTraits: parseTraitInput(fixedTraitsDraft) })}
                                className="w-full h-20 bg-white rounded-2xl p-3.5 text-sm shadow-sm resize-none focus:ring-1 focus:ring-primary/20"
                                placeholder={'银白色长发\n琥珀色瞳孔'}
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">可变特征（每行一条）</label>
                            <textarea
                                value={variableTraitsDraft}
                                onChange={event => setVariableTraitsDraft(event.target.value)}
                                onBlur={() => patch({ variableTraits: parseTraitInput(variableTraitsDraft) })}
                                className="w-full h-20 bg-white rounded-2xl p-3.5 text-sm shadow-sm resize-none focus:ring-1 focus:ring-primary/20"
                                placeholder={'服装随场景变化\n发型可束可散'}
                            />
                        </div>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">身份强度 (Identity Strength)</label>
                        <div className="grid grid-cols-3 gap-2">
                            {VISUAL_IDENTITY_STRENGTH_OPTIONS.map(option => (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => patch({ identityStrength: option.value })}
                                    className={`rounded-xl border px-2 py-2 text-left transition ${(vi.identityStrength ?? 'balanced') === option.value ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white/70 text-slate-500'}`}
                                >
                                    <span className="block text-xs font-bold">{option.label}</span>
                                    <span className="mt-0.5 block text-[9px] opacity-70">{option.hint}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default VisualIdentityPanel;
