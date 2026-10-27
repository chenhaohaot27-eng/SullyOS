import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ImageGenerationAspectRatio, ImageGenerationAuthMode, ImageGenerationConfig, ImageGenerationPresetStore, ImageGenerationProvider, ImageGenerationResolution } from '../../types';
import {
    clearImageGenerationConfig,
    loadImageGenerationConfig,
    normalizeImageGenerationConfig,
    saveImageGenerationConfig,
} from '../../utils/imageGenerationConfig';
import {
    activateImageGenerationPreset,
    clearImageGenerationPresetStore,
    createImageGenerationPreset,
    deleteImageGenerationPreset,
    isPrivateNetworkBaseUrl,
    loadImageGenerationPresetStore,
    updateImageGenerationPreset,
} from '../../utils/imageGenerationPresets';
import {
    generatedImageToBlob,
    filterAvailableImageModels,
    imageGenerationService,
    ImageGenerationError,
    listAvailableModels,
    resolveImageModelSelection,
    type AvailableImageModel,
} from '../../utils/imageGenerationService';
import { applyRelayRouterProviderSwitch } from '../../utils/imageGenerationRelayRouter';
import {
    imageGenerationSectionStatus,
    IMAGE_GENERATION_SECTION_DEFAULT_OPEN,
    toggleImageGenerationSectionOpen,
} from '../../utils/imageGenerationSettingsSection';

