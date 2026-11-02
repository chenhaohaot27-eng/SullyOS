/**
 * SceneCameraModal — 「见面摄影机」共享 UI（Phase 3C）
 *
 * 陪伴模式与剧情模式共用同一个摄影机弹层，不得各自实现第二套 UI。
 *
 * 设计约束（见 docs/handoff/scene_camera_state.md Phase 3C）：
 *   · Director / Renderer 是两个独立概念：Director 复用当前聊天 API config，
 *     Renderer 复用现有 Image Generation Settings（不复制 Key、不新建第二套配置）；
 *   · UI 不绑定具体厂商品牌，只展示 provider / model；
 *   · 两阶段加载：正在理解这一幕…… → 摄影机正在成像……
 *   · 成功后区分「重拍同一镜头」（保留 ShotPlan，不调 Director）与「重新导演」（带 previousShotPlan）；
 *   · Renderer 失败时 ShotPlan 保留在 session state，可重试 / 换模型重拍；
 *   · 图片复用 ChatPhotoViewer 预览与保存；不自动插入聊天、不写剧情、不写长期记忆；
 *   · 关闭 modal 即清理 loading 与临时 ShotPlan（第一版不落 DB）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Copy } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import type {
    CharacterProfile,
    ImageGenerationAspectRatio,
    ImageGenerationConfig,
    SceneCompositionMode,
    SceneEnvironmentDetail,
    SceneImageOptions,
    SceneSubjectFocus,
} from '../../types';
import { loadImageGenerationConfig, IMAGE_GENERATION_CONFIG_CHANGED_EVENT } from '../../utils/imageGenerationConfig';
import { deriveDirectorApiConfig, type SceneCameraContextSource } from '../../utils/sceneCameraContext';
import {
    SceneCameraSession,
    SCENE_CAMERA_ASPECT_RATIOS,
    INITIAL_SCENE_CAMERA_SESSION_STATE,
    type SceneCameraSessionState,
} from '../../utils/sceneCameraSession';
import { loadSceneImageOptions, saveSceneImageOptions } from '../../utils/imageGenerationOptions';
import { summarizeSceneAnalysis } from '../../utils/buildSceneAnalysisPrompt';
import ChatPhotoViewer from '../chat/ChatPhotoViewer';

export interface SceneCameraModalProps {
    open: boolean;
    onClose: () => void;
    /** 上下文来源：companion（陪伴）/ story（剧情），只影响说明文案与上下文获取 */
    contextSource: SceneCameraContextSource;
    /** 陪伴模式 = 见面角色；剧情模式 = 首位出场角色（多 NPC 群像第一版不实现） */
    character: CharacterProfile;
    /** 最小必要场景上下文（由入口用 sceneCameraContext 的 builder 提供） */
    getSceneContext: () => string;
    /** 「选中文本生图」：用户在打开摄影机前选中的原文（存在时为画面最高依据） */
    selectedText?: string;
}

const MODE_OPTIONS: Array<{ value: 'scene-snapshot' | 'duo-photo'; label: string; hint: string }> = [
    { value: 'scene-snapshot', label: '当前场景快照', hint: '忠实还原此刻的文字场景，不推进剧情，不替你增加关键行为。' },
    { value: 'duo-photo', label: '双人合照', hint: '让导演设计更自然的双人构图；没有你的固定形象时会用侧脸、背影等自然方式，不会把你删掉。' },
];

/** 画面导演选项的分组元数据（label/hint 文案与 buildSceneImagePrompt 的语义一一对应）。 */
const COMPOSITION_MODE_OPTIONS: Array<{ value: SceneCompositionMode; label: string; hint: string }> = [
    { value: 'character_focus', label: '角色主画面', hint: '优先突出你和角色，适合双人互动图' },
    { value: 'narrative_balanced', label: '剧情平衡', hint: '兼顾人物、环境与情节' },
    { value: 'text_faithful', label: '原文还原', hint: '画面以文字内容为准，不强行突出你和角色' },
];

