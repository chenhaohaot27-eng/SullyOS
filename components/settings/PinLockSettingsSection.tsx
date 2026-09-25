import React, { useState, useEffect, useCallback } from 'react';
import Modal from '../os/Modal';
import PinPad from '../os/PinPad';
import {
    isPinLockEnabled,
    setupPinLock,
    changePinLock,
    disablePinLock,
    verifyPin,
} from '../../utils/pinLock';

/**
 * PinLockSettingsSection：设置 → 隐私与安全 → 锁屏密码。
 *
 * - 未开启：提供「开启锁屏密码」（输入新密码 + 再次确认，两次一致才生效）。
 * - 已开启：显示状态，提供「修改密码」（先验当前密码）与「关闭锁屏密码」（先验当前密码）。
 * - 全部本地验证，不调用任何 API；开启时明确提示密码仅存本机、忘记需清数据。
 */

type Flow = 'none' | 'enable' | 'change' | 'disable';

const LockIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={className ?? 'w-4 h-4'}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
    </svg>
);

/** 弹窗里的一段密码输入（标题 + 键盘 + 错误文案）。onSubmit 返回 false 时由 PinPad 晃动。 */
const PinEntryStep: React.FC<{
    title: string;
    errorText: string;
    busy: boolean;
    onSubmit: (pin: string) => Promise<boolean>;
}> = ({ title, errorText, busy, onSubmit }) => (
    <div>
        <p className="text-center text-sm font-semibold text-slate-600 mb-4">{title}</p>
        <PinPad variant="light" onSubmit={onSubmit} busy={busy} />
        <div className="h-5 mt-3 text-center text-xs font-medium text-rose-500">{errorText}</div>
    </div>
);

const PinLockSettingsSection: React.FC = () => {
    const [enabled, setEnabled] = useState(false);
    const [flow, setFlow] = useState<Flow>('none');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    // 修改/开启流程的多步暂存：旧密码、第一次输入的新密码。
    const [stagedOldPin, setStagedOldPin] = useState('');
    const [stagedNewPin, setStagedNewPin] = useState('');

    const refresh = useCallback(() => setEnabled(isPinLockEnabled()), []);
    useEffect(refresh, [refresh]);

    const closeModal = () => {
        if (busy) return;
        setFlow('none');
        setError('');
        setStagedOldPin('');
        setStagedNewPin('');
    };

    const handleEnableStep = async (pin: string): Promise<boolean> => {
        if (!stagedNewPin) {
            setStagedNewPin(pin);
            setError('');
            return true; // 通过第一步：清空键盘进入确认步骤
        }
        setBusy(true);
        try {
            const result = await setupPinLock(stagedNewPin, pin);
            if (result.ok) {
                setEnabled(true);
                closeModal();
                return true;
            }
            // 确认失败（不一致等）：退回第一步重输。
            setError(result.error);
            setStagedNewPin('');
            return false;
        } finally {
            setBusy(false);
        }
    };

    const handleChangeStep = async (pin: string): Promise<boolean> => {
        if (!stagedOldPin) {
            setBusy(true);
            try {
                const ok = await verifyPin(pin);
                if (!ok) {
                    setError('当前密码错误');
                    return false;
                }
                setStagedOldPin(pin);
                setError('');
                return true;
            } finally {
                setBusy(false);
            }
        }
        if (!stagedNewPin) {
            setStagedNewPin(pin);
            setError('');
            return true;
        }
        setBusy(true);
        try {
            const result = await changePinLock(stagedOldPin, stagedNewPin, pin);
            if (result.ok) {
                closeModal();
                return true;
            }
            setError(result.error);
            if (result.error === '当前密码错误') {
                setStagedOldPin('');
                setStagedNewPin('');
            } else {
                setStagedNewPin('');
            }
            return false;
        } finally {
            setBusy(false);
        }
    };

    const handleDisableStep = async (pin: string): Promise<boolean> => {
        setBusy(true);
        try {
            const result = await disablePinLock(pin);
            if (result.ok) {
                setEnabled(false);
                closeModal();
                return true;
            }
            setError(result.error);
            return false;
        } finally {
            setBusy(false);
        }
    };

    const modalTitle =
        flow === 'enable' ? '开启锁屏密码' : flow === 'change' ? '修改锁屏密码' : '关闭锁屏密码';
    const stepTitle =
        flow === 'enable'
            ? stagedNewPin ? '再次输入以确认新密码' : '输入新的 6 位数字密码'
            : flow === 'change'
                ? stagedOldPin
                    ? stagedNewPin ? '再次输入以确认新密码' : '输入新的 6 位数字密码'
                    : '输入当前密码'
                : '输入当前密码';

    return (
        <>
            <section className="bg-[#fffefe] rounded-3xl p-5 shadow-[0_8px_24px_rgba(15,23,42,0.05)] border border-slate-200/80">
                <div className="flex items-center justify-between gap-2 mb-3">
                    <div className="flex items-center gap-2">
                        <div className="p-2 bg-amber-100/60 rounded-xl text-amber-600">
                            <LockIcon />
                        </div>
                        <h2 className="text-sm font-semibold text-slate-600 tracking-wider">隐私与安全</h2>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${enabled ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                        锁屏密码：{enabled ? '已开启' : '未开启'}
                    </span>
                </div>

                <p className="text-xs text-slate-500 leading-relaxed mb-3">
                    开启后，每次退出 Lemuria 再进入（刷新、重开网页 / PWA）都需要输入 6 位数字密码；本次打开期间切换微信、见面、设置等 App 不会重复询问。
                </p>

                <div className="flex flex-col gap-2">
                    {!enabled ? (
                        <button
                            type="button"
                            onClick={() => { setFlow('enable'); setError(''); setStagedNewPin(''); }}
                            className="w-full py-2.5 rounded-xl text-xs font-bold text-white bg-slate-700 active:scale-95 transition-transform"
                        >
                            开启锁屏密码
                        </button>
                    ) : (
                        <>
                            <button
                                type="button"
                                onClick={() => { setFlow('change'); setError(''); setStagedOldPin(''); setStagedNewPin(''); }}
                                className="w-full py-2.5 rounded-xl text-xs font-bold text-slate-700 bg-slate-100 active:scale-95 transition-transform"
                            >
                                修改密码
                            </button>
                            <button
                                type="button"
                                onClick={() => { setFlow('disable'); setError(''); }}
                                className="w-full py-2.5 rounded-xl text-xs font-bold text-rose-500 bg-rose-50 active:scale-95 transition-transform"
                            >
                                关闭锁屏密码
                            </button>
                        </>
                    )}
                </div>

                {!enabled && (
                    <p className="text-[10px] text-slate-400 leading-relaxed mt-3">
                        锁屏密码仅保存在当前设备，请牢记密码。忘记密码后可能需要清除 Lemuria 本地数据才能重新进入。
                    </p>
                )}
            </section>

            <Modal isOpen={flow !== 'none'} title={modalTitle} onClose={closeModal}>
                <PinEntryStep
                    title={stepTitle}
                    errorText={error}
                    busy={busy}
                    onSubmit={flow === 'enable' ? handleEnableStep : flow === 'change' ? handleChangeStep : handleDisableStep}
                />
            </Modal>
        </>
    );
};

export default PinLockSettingsSection;
