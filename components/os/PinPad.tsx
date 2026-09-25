import React, { useState, useRef, useEffect } from 'react';
import { PIN_LENGTH } from '../../utils/pinLock';

/**
 * PinPad：6 位数字密码的通用输入盘（锁屏页深色 / 设置弹窗浅色两个皮肤）。
 * 输满 6 位自动提交 —— onSubmit 返回 true 表示通过（静默清空，一般由父级关层），
 * 返回 false 表示失败（圆点左右晃动 + 清空，父级负责显示错误文案）。
 * 不需要额外「确认」按钮。
 */
const PinPad: React.FC<{
    onSubmit: (pin: string) => boolean | Promise<boolean>;
    variant?: 'light' | 'dark';
    disabled?: boolean;
    /** 提交期间锁定键盘（异步验证中）。 */
    busy?: boolean;
}> = ({ onSubmit, variant = 'light', disabled = false, busy = false }) => {
    const [digits, setDigits] = useState('');
    const [shake, setShake] = useState(false);
    const submittingRef = useRef(false);
    const shakeTimer = useRef<number | null>(null);

    useEffect(() => () => {
        if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current);
    }, []);

    const triggerShake = () => {
        setShake(true);
        if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current);
        shakeTimer.current = window.setTimeout(() => setShake(false), 500);
    };

    const pushDigit = (d: string) => {
        if (disabled || busy || submittingRef.current) return;
        if (digits.length >= PIN_LENGTH) return;
        const next = digits + d;
        setDigits(next);
        if (next.length === PIN_LENGTH) {
            submittingRef.current = true;
            void Promise.resolve(onSubmit(next))
                .then(ok => {
                    if (!ok) triggerShake();
                })
                .catch(() => triggerShake())
                .finally(() => {
                    submittingRef.current = false;
                    setDigits('');
                });
        }
    };

    const popDigit = () => {
        if (disabled || busy || submittingRef.current) return;
        setDigits(d => d.slice(0, -1));
    };

    const dark = variant === 'dark';
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

    return (
        <div className="select-none">
            {/* 圆点区 */}
            <div
                className={`flex items-center justify-center gap-4 mb-6 ${shake ? 'animate-[pinPadShake_0.4s_ease]' : ''}`}
            >
                <style>{`@keyframes pinPadShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}`}</style>
                {Array.from({ length: PIN_LENGTH }, (_, i) => (
                    <span
                        key={i}
                        className={`w-3.5 h-3.5 rounded-full border transition-all ${
                            dark
                                ? i < digits.length
                                    ? 'bg-white border-white'
                                    : 'bg-white/10 border-white/40'
                                : i < digits.length
                                    ? 'bg-slate-700 border-slate-700'
                                    : 'bg-transparent border-slate-300'
                        }`}
                    />
                ))}
            </div>

            {/* 键盘 */}
            <div className="grid grid-cols-3 gap-3 max-w-[264px] mx-auto">
                {keys.map((k, idx) =>
                    k === '' ? (
                        <div key={`blank-${idx}`} />
                    ) : k === 'del' ? (
                        <button
                            key="del"
                            type="button"
                            onClick={popDigit}
                            disabled={disabled || busy}
                            className={`h-14 rounded-full flex items-center justify-center active:scale-90 transition-transform ${
                                dark ? 'text-white/80' : 'text-slate-500'
                            }`}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" className="w-6 h-6">
                                <path d="M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-3 12.59L17.59 17 14 13.41 10.41 17 9 15.59 12.59 12 9 8.41 10.41 7 14 10.59 17.59 7 19 8.41 15.41 12 19 15.59z" />
                            </svg>
                        </button>
                    ) : (
                        <button
                            key={k}
                            type="button"
                            onClick={() => pushDigit(k)}
                            disabled={disabled || busy}
                            className={`h-14 rounded-full font-light text-2xl flex items-center justify-center active:scale-90 transition-all disabled:opacity-40 ${
                                dark
                                    ? 'bg-white/15 text-white backdrop-blur-sm'
                                    : 'bg-slate-100 text-slate-700'
                            }`}
                        >
                            {k}
                        </button>
                    ),
                )}
            </div>
        </div>
    );
};

export default PinPad;
