import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
    CharacterProfile,
    VisualIdentity,
    VisualIdentityReference,
    VisualIdentityReferenceRole,
    VisualIdentityStrength,
    VisualIdentityPreset,
} from '../../types';
import {
    addVisualIdentityReference,
    normalizeVisualIdentity,
    removeVisualIdentityReference,
    validateVisualIdentity,
} from '../../utils/visualIdentity';
import { getBlobForRef } from '../../utils/blobRef';
import {
    exportVisualIdentityZip,
    importVisualIdentityZip,
} from '../../utils/visualIdentityZip';
import {
    createVisualIdentityPreset,
    deleteVisualIdentityPreset,
    getActiveVisualIdentityPreset,
    migrateLegacyVisualIdentityToPreset,
    renameVisualIdentityPreset,
    resolveActivePresetId,
} from '../../utils/visualIdentityPresets';
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
 * 角色视觉身份面板（Phase 2B/2D/2F）。
 *
 * - Phase 2F：顶部「视觉形态」库支持多预设（查看 / 设为当前 / 新建 / 重命名 / 删除 / ZIP 导入为形态 / 导出当前形态）
 * - 有 active 预设时，下方面板编辑的就是该预设的 identity；无预设时编辑 legacy visualIdentity（旧行为）
 * - 每套预设独立保存，参考图上限仍为每套 5 张；图片一律 blobRef 存 blob_assets，不写 base64 进 localStorage
 * - 删除预设只清理该预设独占的 Blob（被其他预设 / legacy 引用的 blobRef 保留）
 */