interface Props {
    addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const PROVIDER_OPTIONS: Array<{ value: ImageGenerationProvider; label: string; note: string }> = [
    { value: 'gemini-native', label: 'Gemini Native', note: 'Gemini 原生生图 · 支持多张参考图' },
    { value: 'gpt-images', label: 'GPT Images', note: 'DALL-E 3 · 支持参考图 + 创意合照' },
    { value: 'openai-images', label: 'OpenAI-compatible Images', note: '兼容接口 · POST /images/generations' },
];

const RESOLUTIONS: ImageGenerationResolution[] = ['1K', '2K', '4K'];
const ASPECT_RATIOS: ImageGenerationAspectRatio[] = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'];

const fieldClass = 'w-full rounded-xl border border-slate-200/70 bg-white/70 px-3.5 py-2.5 text-sm text-slate-700 outline-none transition focus:border-fuchsia-300 focus:bg-white disabled:cursor-not-allowed disabled:opacity-50';

const ImageGenerationSettings: React.FC<Props> = ({ addToast }) => {
    const [savedConfig, setSavedConfig] = useState<ImageGenerationConfig>(() => loadImageGenerationConfig());
    const [draft, setDraft] = useState<ImageGenerationConfig>(() => loadImageGenerationConfig());
    // ─── 接口预设：独立版本化存储，首次访问自动把旧单配置无损迁移为「默认配置」预设 ───
    const [presetStore, setPresetStore] = useState<ImageGenerationPresetStore>(() => loadImageGenerationPresetStore());
    // 预设切换守卫：当前有未保存修改时，先弹内联确认条（保存/放弃/取消），禁止静默丢失
    const [pendingPresetId, setPendingPresetId] = useState<string | null>(null);
    const [presetNameInput, setPresetNameInput] = useState('');
    const [showNewPresetInput, setShowNewPresetInput] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [showKey, setShowKey] = useState(false);
    const [testing, setTesting] = useState(false);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [availableModels, setAvailableModels] = useState<AvailableImageModel[]>([]);
    const [modelSearch, setModelSearch] = useState('');
    const [imageModelsOnly, setImageModelsOnly] = useState(true);
    const [lastRefreshedAt, setLastRefreshedAt] = useState<Partial<Record<ImageGenerationProvider, number>>>({});
    const [status, setStatus] = useState('');
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const previewObjectUrlRef = useRef<string | null>(null);
    // 与其他 SettingsSection 一致：默认收起，标题行常显（标题 + 已启用/未启用状态），点击展开/收起
    const [open, setOpen] = useState(IMAGE_GENERATION_SECTION_DEFAULT_OPEN);

    const replacePreviewUrl = (next: string | null, isObjectUrl = false) => {
        if (previewObjectUrlRef.current) URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = isObjectUrl ? next : null;
        setPreviewUrl(next);
    };

    useEffect(() => () => {
        if (previewObjectUrlRef.current) URL.revokeObjectURL(previewObjectUrlRef.current);
    }, []);

    const patchDraft = <K extends keyof ImageGenerationConfig>(key: K, value: ImageGenerationConfig[K]) => {
        setDraft(current => ({ ...current, [key]: value }));
        setStatus('');
    };

    const isDraftDirty = () => JSON.stringify(normalizeImageGenerationConfig(draft)) !== JSON.stringify(savedConfig);

    // ─── 接口预设操作 ───────────────────────────────────────────────────────────
    const activePreset = presetStore.presets.find(preset => preset.id === presetStore.activeId) ?? null;

    const applyActivatedPreset = (presetId: string) => {
        const target = activateImageGenerationPreset(presetId);
        if (!target) {
            addToast('预设不存在或已被删除', 'error');
            setPresetStore(loadImageGenerationPresetStore());
            return;
        }
        setPresetStore(loadImageGenerationPresetStore());
        setSavedConfig(target.config);
        setDraft(target.config);
        setAvailableModels([]);
        setModelSearch('');
        setLastRefreshedAt({});
        setShowNewPresetInput(false);
        setRenaming(false);
        setPendingPresetId(null);
        setStatus(`已切换到预设「${target.name}」，配置已完整恢复`);
        replacePreviewUrl(null);
    };

    const selectPreset = (presetId: string) => {
        if (presetId === presetStore.activeId) return;
        // 未保存修改时不允许静默切换：先弹内联确认条（保存并切换 / 放弃修改并切换 / 取消）
        if (isDraftDirty()) {
            setPendingPresetId(presetId);
            setStatus('当前配置有未保存的修改，请选择保存或放弃后再切换');
            return;
        }
        applyActivatedPreset(presetId);
    };

    const confirmPendingSwitch = (mode: 'save' | 'discard') => {
        const targetId = pendingPresetId;
        if (!targetId) return;
        if (mode === 'save') {
            const normalized = normalizeImageGenerationConfig(draft);
            if (!validate(normalized)) return;
            if (activePreset) updateImageGenerationPreset(activePreset.id, { config: normalized });
            saveImageGenerationConfig(normalized);
            setSavedConfig(normalized);
        }
        applyActivatedPreset(targetId);
    };

    const createPresetFromDraft = () => {
        const name = presetNameInput.trim();
        if (!name) {
            addToast('请先填写预设名称', 'error');
            return;
        }
        const preset = createImageGenerationPreset(name, draft);
        setPresetStore(loadImageGenerationPresetStore());
        setPresetNameInput('');
        setShowNewPresetInput(false);
        setStatus(`已新建预设「${preset.name}」；点「保存配置」并切换后生效`);
        addToast(`预设「${preset.name}」已创建`, 'success');
    };

    const renameActivePreset = () => {
        if (!activePreset) return;
        const name = presetNameInput.trim();
        if (!name) {
            addToast('请先填写新的预设名称', 'error');
            return;
        }
        updateImageGenerationPreset(activePreset.id, { name });
        setPresetStore(loadImageGenerationPresetStore());
        setRenaming(false);
        setPresetNameInput('');
        addToast('预设已重命名', 'success');
    };

    const deleteActivePreset = () => {
        if (!activePreset) return;
        // 删除前二次确认；删除当前启用预设后由存储层安全切换到剩余预设或恢复关闭状态
        if (!window.confirm(`确定删除预设「${activePreset.name}」吗？该操作不可撤销。`)) return;
        deleteImageGenerationPreset(activePreset.id);
        const nextStore = loadImageGenerationPresetStore();
        setPresetStore(nextStore);
        const nextActive = loadImageGenerationConfig();
        setSavedConfig(nextActive);
        setDraft(nextActive);
        setAvailableModels([]);
        setLastRefreshedAt({});
        replacePreviewUrl(null);
        setStatus(nextStore.activeId ? '预设已删除，已切换到剩余预设' : '预设已删除，生图 API 已恢复为关闭状态');
        addToast('预设已删除', 'info');
    };

    /**
     * 切换接口模式：仅当 Base URL 指向 RelayRouter（api.relayrouter.ai / .app）时，
     * 自动把尾部 /v1 ↔ /v1beta 改写成目标协议的版本路径；其他地址原样保留。
     * 注意：预设之间切换不走这里——切换预设恢复各自保存的原始 URL，不做任何改写。
     * API Key 与其余字段不动；不同 provider 的模型列表继续互相隔离。
     */
    const switchProvider = (provider: ImageGenerationProvider) => {
        if (provider === draft.provider) return;
        const nextBaseUrl = applyRelayRouterProviderSwitch(draft.baseUrl, provider);
        setDraft(current => ({
            ...current,
            provider,
            baseUrl: nextBaseUrl === current.baseUrl ? current.baseUrl : nextBaseUrl,
        }));
        setStatus('');
    };

    const validate = (config: ImageGenerationConfig, requireModel = true): boolean => {
        if (!config.enabled) return true;
        const noAuth = config.authMode === 'none';
        // 无鉴权模式（用户显式选择）允许空 Key；普通云端接口仍要求完整填写
        const missingKey = !noAuth && !config.apiKey.trim();
        const missingBase = !config.baseUrl.trim();
        const missingModel = requireModel && !config.model.trim();
        if (missingBase || missingKey || missingModel) {
            addToast(noAuth
                ? '启用生图 API 前，请填写 Base URL 和模型'
                : '启用生图 API 前，请填写 Base URL、API Key 和模型', 'error');
            return false;
        }
        try {
            const url = new URL(config.baseUrl);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
        } catch {
            addToast('生图 Base URL 必须是有效的 HTTP(S) 地址', 'error');
            return false;
        }
        if (noAuth && !isPrivateNetworkBaseUrl(config.baseUrl)) {
            // 公网/非私有地址开启无鉴权：明确安全警告（不阻断，交由用户确认）
            addToast('安全提示：该地址不是本地/私有网络，无鉴权模式下请求将以明文方式发往公网接口，请确认目标服务确实无需鉴权', 'info');
        }
        return true;
    };

    const save = () => {
        const normalized = normalizeImageGenerationConfig(draft);
        if (!validate(normalized)) return;
        try {
            const saved = saveImageGenerationConfig(normalized);
            // 同步更新当前启用预设（有预设时），保持预设集合与生效配置一致
            if (activePreset) updateImageGenerationPreset(activePreset.id, { config: saved });
            setPresetStore(loadImageGenerationPresetStore());
            setSavedConfig(saved);
            setDraft(saved);
            setStatus(saved.enabled ? '生图 API 配置已保存' : '配置已保存，生图 API 当前关闭');
            addToast('生图 API 配置已保存在本机', 'success');
        } catch {
            addToast('保存失败：当前浏览器无法写入本地存储', 'error');
        }
    };

    const clear = () => {
        if (!window.confirm('确定清空全部生图接口预设和当前配置吗？该操作不可撤销，建议先导出备份。')) return;
        try {
            clearImageGenerationPresetStore();
            clearImageGenerationConfig();
            const cleared = loadImageGenerationConfig();
            setSavedConfig(cleared);
            setDraft(cleared);
            setPresetStore(loadImageGenerationPresetStore());
            setShowKey(false);
            setAvailableModels([]);
            setModelSearch('');
            setLastRefreshedAt({});
            setPendingPresetId(null);
            setShowNewPresetInput(false);
            setRenaming(false);
            setStatus('生图 API 配置与全部预设已清除');
            replacePreviewUrl(null);
            addToast('生图 API 配置已清除', 'info');
        } catch {
            addToast('清除失败：当前浏览器无法写入本地存储', 'error');
        }
    };

    const refreshModels = async () => {
        const config = normalizeImageGenerationConfig({ ...draft, enabled: true });
        if (!validate(config, false)) return;
        setModelsLoading(true);
        setStatus('正在刷新可用模型…');
        try {
            const models = await listAvailableModels(config);
            setAvailableModels(current => [
                ...current.filter(model => model.provider !== config.provider),
                ...models,
            ]);
            setLastRefreshedAt(current => ({ ...current, [config.provider]: Date.now() }));
            setStatus(models.length
                ? `已刷新 ${models.length} 个模型；可继续手动填写模型 ID`
                : '接口返回空模型列表；仍可手动填写模型 ID');
        } catch (error) {
            const message = error instanceof ImageGenerationError ? error.message : '模型列表刷新失败';
            setStatus(`模型刷新失败：${message}；仍可手动填写模型 ID`);
        } finally {
            setModelsLoading(false);
        }
    };

    const testConnection = async () => {
        const config = normalizeImageGenerationConfig({ ...draft, enabled: true });
        if (!validate(config)) return;
        setTesting(true);
        setStatus('正在请求测试图片…');
        replacePreviewUrl(null);
        try {
            // 手动按钮才会调用真实服务；自动化测试只 mock fetch。
            const result = await imageGenerationService.generateImage({
                prompt: 'A small luminous magenta circle centered on a clean white background, minimal test image.',
            }, config);
            const first = result.images[0];
            if (first.source === 'url') {
                // Remote images may render in <img> even when CORS forbids fetching their bytes.
                replacePreviewUrl(first.url);
            } else {
                const blob = await generatedImageToBlob(first);
                const objectUrl = URL.createObjectURL(blob);
                replacePreviewUrl(objectUrl, true);
            }
            setStatus(`测试成功 · ${result.provider} · ${result.images.length} 张图片`);
        } catch (error) {
            const message = error instanceof ImageGenerationError ? error.message : '测试失败，请检查接口配置';
            setStatus(`测试失败：${message}`);
        } finally {
            setTesting(false);
        }
    };

    const dirty = JSON.stringify(normalizeImageGenerationConfig(draft)) !== JSON.stringify(savedConfig);
    const providerModels = availableModels.filter(model => model.provider === draft.provider);
    const visibleModels = useMemo(() => filterAvailableImageModels(availableModels, {
        provider: draft.provider,
        query: modelSearch,
        imageOnly: imageModelsOnly,
    }), [availableModels, draft.provider, imageModelsOnly, modelSearch]);
    const selectedListModel = visibleModels.some(model => model.id === draft.model) ? draft.model : '';
    const refreshedAt = lastRefreshedAt[draft.provider];

    const statusChip = imageGenerationSectionStatus(savedConfig.enabled);

    return (
        <section className="rounded-3xl border border-white/60 bg-white/80 p-5 shadow-sm">
            <div className="flex items-center gap-3">
                <button
                    type="button"
                    onClick={() => setOpen(toggleImageGenerationSectionOpen)}
                    aria-expanded={open}
                    aria-controls="image-generation-settings-body"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                <div className="rounded-xl bg-fuchsia-100/70 p-2 text-fuchsia-600" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m3 16.5 5.2-5.2a2 2 0 0 1 2.8 0l1.5 1.5 2.2-2.2a2 2 0 0 1 2.8 0L21 14.1M6.75 7.5h.01M5.25 3.75h13.5A2.25 2.25 0 0 1 21 6v12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18V6a2.25 2.25 0 0 1 2.25-2.25Z" />
                    </svg>
                </div>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-semibold tracking-wider text-slate-600">生图 API</h2>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">独立于聊天与识图 API；未来生图功能统一走服务层。</p>
                    </div>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className={`h-3 w-3 shrink-0 text-slate-300 transition-transform ${open ? 'rotate-180' : ''}`}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                    </svg>
                </button>
                <span className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-bold ${statusChip.className}`}>
                    {statusChip.label}
                </span>
            </div>

            {open && (
            <div id="image-generation-settings-body" className="mt-4 space-y-4">
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-fuchsia-100 bg-fuchsia-50/60 p-3.5">
                    <div>
                        <div className="text-xs font-bold text-slate-600">启用生图 API</div>
                        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">Key 只写入当前设备；不会进入源码或日志。</p>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={draft.enabled}
                        onClick={() => patchDraft('enabled', !draft.enabled)}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${draft.enabled ? 'bg-fuchsia-500' : 'bg-slate-200'}`}
                    >
                        <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${draft.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </button>
                </div>

                {/* ─── 接口预设：多套配置一键切换（原生 select，兼容 iPhone Safari / 安卓浏览器） ─── */}
                <div className="rounded-2xl border border-slate-100 bg-white/60 p-3.5">
                    <div className="mb-1.5 flex items-center justify-between gap-2 pl-1">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">接口预设</label>
                        <span className="max-w-[55%] truncate text-[10px] text-slate-400">
                            {activePreset ? `当前使用：${activePreset.name}` : '暂无预设'}
                        </span>
                    </div>
                    <select
                        className={fieldClass}
                        value={presetStore.activeId ?? ''}
                        onChange={event => selectPreset(event.target.value)}
                        aria-label="选择生图接口预设"
                    >
                        {!presetStore.presets.length && <option value="">尚未创建预设</option>}
                        {presetStore.presets.map(preset => (
                            <option key={preset.id} value={preset.id}>{preset.name}</option>
                        ))}
                    </select>
                    <div className="mt-2 grid grid-cols-3 gap-2">
                        <button type="button" onClick={() => { setShowNewPresetInput(value => !value); setRenaming(false); setPresetNameInput(''); }} className="rounded-xl border border-slate-200 bg-white/70 py-2 text-[11px] font-bold text-slate-600 transition active:scale-95">
                            ＋ 新建预设
                        </button>
                        <button type="button" disabled={!activePreset} onClick={() => { setRenaming(value => !value); setShowNewPresetInput(false); setPresetNameInput(activePreset?.name ?? ''); }} className="rounded-xl border border-slate-200 bg-white/70 py-2 text-[11px] font-bold text-slate-600 transition active:scale-95 disabled:opacity-40">
                            ✏️ 重命名
                        </button>
                        <button type="button" disabled={!activePreset} onClick={deleteActivePreset} className="rounded-xl border border-rose-100 bg-rose-50/70 py-2 text-[11px] font-bold text-rose-500 transition active:scale-95 disabled:opacity-40">
                            🗑️ 删除
                        </button>
                    </div>
                    {(showNewPresetInput || renaming) && (
                        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                            <input
                                className={fieldClass}
                                value={presetNameInput}
                                maxLength={40}
                                onChange={event => setPresetNameInput(event.target.value)}
                                placeholder={renaming ? '输入新的预设名称' : '预设名称，如：RelayRouter 云端 / 朋友的 ComfyUI'}
                            />
                            <div className="flex gap-2">
                                <button type="button" onClick={renaming ? renameActivePreset : createPresetFromDraft} className="shrink-0 rounded-xl bg-fuchsia-500 px-4 py-2 text-[11px] font-bold text-white transition active:scale-95">
                                    {renaming ? '确认重命名' : '创建'}
                                </button>
                                <button type="button" onClick={() => { setShowNewPresetInput(false); setRenaming(false); setPresetNameInput(''); }} className="shrink-0 rounded-xl border border-slate-200 bg-white/70 px-4 py-2 text-[11px] font-bold text-slate-500 transition active:scale-95">
                                    取消
                                </button>
                            </div>
                        </div>
                    )}
                    <p className="mt-2 px-1 text-[9px] leading-relaxed text-slate-300">切换预设会完整恢复该预设保存的 URL、Key、模型与参数；未保存的修改会先询问保存或放弃。</p>
                </div>

                {/* 未保存修改时的切换守卫：禁止静默丢失 */}
                {pendingPresetId && (
                    <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-3.5">
                        <div className="text-xs font-bold text-amber-700">当前配置有未保存的修改</div>
                        <p className="mt-1 text-[10px] leading-relaxed text-amber-600">切换预设前请选择保存或放弃当前修改。</p>
                        <div className="mt-2 grid grid-cols-3 gap-2">
                            <button type="button" onClick={() => confirmPendingSwitch('save')} className="rounded-xl bg-amber-500 py-2 text-[11px] font-bold text-white transition active:scale-95">保存并切换</button>
                            <button type="button" onClick={() => confirmPendingSwitch('discard')} className="rounded-xl border border-amber-300 bg-white/70 py-2 text-[11px] font-bold text-amber-600 transition active:scale-95">放弃修改并切换</button>
                            <button type="button" onClick={() => { setPendingPresetId(null); setStatus(''); }} className="rounded-xl border border-slate-200 bg-white/70 py-2 text-[11px] font-bold text-slate-500 transition active:scale-95">取消</button>
                        </div>
                    </div>
                )}

                <div>
                    <label className="mb-1.5 block pl-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">接口模式</label>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {PROVIDER_OPTIONS.map(option => (
                            <button
                                type="button"
                                key={option.value}
                                onClick={() => switchProvider(option.value)}
                                className={`rounded-xl border px-3 py-2.5 text-left transition ${draft.provider === option.value ? 'border-fuchsia-300 bg-fuchsia-50 text-fuchsia-700' : 'border-slate-200 bg-white/70 text-slate-500'}`}
                            >
                                <span className="block text-xs font-bold">{option.label}</span>
                                <span className="mt-0.5 block text-[9px] opacity-70">{option.note}</span>
                            </button>
                        ))}
                    </div>
                </div>

                <div>
                    <label className="mb-1.5 block pl-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">Base URL</label>
                    <input className={fieldClass} value={draft.baseUrl} onChange={event => patchDraft('baseUrl', event.target.value)} placeholder={draft.provider === 'gemini-native' ? 'https://generativelanguage.googleapis.com' : draft.provider === 'gpt-images' ? 'https://api.openai.com/v1' : 'https://api.openai.com/v1'} />
                </div>

                <div>
                    <div className="mb-1.5 flex items-center justify-between pl-1">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">API Key</label>
                        <button type="button" onClick={() => setShowKey(value => !value)} className="text-[10px] font-bold text-fuchsia-600">
                            {showKey ? '隐藏' : '显示'}
                        </button>
                    </div>
                    <input className={`${fieldClass} font-mono`} type={showKey ? 'text' : 'password'} autoComplete="off" value={draft.apiKey} onChange={event => patchDraft('apiKey', event.target.value)} placeholder="仅保存在本机" />
                </div>

                <div>
                    <label className="mb-1.5 block pl-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">鉴权模式</label>
                    <select
                        className={fieldClass}
                        value={draft.authMode ?? 'api-key'}
                        onChange={event => patchDraft('authMode', event.target.value as ImageGenerationAuthMode)}
                        aria-label="生图接口鉴权模式"
                    >
                        <option value="api-key">API Key 鉴权（默认，云端接口）</option>
                        <option value="none">无鉴权（本地/私有接口，允许空 Key）</option>
                    </select>
                    {draft.authMode === 'none' && (
                        isPrivateNetworkBaseUrl(draft.baseUrl) ? (
                            <p className="mt-1.5 px-1 text-[9px] leading-relaxed text-emerald-500">已识别为本地/私有网络地址（含 Tailscale 等内网 HTTPS）；空 Key 时不会发送任何 Authorization 头。</p>
                        ) : (
                            <p className="mt-1.5 px-1 text-[9px] leading-relaxed text-amber-500">⚠️ 该地址不是本地/私有网络：无鉴权模式下请求将发往公网接口且不带任何鉴权头，可能被第三方滥用或调用失败，请确认目标服务确实无需鉴权。</p>
                        )
                    )}
                </div>

                <div>
                    <div className="mb-1.5 flex items-center justify-between gap-2 pl-1">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">模型名称</label>
                        <button
                            type="button"
                            disabled={modelsLoading || testing}
                            onClick={refreshModels}
                            className="rounded-lg bg-fuchsia-50 px-2.5 py-1 text-[10px] font-bold text-fuchsia-600 transition active:scale-95 disabled:opacity-40"
                        >
                            {modelsLoading ? '刷新中…' : '刷新模型'}
                        </button>
                    </div>
                    <input className={`${fieldClass} font-mono`} value={draft.model} onChange={event => patchDraft('model', event.target.value)} placeholder="gemini-3-pro-image" />
                    <div className="mt-2 space-y-2 rounded-xl border border-slate-100 bg-white/55 p-2.5">
                        <input
                            className={`${fieldClass} py-2`}
                            type="search"
                            value={modelSearch}
                            onChange={event => setModelSearch(event.target.value)}
                            placeholder="搜索已刷新的模型"
                        />
                        <select
                            className={fieldClass}
                            value={selectedListModel}
                            onChange={event => {
                                if (event.target.value === '__show_all__') {
                                    setImageModelsOnly(false);
                                    return;
                                }
                                patchDraft('model', resolveImageModelSelection(event.target.value, draft.model));
                            }}
                        >
                            <option value="">选择已刷新模型（保留手动输入）</option>
                            {imageModelsOnly && <option value="__show_all__">显示全部模型</option>}
                            {visibleModels.map(model => (
                                <option key={`${model.provider}:${model.id}`} value={model.id}>
                                    {model.displayName} · {model.imageCapability === 'confirmed' ? '确认支持生图' : model.imageCapability === 'likely' ? '可能支持生图' : '能力未知'}
                                </option>
                            ))}
                        </select>
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[9px] text-slate-400">
                            <label className="flex items-center gap-1.5">
                                <input type="checkbox" checked={imageModelsOnly} onChange={event => setImageModelsOnly(event.target.checked)} className="h-3.5 w-3.5 accent-fuchsia-500" />
                                仅显示可能支持生图的模型
                            </label>
                            <span>
                                {refreshedAt ? `最近刷新：${new Date(refreshedAt).toLocaleTimeString()}` : '尚未刷新'}
                                {providerModels.length ? ` · 共 ${providerModels.length} 个` : ''}
                            </span>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className="mb-1.5 block pl-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">默认分辨率</label>
                        <select className={fieldClass} value={draft.defaultResolution} onChange={event => patchDraft('defaultResolution', event.target.value as ImageGenerationResolution)}>
                            {RESOLUTIONS.map(value => <option key={value} value={value}>{value}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="mb-1.5 block pl-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">默认宽高比</label>
                        <select className={fieldClass} value={draft.defaultAspectRatio} onChange={event => patchDraft('defaultAspectRatio', event.target.value as ImageGenerationAspectRatio)}>
                            {ASPECT_RATIOS.map(value => <option key={value} value={value}>{value}</option>)}
                        </select>
                    </div>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-white/60 px-3.5 py-3">
                    <div>
                        <div className="text-xs font-semibold text-slate-600">允许参考图</div>
                        <p className="mt-0.5 text-[9px] text-slate-400">Gemini Native 最多 5 张；GPT Images 支持参考图；Images 模式会明确报不支持。</p>
                    </div>
                    <input type="checkbox" checked={draft.allowReferenceImages} onChange={event => patchDraft('allowReferenceImages', event.target.checked)} className="h-4 w-4 accent-fuchsia-500" />
                </div>

                <div>
                    <label className="mb-1.5 block pl-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">请求超时（秒）</label>
                    <input className={fieldClass} type="number" min={5} max={300} step={5} value={Math.round(draft.timeoutMs / 1000)} onChange={event => patchDraft('timeoutMs', Number(event.target.value) * 1000)} />
                </div>

                <div className="grid grid-cols-2 gap-2">
                    <button type="button" disabled={testing || modelsLoading} onClick={testConnection} className="rounded-2xl border border-fuchsia-200 bg-fuchsia-50 py-3 text-sm font-bold text-fuchsia-600 transition active:scale-95 disabled:opacity-40">
                        {testing ? '生图测试中…' : '🧪 测试生图'}
                    </button>
                    <button type="button" disabled={testing || modelsLoading} onClick={save} className="rounded-2xl bg-fuchsia-500 py-3 text-sm font-bold text-white shadow-lg shadow-fuchsia-500/20 transition active:scale-95 disabled:opacity-50">
                        {dirty ? '保存配置' : '已保存'}
                    </button>
                </div>
                <button type="button" disabled={testing || modelsLoading} onClick={clear} className="w-full rounded-xl py-2 text-[11px] font-semibold text-rose-500 transition hover:bg-rose-50 disabled:opacity-40">清除配置</button>

                {status && <div className={`rounded-xl px-3 py-2 text-xs leading-relaxed ${status.includes('失败') ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>{status}</div>}
                {previewUrl && <img src={previewUrl} alt="生图 API 测试预览" className="mx-auto max-h-64 w-auto rounded-2xl border border-fuchsia-100 bg-white object-contain shadow-sm" />}
                <p className="px-1 text-[9px] leading-relaxed text-slate-300">测试会真实调用一次当前生图接口，可能产生费用；自动化测试不会请求真实服务。临时预览关闭或替换时会释放。</p>
            </div>
            )}
        </section>
    );
};

export default ImageGenerationSettings;
