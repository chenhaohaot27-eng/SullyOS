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
import { X } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import type { CharacterProfile, ImageGenerationAspectRatio, ImageGenerationConfig } from '../../types';
import { loadImageGenerationConfig, IMAGE_GENERATION_CONFIG_CHANGED_EVENT } from '../../utils/imageGenerationConfig';
import { deriveDirectorApiConfig, type SceneCameraContextSource } from '../../utils/sceneCameraContext';
import {
    SceneCameraSession,
    SCENE_CAMERA_ASPECT_RATIOS,
    INITIAL_SCENE_CAMERA_SESSION_STATE,
    type SceneCameraSessionState,
} from '../../utils/sceneCameraSession';
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
}

const MODE_OPTIONS: Array<{ value: 'scene-snapshot' | 'duo-photo'; label: string; hint: string }> = [
    { value: 'scene-snapshot', label: '当前场景快照', hint: '忠实还原此刻的文字场景，不推进剧情，不替你增加关键行为。' },
    { value: 'duo-photo', label: '双人合照', hint: '让导演设计更自然的双人构图；没有你的固定形象时会用侧脸、背影等自然方式，不会把你删掉。' },
];

const RENDERER_PROVIDER_LABELS: Record<string, string> = {
    'gemini-native': 'Gemini 原生',
    'gpt-images': 'GPT Images',
    'openai-images': 'OpenAI 兼容',
};

function rendererReady(config: ImageGenerationConfig | undefined): boolean {
    return !!config && config.enabled && !!config.baseUrl && !!config.apiKey && !!config.model;
}

const SceneCameraModal: React.FC<SceneCameraModalProps> = ({ open, onClose, contextSource, character, getSceneContext }) => {
    const { apiConfig } = useOS();
    const [state, setState] = useState<SceneCameraSessionState>(INITIAL_SCENE_CAMERA_SESSION_STATE);
    const [rendererConfig, setRendererConfig] = useState<ImageGenerationConfig | undefined>(() => (typeof window === 'undefined' ? undefined : loadImageGenerationConfig()));
    const [showViewer, setShowViewer] = useState(false);
    const sessionRef = useRef<SceneCameraSession | null>(null);
    const characterRef = useRef(character);
    characterRef.current = character;
    const sceneContextRef = useRef(getSceneContext);
    sceneContextRef.current = getSceneContext;
    const apiConfigRef = useRef(apiConfig);
    apiConfigRef.current = apiConfig;

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
            debug: import.meta.env.DEV,
        });
        sessionRef.current = session;
        const unsubscribe = session.subscribe(() => setState(session.getState()));
        const config = loadImageGenerationConfig();
        setRendererConfig(config);
        // 宽高比默认读取现有生图配置，不维护第二套全局默认值。
        session.setAspectRatio(config.defaultAspectRatio);
        setState(session.getState());
        return () => {
            unsubscribe();
            session.reset();
            sessionRef.current = null;
            setShowViewer(false);
        };
    }, [open]);

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

                {/* 主操作 */}
                <button
                    type="button"
                    disabled={busy || !directorReady || !isRendererReady}
                    onClick={handleGenerate}
                    className="mt-4 h-12 w-full rounded-2xl bg-white text-[14px] font-bold text-slate-900 transition-transform active:scale-95 disabled:opacity-40"
                >
                    {busy ? (state.phase === 'directing' ? '正在理解这一幕……' : '摄影机正在成像……') : '生成这一幕'}
                </button>
                {!isRendererReady && <p className="mt-2 text-center text-[10px] text-white/40">需要先在「设置 → 生图 API」启用生图服务</p>}

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
