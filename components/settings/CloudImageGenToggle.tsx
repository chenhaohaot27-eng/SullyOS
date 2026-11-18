import React, { useCallback, useEffect, useState } from 'react';
import {
    loadCloudImageGenConfig,
    saveCloudImageGenConfig,
    probeCloudImageGenCapability,
} from '../../utils/cloudImageGen';

/**
 * S2：设置 → 生图的「云端后台生成」开关。
 * 开启条件：主动消息 2.0 已连接 + Worker 是新版（imageGen 能力）+ 已配置访问口令。
 * 任一不满足 → 开关置灰并说明缺什么；关闭时维持浏览器直接生图（既有行为）。
 */
const CloudImageGenToggle: React.FC = () => {
    const [enabled, setEnabled] = useState(() => loadCloudImageGenConfig().enabled);
    const [probe, setProbe] = useState<
        { ok: true; storage: 'r2' | 'd1' } | { ok: false; reason: 'not-connected' | 'unsupported' | 'unauthenticated' | 'unreachable' } | null
    >(null);
    const [probing, setProbing] = useState(false);

    const runProbe = useCallback(async () => {
        setProbing(true);
        try {
            setProbe(await probeCloudImageGenCapability());
        } finally {
            setProbing(false);
        }
    }, []);

    useEffect(() => {
        void runProbe();
    }, [runProbe]);

    const blockedReason = probe && !probe.ok
        ? (probe.reason === 'not-connected' ? '未连接主动消息 2.0 Worker——先去「主动消息 2.0」一键部署并连接'
            : probe.reason === 'unauthenticated' ? 'Worker 要求访问口令：请在「主动消息 2.0」设置里配好 AMSG_SERVER_TOKEN'
                : probe.reason === 'unsupported' ? 'Worker 是旧版本：在「主动消息 2.0」设置里点「更新后端」后再开'
                    : '暂时探测不到 Worker（网络或地址问题），稍后重试')
        : null;

    const canEnable = probe?.ok === true;

    const handleToggle = () => {
        if (!canEnable) {
            void runProbe();
            return;
        }
        const next = !enabled;
        setEnabled(next);
        saveCloudImageGenConfig({ enabled: next });
    };

    return (
        <div className="rounded-2xl border border-slate-100 bg-white/60 p-3.5">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <div className="text-xs font-bold text-slate-600">云端后台生成</div>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                        提交到自己的主动消息 2.0 Worker 执行：切 App、锁屏甚至关掉页面后云端继续生成，
                        回来按任务自动补收。关闭则维持浏览器直接生图（现状不变）。
                    </p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    disabled={!canEnable}
                    onClick={handleToggle}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                        enabled ? 'bg-fuchsia-500' : canEnable ? 'bg-slate-200' : 'bg-slate-100 opacity-50'
                    }`}
                >
                    <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
                {probing
                    ? '正在检测 Worker 能力…'
                    : canEnable
                        ? `Worker 已就绪（结果存储：${probe.storage === 'r2' ? 'R2 私有桶' : 'D1（≤900KB 小图；建议绑定 R2）'}）。API Key 只加密存到你自己的 Worker，不进日志与 URL。`
                        : blockedReason}
            </p>
            {!canEnable && !probing && (
                <button type="button" onClick={() => void runProbe()} className="mt-1.5 px-2 py-1 rounded-lg bg-slate-100 text-[10px] font-bold text-slate-600 active:scale-95 transition-transform">
                    重新检测
                </button>
            )}
        </div>
    );
};

export default CloudImageGenToggle;
