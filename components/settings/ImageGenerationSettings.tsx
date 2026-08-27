import React, { useEffect, useRef, useState } from 'react';
import type { ImageGenerationAspectRatio, ImageGenerationConfig, ImageGenerationProvider, ImageGenerationResolution } from '../../types';
import {
    clearImageGenerationConfig,
    loadImageGenerationConfig,
    normalizeImageGenerationConfig,
    saveImageGenerationConfig,
} from '../../utils/imageGenerationConfig';
import {
    generatedImageToBlob,
    imageGenerationService,
    ImageGenerationError,
} from '../../utils/imageGenerationService';

interface Props {
    addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const PROVIDER_OPTIONS: Array<{ value: ImageGenerationProvider; label: string; note: string }> = [
    { value: 'gemini-native', label: 'Gemini Native', note: '支持多张参考图' },
    { value: 'openai-images', label: 'OpenAI-compatible Images', note: 'POST /images/generations' },
];

const RESOLUTIONS: ImageGenerationResolution[] = ['1K', '2K', '4K'];
const ASPECT_RATIOS: ImageGenerationAspectRatio[] = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'];

const fieldClass = 'w-full rounded-xl border border-slate-200/70 bg-white/70 px-3.5 py-2.5 text-sm text-slate-700 outline-none transition focus:border-fuchsia-300 focus:bg-white disabled:cursor-not-allowed disabled:opacity-50';

const ImageGenerationSettings: React.FC<Props> = ({ addToast }) => {
    const [savedConfig, setSavedConfig] = useState<ImageGenerationConfig>(() => loadImageGenerationConfig());
    const [draft, setDraft] = useState<ImageGenerationConfig>(() => loadImageGenerationConfig());
    const [showKey, setShowKey] = useState(false);
    const [testing, setTesting] = useState(false);
    const [status, setStatus] = useState('');
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const previewObjectUrlRef = useRef<string | null>(null);

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

    const validate = (config: ImageGenerationConfig): boolean => {
        if (!config.enabled) return true;
        if (!config.baseUrl.trim() || !config.apiKey.trim() || !config.model.trim()) {
            addToast('启用生图 API 前，请填写 Base URL、API Key 和模型', 'error');
            return false;
        }
        try {
            const url = new URL(config.baseUrl);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
        } catch {
            addToast('生图 Base URL 必须是有效的 HTTP(S) 地址', 'error');
            return false;
        }
        return true;
    };

    const save = () => {
        const normalized = normalizeImageGenerationConfig(draft);
        if (!validate(normalized)) return;
        try {
            const saved = saveImageGenerationConfig(normalized);
            setSavedConfig(saved);
            setDraft(saved);
            setStatus(saved.enabled ? '生图 API 配置已保存' : '配置已保存，生图 API 当前关闭');
            addToast('生图 API 配置已保存在本机', 'success');
        } catch {
            addToast('保存失败：当前浏览器无法写入本地存储', 'error');
        }
    };

    const clear = () => {
        try {
            const cleared = clearImageGenerationConfig();
            setSavedConfig(cleared);
            setDraft(cleared);
            setShowKey(false);
            setStatus('生图 API 配置已清除');
            replacePreviewUrl(null);
            addToast('生图 API 配置已清除', 'info');
        } catch {
            addToast('清除失败：当前浏览器无法写入本地存储', 'error');
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

    return (
        <section className="rounded-3xl border border-white/60 bg-white/80 p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-3">
                <div className="rounded-xl bg-fuchsia-100/70 p-2 text-fuchsia-600" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m3 16.5 5.2-5.2a2 2 0 0 1 2.8 0l1.5 1.5 2.2-2.2a2 2 0 0 1 2.8 0L21 14.1M6.75 7.5h.01M5.25 3.75h13.5A2.25 2.25 0 0 1 21 6v12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18V6a2.25 2.25 0 0 1 2.25-2.25Z" />
                    </svg>
                </div>
                <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold tracking-wider text-slate-600">生图 API</h2>
                    <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">独立于聊天与识图 API；未来生图功能统一走服务层。</p>
                </div>
                <span className={`rounded-full px-2 py-1 text-[9px] font-bold ${savedConfig.enabled ? 'bg-fuchsia-100 text-fuchsia-600' : 'bg-slate-100 text-slate-400'}`}>
                    {savedConfig.enabled ? '已启用' : '未启用'}
                </span>
            </div>

            <div className="space-y-4">
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

                <div>
                    <label className="mb-1.5 block pl-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">接口模式</label>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {PROVIDER_OPTIONS.map(option => (
                            <button
                                type="button"
                                key={option.value}
                                onClick={() => patchDraft('provider', option.value)}
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
                    <input className={fieldClass} value={draft.baseUrl} onChange={event => patchDraft('baseUrl', event.target.value)} placeholder={draft.provider === 'gemini-native' ? 'https://generativelanguage.googleapis.com' : 'https://api.openai.com/v1'} />
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
                    <label className="mb-1.5 block pl-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">模型名称</label>
                    <input className={`${fieldClass} font-mono`} value={draft.model} onChange={event => patchDraft('model', event.target.value)} placeholder="gemini-3-pro-image" />
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
                        <p className="mt-0.5 text-[9px] text-slate-400">Gemini Native 最多 5 张；Images 模式会明确报不支持。</p>
                    </div>
                    <input type="checkbox" checked={draft.allowReferenceImages} onChange={event => patchDraft('allowReferenceImages', event.target.checked)} className="h-4 w-4 accent-fuchsia-500" />
                </div>

                <div>
                    <label className="mb-1.5 block pl-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">请求超时（秒）</label>
                    <input className={fieldClass} type="number" min={5} max={300} step={5} value={Math.round(draft.timeoutMs / 1000)} onChange={event => patchDraft('timeoutMs', Number(event.target.value) * 1000)} />
                </div>

                <div className="grid grid-cols-2 gap-2">
                    <button type="button" disabled={testing} onClick={testConnection} className="rounded-2xl border border-fuchsia-200 bg-fuchsia-50 py-3 text-sm font-bold text-fuchsia-600 transition active:scale-95 disabled:opacity-40">
                        {testing ? '生图测试中…' : '🧪 测试生图'}
                    </button>
                    <button type="button" disabled={testing} onClick={save} className="rounded-2xl bg-fuchsia-500 py-3 text-sm font-bold text-white shadow-lg shadow-fuchsia-500/20 transition active:scale-95 disabled:opacity-50">
                        {dirty ? '保存配置' : '已保存'}
                    </button>
                </div>
                <button type="button" disabled={testing} onClick={clear} className="w-full rounded-xl py-2 text-[11px] font-semibold text-rose-500 transition hover:bg-rose-50 disabled:opacity-40">清除配置</button>

                {status && <div className={`rounded-xl px-3 py-2 text-xs leading-relaxed ${status.startsWith('测试失败') ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>{status}</div>}
                {previewUrl && <img src={previewUrl} alt="生图 API 测试预览" className="mx-auto max-h-64 w-auto rounded-2xl border border-fuchsia-100 bg-white object-contain shadow-sm" />}
                <p className="px-1 text-[9px] leading-relaxed text-slate-300">测试会真实调用一次当前生图接口，可能产生费用；自动化测试不会请求真实服务。临时预览关闭或替换时会释放。</p>
            </div>
        </section>
    );
};

export default ImageGenerationSettings;