const ENVIRONMENT_DETAIL_OPTIONS: Array<{ value: SceneEnvironmentDetail; label: string; hint: string }> = [
    { value: 'minimal', label: '简化环境', hint: '只保留最必要的背景线索' },
    { value: 'key_elements', label: '保留关键元素', hint: '保留对剧情有意义的空间和道具' },
    { value: 'full_scene', label: '尽量完整还原', hint: '完整保留场景、层次、物件与氛围' },
];

const SUBJECT_FOCUS_OPTIONS: Array<{ value: SceneSubjectFocus; label: string; hint: string }> = [
    { value: 'duo', label: '双人为主', hint: '优先你 + 当前角色' },
    { value: 'current_character', label: '当前角色为主', hint: '角色优先，你可辅助入镜' },
    { value: 'auto', label: '自动判断', hint: '根据文本决定画面主体' },
    { value: 'npc_allowed', label: '允许 NPC 为主', hint: '允许 NPC 或群像成为画面中心' },
];

/** 分段选择器：一组互斥的小卡片（导演选项用，保持弹层简洁）。 */
function OptionGroup<T extends string>(props: {
    title: string;
    options: Array<{ value: T; label: string; hint: string }>;
    value: T;
    disabled?: boolean;
    onSelect: (value: T) => void;
}) {
    const active = props.options.find(o => o.value === props.value);
    return (
        <div>
            <div className="text-[10px] font-bold tracking-[.18em] uppercase text-white/40">{props.title}</div>
            <div className="mt-2 flex flex-wrap gap-2">
                {props.options.map(option => (
                    <button
                        key={option.value}
                        type="button"
                        disabled={props.disabled}
                        onClick={() => props.onSelect(option.value)}
                        className={`h-9 rounded-xl border px-3 text-[12px] font-bold transition-all active:scale-95 disabled:opacity-60 ${props.value === option.value ? 'border-white bg-white text-slate-900' : 'border-white/15 bg-white/5 text-white/70'}`}
                    >
                        {option.label}
                    </button>
                ))}
            </div>
            {active && <p className="mt-1.5 text-[10px] leading-4 text-white/45">{active.hint}</p>}
        </div>
    );
}

const RENDERER_PROVIDER_LABELS: Record<string, string> = {
    'gemini-native': 'Gemini 原生',
    'gpt-images': 'GPT Images',
    'openai-images': 'OpenAI 兼容',
};

function rendererReady(config: ImageGenerationConfig | undefined): boolean {
    return !!config && config.enabled && !!config.baseUrl && !!config.apiKey && !!config.model;
}