const VisualIdentityPanel: React.FC<{
    visualIdentity?: VisualIdentity;
    visualIdentityPresets?: VisualIdentityPreset[];
    activeVisualIdentityPresetId?: string;
    onChangePatch: (patch: Partial<Pick<CharacterProfile, 'visualIdentity' | 'visualIdentityPresets' | 'activeVisualIdentityPresetId'>>) => void;
    addToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}> = ({ visualIdentity, visualIdentityPresets, activeVisualIdentityPresetId, onChangePatch, addToast }) => {
    const presets = visualIdentityPresets ?? [];
    const activePreset = useMemo(
        () => getActiveVisualIdentityPreset({ visualIdentity, visualIdentityPresets, activeVisualIdentityPresetId }),
        [visualIdentity, visualIdentityPresets, activeVisualIdentityPresetId],
    );
    // 当前编辑对象：active 预设优先，否则 legacy visualIdentity（旧角色零迁移照常编辑）
    const vi = useMemo(() => normalizeVisualIdentity(activePreset?.identity ?? visualIdentity), [activePreset, visualIdentity]);
    const [uploading, setUploading] = useState(false);
    const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
    const [fixedTraitsDraft, setFixedTraitsDraft] = useState(() => joinTraitInput(vi.fixedTraits));
    const [variableTraitsDraft, setVariableTraitsDraft] = useState(() => joinTraitInput(vi.variableTraits));
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const zipInputRef = useRef<HTMLInputElement | null>(null);
    const [zipBusy, setZipBusy] = useState(false);
    // 形态卡内联重命名状态
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameDraft, setRenameDraft] = useState('');


    // ZIP 标准包导入会整体替换 fixedTraits/variableTraits，同步刷新本地草稿
    useEffect(() => {
        setFixedTraitsDraft(joinTraitInput(vi.fixedTraits));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vi.fixedTraits]);
    useEffect(() => {
        setVariableTraitsDraft(joinTraitInput(vi.variableTraits));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vi.variableTraits]);

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

    /** 写入当前编辑对象：active 预设存在 → 更新该预设的 identity；否则更新 legacy visualIdentity（旧行为）。 */
    const writeIdentity = (next: VisualIdentity) => {
        if (activePreset) {
            onChangePatch({
                visualIdentityPresets: presets.map(p => p.id === activePreset.id ? { ...p, identity: next, updatedAt: Date.now() } : p),
            });
        } else {
            onChangePatch({ visualIdentity: next });
        }
    };

    const patch = (partial: Partial<VisualIdentity>) => writeIdentity({ ...vi, ...partial });

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
            writeIdentity({ ...vi, references: nextRefs });
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
        writeIdentity({ ...vi, references: removeVisualIdentityReferenceFromList(vi.references, ref.id) });
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

    /**
     * 导入视觉身份包（Phase 2F 语义）：导入 = 新增一个形态预设并设为当前，不覆盖任何已有形态。
     * - 标准 ZIP：名称优先 manifest.presetName，否则用 ZIP 文件名（去扩展名），再兜底「导入形态」
     * - 普通 ZIP：提取图片供人工整理（同样作为新形态）
     * - 旧版 ZIP 没有形态字段也不报错；失败时 utils 层已自清理本次写入的 Blob
     */
    const handleImportZip = async (files: FileList | null) => {
        const file = files?.[0];
        if (!file) return;
        setZipBusy(true);
        try {
            const result = await importVisualIdentityZip(file);
            const fallbackName = (file.name || '').replace(/\.zip$/i, '').trim() || '导入形态';
            const presetName = result.presetName || fallbackName;
            const identity = result.hadManifest
                ? result.visualIdentity
                : { ...vi, enabled: true, mode: 'advanced' as const, references: result.visualIdentity.references };
            const preset = createVisualIdentityPreset(presetName, identity, result.presetDescription);
            onChangePatch({
                visualIdentityPresets: [...presets, preset],
                activeVisualIdentityPresetId: preset.id,
            });
            if (result.hadManifest) {
                addToast?.(`已导入形态「${preset.name}」：${identity.references.length} 张参考图 + 外观字段已恢复`, 'success');
            } else {
                addToast?.(`已从 ZIP 提取 ${identity.references.length} 张图片为新形态，请整理主图与角色标记`, 'info');
            }
            if (result.skippedFiles.length > 0) {
                addToast?.(`超出 5 张上限，${result.skippedFiles.length} 张未导入（${result.skippedFiles.slice(0, 3).join('、')}${result.skippedFiles.length > 3 ? '…' : ''}）`, 'info');
            }
        } catch (error) {
            addToast?.(error instanceof Error ? error.message : '视觉身份包导入失败', 'error');
        } finally {
            setZipBusy(false);
            if (zipInputRef.current) zipInputRef.current.value = '';
        }
    };

    /** 导出当前形态：manifest 写入 presetName / presetDescription；旧版 importer 仍能读取核心字段。 */
    const handleExportZip = async () => {
        if (vi.references.length === 0) {
            addToast?.('当前形态还没有参考图可导出', 'error');
            return;
        }
        setZipBusy(true);
        try {
            const blob = await exportVisualIdentityZip(vi, {
                presetName: activePreset?.name,
                presetDescription: activePreset?.description,
            });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'VisualIdentity.zip';
            link.click();
            URL.revokeObjectURL(url);
            addToast?.(`已导出形态「${activePreset?.name ?? '基础视觉身份'}」`, 'success');
        } catch (error) {
            addToast?.(error instanceof Error ? error.message : '视觉身份包导出失败', 'error');
        } finally {
            setZipBusy(false);
        }
    };

    // ─── Phase 2F 形态库操作 ─────────────────────────────────────────────
    const handleCreatePreset = () => {
        const preset = createVisualIdentityPreset(`形态 ${presets.length + 1}`);
        onChangePatch({ visualIdentityPresets: [...presets, preset], activeVisualIdentityPresetId: preset.id });
        addToast?.(`已新建空白形态「${preset.name}」，请上传参考图`, 'info');
    };

    const handleMigrateLegacy = () => {
        const migrated = migrateLegacyVisualIdentityToPreset({ visualIdentity, visualIdentityPresets, activeVisualIdentityPresetId });
        if (!migrated) {
            addToast?.('基础视觉身份没有可迁移的参考图', 'info');
            return;
        }
        onChangePatch(migrated);
        addToast?.('已将基础视觉身份转为「默认形态」（图片复用原文件，不占额外空间）', 'success');
    };

    const handleSwitchPreset = (presetId: string) => {
        if (presetId === activePreset?.id) return;
        onChangePatch({ activeVisualIdentityPresetId: presetId });
    };

    const handleRenamePreset = (presetId: string) => {
        const preset = presets.find(p => p.id === presetId);
        if (!preset) return;
        const next = renameVisualIdentityPreset(preset, renameDraft);
        if (next.name !== preset.name) {
            onChangePatch({ visualIdentityPresets: presets.map(p => p.id === presetId ? next : p) });
        }
        setRenamingId(null);
        setRenameDraft('');
    };

    const handleDeletePreset = async (presetId: string) => {
        const preset = presets.find(p => p.id === presetId);
        if (!preset) return;
        setZipBusy(true);
        try {
            const { presets: remaining, nextActiveId } = await deleteVisualIdentityPreset(presetId, presets, visualIdentity);
            onChangePatch({
                visualIdentityPresets: remaining,
                activeVisualIdentityPresetId: resolveActivePresetId(remaining, nextActiveId),
            });
            addToast?.(`已删除形态「${preset.name}」${remaining.length === 0 ? '，已回退基础视觉身份' : ''}`, 'info');
        } catch {
            addToast?.('删除形态失败，请重试', 'error');
        } finally {
            setZipBusy(false);
        }
    };

    const validationErrors = vi.enabled ? validateVisualIdentity(vi) : [];
    const roleLabelOf = (role: VisualIdentityReferenceRole) =>
        VISUAL_IDENTITY_ROLE_OPTIONS.find(option => option.value === role)?.label ?? role;

    return (
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100 space-y-4">
            {/* Phase 2F：视觉形态库（多预设，玩家手动切换） */}
            <div className="rounded-2xl border border-indigo-100 bg-indigo-50/40 p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                        <label className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest block">视觉形态 (Forms)</label>
                        <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
                            当前形态：{activePreset ? activePreset.name : '基础视觉身份'} · 生图只使用当前形态的参考图
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={handleCreatePreset}
                        className="shrink-0 rounded-xl bg-indigo-500 px-3 py-2 text-[11px] font-bold text-white shadow-sm transition active:scale-95"
                    >
                        + 新建形态
                    </button>
                </div>
                {presets.length > 0 ? (
                    <div className="space-y-2">
                        {presets.map(preset => {
                            const isActive = preset.id === activePreset?.id;
                            return (
                                <div key={preset.id} className={`rounded-xl border p-2.5 transition ${isActive ? 'border-indigo-300 bg-white' : 'border-slate-200 bg-white/70'}`}>
                                    <div className="flex items-center gap-2">
                                        {renamingId === preset.id ? (
                                            <input
                                                autoFocus
                                                value={renameDraft}
                                                onChange={event => setRenameDraft(event.target.value)}
                                                onKeyDown={event => { if (event.key === 'Enter') handleRenamePreset(preset.id); if (event.key === 'Escape') { setRenamingId(null); setRenameDraft(''); } }}
                                                onBlur={() => handleRenamePreset(preset.id)}
                                                className="min-w-0 flex-1 rounded-lg border border-indigo-200 px-2 py-1 text-xs outline-none"
                                            />
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => { setRenamingId(preset.id); setRenameDraft(preset.name); }}
                                                title="重命名形态"
                                                className="min-w-0 flex-1 text-left"
                                            >
                                                <span className="block truncate text-xs font-bold text-slate-700">
                                                    {isActive && <span className="mr-1 text-indigo-500">●</span>}
                                                    {preset.name}
                                                </span>
                                                <span className="block truncate text-[10px] text-slate-400">
                                                    {preset.identity.references.length} 张参考图{preset.description ? ` · ${preset.description}` : ''}
                                                </span>
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            disabled={isActive}
                                            onClick={() => handleSwitchPreset(preset.id)}
                                            className={`shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-bold transition active:scale-95 ${isActive ? 'bg-indigo-100 text-indigo-500' : 'bg-indigo-500 text-white'}`}
                                        >
                                            {isActive ? '当前形态' : '设为当前'}
                                        </button>
                                        <button
                                            type="button"
                                            aria-label="删除形态"
                                            onClick={() => { void handleDeletePreset(preset.id); }}
                                            className="shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-rose-50 text-xs font-bold text-rose-500 transition active:scale-90"
                                        >
                                            ×
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <p className="text-[10px] leading-relaxed text-slate-400">
                        还没有形态预设；可新建空白形态，或从 ZIP 导入形态包。
                    </p>
                )}
                {(visualIdentity?.references?.length ?? 0) > 0 && !presets.some(p => p.name === '默认形态') && (
                    <button
                        type="button"
                        onClick={handleMigrateLegacy}
                        className="w-full rounded-xl border border-indigo-200 bg-white/80 py-2 text-[10px] font-bold text-indigo-600 transition active:scale-95"
                    >
                        ⤴ 将基础视觉身份转为「默认形态」（复用现有图片）
                    </button>
                )}
            </div>

            {/* 标题 + 启用开关 */}
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <label className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest block">视觉身份 (Visual Identity)</label>
                    <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                        {activePreset ? `正在编辑形态「${activePreset.name}」。` : ''}
                        启用后，角色生图会自动使用当前视觉形态的参考图与外观设定。
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
                    onClick={() => writeIdentity(setVisualIdentityMode(vi, 'simple'))}
                    className={`rounded-xl border px-3 py-2 text-xs font-bold transition ${vi.mode === 'simple' ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white/70 text-slate-500'}`}
                >
                    简易模式
                    <span className="mt-0.5 block text-[9px] font-normal opacity-70">选图 + 主图即可</span>
                </button>
                <button
                    type="button"
                    onClick={() => writeIdentity(setVisualIdentityMode(vi, 'advanced'))}
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

                    {/* 视觉身份包（Phase 2D）：标准 ZIP 一键导入 / 导出 */}
                    <div className="border-t border-slate-100 pt-3">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">视觉身份包 (ZIP)</label>
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                disabled={zipBusy}
                                onClick={() => zipInputRef.current?.click()}
                                className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2.5 text-xs font-bold text-violet-700 transition active:scale-95 disabled:opacity-40"
                            >
                                {zipBusy ? '处理中…' : '📥 导入视觉身份包'}
                            </button>
                            <button
                                type="button"
                                disabled={zipBusy || vi.references.length === 0}
                                onClick={() => { void handleExportZip(); }}
                                className="rounded-xl border border-slate-200 bg-white/70 px-3 py-2.5 text-xs font-bold text-slate-600 transition active:scale-95 disabled:opacity-40"
                            >
                                📦 导出视觉身份包
                            </button>
                        </div>
                        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
                            导入 = 新增一个视觉形态并设为当前（不覆盖已有形态）；导出 = 打包当前形态。每套形态最多 5 张参考图，只作用于当前角色。
                        </p>
                        <input
                            ref={zipInputRef}
                            type="file"
                            accept=".zip,application/zip"
                            className="hidden"
                            onChange={event => { void handleImportZip(event.target.files); }}
                        />
                    </div>
                </div>
            )}
        </div>
    );
};

export default VisualIdentityPanel;