const SceneCameraModal: React.FC<SceneCameraModalProps> = ({ open, onClose, contextSource, character, getSceneContext, selectedText }) => {
    const { apiConfig } = useOS();
    const [state, setState] = useState<SceneCameraSessionState>(INITIAL_SCENE_CAMERA_SESSION_STATE);
    const [rendererConfig, setRendererConfig] = useState<ImageGenerationConfig | undefined>(() => (typeof window === 'undefined' ? undefined : loadImageGenerationConfig()));
    const [showViewer, setShowViewer] = useState(false);
    // 画面导演选项：打开时读上次选择，改动即持久化（localStorage），下次免重设
    const [options, setOptions] = useState<SceneImageOptions>(() => (typeof window === 'undefined' ? { ...INITIAL_SCENE_CAMERA_SESSION_STATE.options } : loadSceneImageOptions()));
    // 导演思路预览：最终 prompt 草稿（可编辑，配合「用此 Prompt 重拍」）
    const [promptDraft, setPromptDraft] = useState('');
    const [promptCopied, setPromptCopied] = useState(false);
    const sessionRef = useRef<SceneCameraSession | null>(null);
    const characterRef = useRef(character);
    characterRef.current = character;
    const sceneContextRef = useRef(getSceneContext);
    sceneContextRef.current = getSceneContext;
    const apiConfigRef = useRef(apiConfig);
    apiConfigRef.current = apiConfig;
    const selectedTextRef = useRef(selectedText);
    selectedTextRef.current = selectedText;
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const busy = state.phase === 'directing' || state.phase === 'rendering';
    const directorReady = !!apiConfig.baseUrl && !!apiConfig.apiKey && !!apiConfig.model;
    const isRendererReady = rendererReady(rendererConfig);

    // 打开时创建 session；关闭时中止请求并清理 loading / 临时 ShotPlan。
    useEffect(() => {
        if (!open) return;
        const session = new SceneCameraSession({
            getSceneContext: () => sceneContextRef.current(),
            getCharacter: () => characterRef.current,
            getDirectorConfig: () => deriveDirectorApiConfig(apiConfigRef.current),
            getRendererConfig: () => loadImageGenerationConfig(),
            getSelectedText: () => selectedTextRef.current || undefined,
            debug: import.meta.env.DEV,
        });
        sessionRef.current = session;
        const unsubscribe = session.subscribe(() => setState(session.getState()));
        const config = loadImageGenerationConfig();
        setRendererConfig(config);
        // 宽高比默认读取现有生图配置，不维护第二套全局默认值。
        session.setAspectRatio(config.defaultAspectRatio);
        // 导演选项接上「上次的选择」（持久化在 localStorage）。
        session.setOptions(optionsRef.current);
        setState(session.getState());
        return () => {
            unsubscribe();
            session.reset();
            sessionRef.current = null;
            setShowViewer(false);
            setPromptDraft('');
            setPromptCopied(false);
        };
    }, [open]);

    // 新 ShotPlan 落地时同步 prompt 草稿（导演思路预览区可编辑的初始值）。
    useEffect(() => {
        setPromptDraft(state.shotPlan?.finalPrompt || '');
        setPromptCopied(false);
    }, [state.shotPlan?.finalPrompt, state.shotPlan?.createdAt]);

    // 用户在「生图 API」设置里换模型后，回到本弹层能立即看到新 Renderer（并支持换模型重拍）。
    useEffect(() => {
        if (!open || typeof window === 'undefined') return;
        const handler = () => setRendererConfig(loadImageGenerationConfig());
        window.addEventListener(IMAGE_GENERATION_CONFIG_CHANGED_EVENT, handler);
        return () => window.removeEventListener(IMAGE_GENERATION_CONFIG_CHANGED_EVENT, handler);
    }, [open]);

    // 桌面端 Escape 关闭。
    useEffect(() => {
        if (!open || typeof window === 'undefined') return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const handleGenerate = useCallback(() => { void sessionRef.current?.generate(); }, []);
    const handleRerenderSameShot = useCallback(() => { void sessionRef.current?.rerenderSameShot(); }, []);
    const handleRedirect = useCallback(() => { void sessionRef.current?.redirectNewShot(); }, []);
    const handleRetry = useCallback(() => { void sessionRef.current?.retry(); }, []);
    // 「更换生图模型后重拍」：重新读取现有生图配置（用户可能刚在设置里换过），再走 Renderer 重试。
    const handleRetryWithFreshRenderer = useCallback(() => {
        setRendererConfig(loadImageGenerationConfig());
        void sessionRef.current?.retry();
    }, []);

    const handleSelectMode = useCallback((mode: 'scene-snapshot' | 'duo-photo') => {
        sessionRef.current?.setMode(mode);
    }, []);

    const handleSelectAspectRatio = useCallback((ratio: ImageGenerationAspectRatio) => {
        sessionRef.current?.setAspectRatio(ratio);
    }, []);

    /** 导演选项改动：session 立即生效 + localStorage 记住上次选择。 */
    const updateOptions = useCallback((patch: Partial<SceneImageOptions>) => {
        setOptions(prev => {
            const next: SceneImageOptions = { ...prev, ...patch };
            saveSceneImageOptions(next);
            sessionRef.current?.setOptions(next);
            return next;
        });
    }, []);

    const handleCopyPrompt = useCallback(async () => {
        if (!promptDraft) return;
        try {
            await navigator.clipboard.writeText(promptDraft);
            setPromptCopied(true);
            setTimeout(() => setPromptCopied(false), 2000);
        } catch { /* 剪贴板不可用时静默；用户仍可手动选择文本复制 */ }
    }, [promptDraft]);

    /** 用户编辑过最终 prompt 后，用编辑稿「重拍同一镜头」。 */
    const handleRerenderWithDraftPrompt = useCallback(() => {
        if (!promptDraft.trim()) return;
        sessionRef.current?.updateFinalPrompt(promptDraft);
        void sessionRef.current?.rerenderSameShot();
    }, [promptDraft]);

    if (!open || typeof document === 'undefined') return null;

    const subtitle = contextSource === 'companion' ? '把此刻的见面拍成一张照片' : '把这一幕剧情拍成一张照片';
    const directorLabel = `${apiConfig.apiFormat === 'gemini-native' ? 'Gemini 原生格式' : 'OpenAI 兼容格式'} · ${apiConfig.model || '未配置'}`;
    const rendererLabel = rendererConfig
        ? `${RENDERER_PROVIDER_LABELS[rendererConfig.provider] || rendererConfig.provider} · ${rendererConfig.model}${rendererConfig.defaultResolution ? ` · ${rendererConfig.defaultResolution}` : ''}`
        : '未配置';

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label="摄影机"
            className="fixed inset-0 z-[90] flex items-end justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
            onClick={onClose}
        >
            <div
                className="story-safe-sheet w-full max-w-lg max-h-[88vh] overflow-y-auto no-scrollbar rounded-t-[2rem] border-t border-white/10 bg-slate-950/95 px-5 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] text-white shadow-2xl animate-slide-up"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-white/25" />

                {/* 顶部：标题 + 当前模式说明 + 关闭 */}
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <h2 className="text-base font-bold tracking-wide">📷 摄影机</h2>
                        <p className="mt-1 text-[11px] leading-4 text-white/50">{subtitle} · {MODE_OPTIONS.find(m => m.value === state.mode)?.label}</p>
                    </div>
                    <button type="button" aria-label="关闭摄影机" onClick={onClose} className="h-9 w-9 shrink-0 rounded-full bg-white/10 grid place-items-center text-white/80 active:scale-90 transition-transform">
                        <X size={17} />
                    </button>
                </div>

                {/* 「选中文本生图」：原文锁定提示（原文叙事优先） */}
                {selectedText && selectedText.trim() && (
                    <div className="mt-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-3">
                        <div className="text-[11px] font-bold text-emerald-200">📄 已锁定选中的原文（{selectedText.trim().length} 字）</div>
                        <p className="mt-1 text-[10px] leading-4 text-emerald-100/70">画面将以这段文字为最高依据：谁重要画谁，环境与情节按原文保留，不会默认拍成双人图。</p>
                    </div>
                )}

                {/* 摄影模式 */}
                <div className="mt-4 space-y-2">
                    <div className="text-[10px] font-bold tracking-[.18em] uppercase text-white/40">摄影模式</div>
                    {MODE_OPTIONS.map(option => (
                        <button
                            key={option.value}
                            type="button"
                            disabled={busy}
                            onClick={() => handleSelectMode(option.value)}
                            className={`w-full rounded-2xl border p-3 text-left transition-all active:scale-[.98] disabled:opacity-60 ${state.mode === option.value ? 'border-white/60 bg-white/15' : 'border-white/10 bg-white/5'}`}
                        >
                            <div className="flex items-center gap-2 text-[13px] font-bold">
                                <span className={`h-3.5 w-3.5 rounded-full border-2 grid place-items-center ${state.mode === option.value ? 'border-white' : 'border-white/40'}`}>
                                    {state.mode === option.value && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                                </span>
                                {option.label}
                            </div>
                            <p className="mt-1 pl-6 text-[10px] leading-4 text-white/45">{option.hint}</p>
                        </button>
                    ))}
                </div>

                {/* 画面导演：AI 导演开关 + 构图方式 / 环境保留 / 人物焦点（记住上次选择） */}
                <div className="mt-4 space-y-4 rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <div className="text-[12px] font-bold">🎬 AI 导演分析</div>
                            <p className="mt-0.5 text-[10px] leading-4 text-white/45">开启后先解析原文再导演画面；关闭则直接按原文 + 基础设定生成</p>
                        </div>
                        <button
                            type="button"
                            disabled={busy}
                            role="switch"
                            aria-checked={options.directorEnabled}
                            aria-label="AI 导演分析开关"
                            onClick={() => updateOptions({ directorEnabled: !options.directorEnabled })}
                            className={`h-8 w-14 shrink-0 rounded-full border transition-all active:scale-95 disabled:opacity-60 ${options.directorEnabled ? 'border-white bg-white' : 'border-white/25 bg-white/10'}`}
                        >
                            <span className={`block h-6 w-6 rounded-full transition-transform ${options.directorEnabled ? 'translate-x-[26px] bg-slate-900' : 'translate-x-1 bg-white/70'}`} />
                        </button>
                    </div>

                    <OptionGroup
                        title="构图方式"
                        options={COMPOSITION_MODE_OPTIONS}
                        value={options.compositionMode}
                        disabled={busy}
                        onSelect={(value) => updateOptions({ compositionMode: value })}
                    />
                    <OptionGroup
                        title="环境保留"
                        options={ENVIRONMENT_DETAIL_OPTIONS}
                        value={options.environmentDetail}
                        disabled={busy}
                        onSelect={(value) => updateOptions({ environmentDetail: value })}
                    />
                    <OptionGroup
                        title="人物焦点"
                        options={SUBJECT_FOCUS_OPTIONS}
                        value={options.subjectFocus}
                        disabled={busy}
                        onSelect={(value) => updateOptions({ subjectFocus: value })}
                    />
                </div>

                {/* Director / Renderer 配置（两个独立概念，只读展示） */}
                <div className="mt-4 grid grid-cols-2 gap-2">
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                        <div className="text-[9px] font-bold tracking-[.18em] uppercase text-white/40">摄影导演</div>
                        <div className={`mt-1 text-[11px] leading-4 break-all ${directorReady ? 'text-white/85' : 'text-amber-300'}`}>{directorLabel}</div>
                        {!directorReady && <div className="mt-1 text-[9px] text-amber-300/80">复用聊天 API 配置，请先在设置中完成配置</div>}
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                        <div className="text-[9px] font-bold tracking-[.18em] uppercase text-white/40">生图模型</div>
                        <div className={`mt-1 text-[11px] leading-4 break-all ${isRendererReady ? 'text-white/85' : 'text-amber-300'}`}>{rendererLabel}</div>
                        {!isRendererReady && <div className="mt-1 text-[9px] text-amber-300/80">复用「生图 API」设置，请先启用并填写</div>}
                    </div>
                </div>

                {/* 画面设置：宽高比（默认读取生图配置） */}
                <div className="mt-4">
                    <div className="text-[10px] font-bold tracking-[.18em] uppercase text-white/40">画面设置 · 宽高比</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                        {SCENE_CAMERA_ASPECT_RATIOS.map(ratio => (
                            <button
                                key={ratio}
                                type="button"
                                disabled={busy}
                                onClick={() => handleSelectAspectRatio(ratio)}
                                className={`h-9 min-w-[52px] rounded-xl border px-3 text-[12px] font-bold transition-all active:scale-95 disabled:opacity-60 ${state.aspectRatio === ratio ? 'border-white bg-white text-slate-900' : 'border-white/15 bg-white/5 text-white/70'}`}
                            >
                                {ratio}
                            </button>
                        ))}
                    </div>
                </div>

                {/* 生成结果 / 两阶段加载 / 错误面板 */}
                {busy && (
                    <div className="mt-4 flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 py-4">
                        <svg className="h-4 w-4 animate-spin text-white/70" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                        <span className="text-[13px] text-white/80">{state.phase === 'directing' ? '正在理解这一幕……' : '摄影机正在成像……'}</span>
                    </div>
                )}

                {!busy && state.phase === 'error' && (
                    <div className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4">
                        <div className="text-[13px] font-bold text-rose-200">这一张没有拍成</div>
                        <p className="mt-1 break-all text-[11px] leading-4 text-rose-200/70">{state.error || '生成失败'}</p>
                        {state.shotPlan && <p className="mt-1 text-[10px] text-white/45">镜头方案已保留，可以直接重拍，不必重新导演。</p>}
                        <div className="mt-3 flex flex-wrap gap-2">
                            <button type="button" onClick={handleRetry} className="h-9 rounded-full bg-white px-4 text-[12px] font-bold text-slate-900 active:scale-95 transition-transform">重试</button>
                            <button type="button" onClick={handleRetryWithFreshRenderer} className="h-9 rounded-full border border-white/25 bg-white/10 px-4 text-[12px] font-bold text-white active:scale-95 transition-transform">换生图模型后重拍</button>
                        </div>
                        <p className="mt-2 text-[10px] leading-4 text-white/40">可在「设置 → 生图 API」里更换模型或 Key，回来后点「换生图模型后重拍」。</p>
                    </div>
                )}

                {!busy && state.imageUrl && (
                    <div className="mt-4">
                        <button
                            type="button"
                            onClick={() => setShowViewer(true)}
                            className="block w-full overflow-hidden rounded-2xl border border-white/10 active:scale-[.99] transition-transform"
                            aria-label="查看大图"
                        >
                            <img src={state.imageUrl} alt={state.shotPlan?.moment || '这一幕'} className="w-full object-contain" draggable={false} />
                        </button>
                        <p className="mt-1.5 text-center text-[10px] text-white/40">点击查看大图 · 长按或使用保存按钮存到手机</p>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={handleRerenderSameShot}
                                className="rounded-2xl border border-white/20 bg-white/10 p-3 text-left active:scale-95 transition-transform"
                            >
                                <span className="block text-[12px] font-bold">重拍同一镜头</span>
                                <span className="mt-0.5 block text-[9px] leading-4 text-white/50">保留镜头设计，只重新成像；换了生图模型后也可用</span>
                            </button>
                            <button
                                type="button"
                                onClick={handleRedirect}
                                className="rounded-2xl border border-white/20 bg-white/10 p-3 text-left active:scale-95 transition-transform"
                            >
                                <span className="block text-[12px] font-bold">重新导演</span>
                                <span className="mt-0.5 block text-[9px] leading-4 text-white/50">重新设计机位、景别与构图，仍忠于当前剧情</span>
                            </button>
                        </div>
                    </div>
                )}

                {/* 主操作（关闭导演时不依赖聊天 API 配置） */}
                <button
                    type="button"
                    disabled={busy || (options.directorEnabled && !directorReady) || !isRendererReady}
                    onClick={handleGenerate}
                    className="mt-4 h-12 w-full rounded-2xl bg-white text-[14px] font-bold text-slate-900 transition-transform active:scale-95 disabled:opacity-40"
                >
                    {busy ? (state.phase === 'directing' ? '正在理解这一幕……' : '摄影机正在成像……') : '生成这一幕'}
                </button>
                {!isRendererReady && <p className="mt-2 text-center text-[10px] text-white/40">需要先在「设置 → 生图 API」启用生图服务</p>}

                {/* 导演链路降级提示（明确但不烦人） */}
                {state.directorNotice && !busy && (
                    <div className="mt-3 rounded-2xl border border-amber-300/25 bg-amber-300/10 px-3 py-2">
                        <p className="text-[11px] leading-4 text-amber-200/90">{state.directorNotice}</p>
                    </div>
                )}

                {/* 高级项（可折叠）：导演思路预览 + 最终 Prompt（可编辑 / 可复制） */}
                {state.shotPlan && !busy && (
                    <details className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-3">
                        <summary className="cursor-pointer text-[10px] font-bold tracking-[.18em] uppercase text-white/40">展开查看导演结果与最终 Prompt</summary>
                        <div className="mt-2 space-y-3">
                            {state.sceneAnalysis && (
                                <div>
                                    <div className="text-[10px] font-bold text-white/50">场景解析摘要</div>
                                    <ul className="mt-1 space-y-0.5">
                                        {summarizeSceneAnalysis(state.sceneAnalysis).map(line => (
                                            <li key={line} className="text-[10px] leading-4 text-white/60">· {line}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {state.shotPlan.finalPrompt && (
                                <div>
                                    <div className="flex items-center justify-between">
                                        <div className="text-[10px] font-bold text-white/50">最终生图 Prompt（可编辑）</div>
                                        <div className="flex gap-2">
                                            <button
                                                type="button"
                                                onClick={() => void handleCopyPrompt()}
                                                className="flex h-7 items-center gap-1 rounded-full border border-white/20 bg-white/10 px-3 text-[10px] font-bold text-white active:scale-95 transition-transform"
                                            >
                                                <Copy size={12} />{promptCopied ? '已复制' : '复制最终 Prompt'}
                                            </button>
                                            {promptDraft.trim() && promptDraft !== state.shotPlan.finalPrompt && (
                                                <button
                                                    type="button"
                                                    onClick={handleRerenderWithDraftPrompt}
                                                    className="h-7 rounded-full bg-white px-3 text-[10px] font-bold text-slate-900 active:scale-95 transition-transform"
                                                >
                                                    用此 Prompt 重拍
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <textarea
                                        value={promptDraft}
                                        onChange={e => setPromptDraft(e.target.value)}
                                        rows={5}
                                        spellCheck={false}
                                        className="mt-1.5 w-full resize-y rounded-xl border border-white/10 bg-black/30 p-2.5 text-[10px] leading-4 text-white/75 outline-none focus:border-white/30"
                                    />
                                </div>
                            )}
                        </div>
                    </details>
                )}

                {/* 开发阶段调试区：仅 DEV 构建，普通玩家不可见 */}
                {import.meta.env.DEV && (state.directorMetadata || state.rendererMetadata || state.shotPlan) && (
                    <details className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-3">
                        <summary className="cursor-pointer text-[10px] font-bold tracking-[.18em] uppercase text-white/40">Debug · ShotPlan 摘要</summary>
                        <div className="mt-2 space-y-1 text-[10px] leading-4 text-white/60">
                            <div>mode: {state.mode}</div>
                            <div>director: {state.directorMetadata ? `${state.directorMetadata.provider} · ${state.directorMetadata.model}` : '—'}</div>
                            <div>renderer: {state.rendererMetadata ? `${state.rendererMetadata.provider} · ${state.rendererMetadata.model}` : '—'}</div>
                            <div>aspectRatio: {state.aspectRatio || '—'}</div>
                            <div>cameraPosition: {state.shotPlan?.cameraPosition || '—'}</div>
                            <div>shotSize: {state.shotPlan?.shotSize || '—'}</div>
                            <div>composition: {state.shotPlan?.composition || '—'}</div>
                        </div>
                    </details>
                )}
            </div>

            {/* 全屏大图与保存：复用现有 ChatPhotoViewer，不伪装成聊天消息 */}
            {showViewer && state.imageUrl && (
                <ChatPhotoViewer
                    content={state.imageUrl}
                    displayUrl={state.imageUrl}
                    caption={state.shotPlan?.moment}
                    onClose={() => setShowViewer(false)}
                />
            )}
        </div>,
        document.body,
    );
};

export default SceneCameraModal;
