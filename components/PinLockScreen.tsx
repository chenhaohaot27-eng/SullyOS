import React, { useState } from 'react';
import PinPad from './os/PinPad';
import { verifyPin } from '../utils/pinLock';

/**
 * PinLockScreen：开启锁屏密码后挡在滑动锁屏之前的密码门。
 *
 * 触发时机：仅「密码已开启 + 本次页面会话尚未解锁」（见 PhoneShell 的 pinGateActive）。
 * 刷新 / 关标签重开 / PWA 重进都是新会话 → 重新验证；会话内解锁后不再出现。
 *
 * 两段式：先展示壁纸 + 大号时间 / 日期 / 锁形图标 + 提示文案，
 * 点击任意处进入数字密码界面；输满 6 位自动验证，无需确认按钮。
 * 密码错误：圆点晃动 + 清空 + 「密码错误，请重试」。不提供任何绕过入口。
 */
const PinLockScreen: React.FC<{
    /** 壁纸（优先锁屏壁纸，回落桌面壁纸），与原有滑动锁屏一致。 */
    lockWallpaperValue: string;
    contentColor: string;
    hours: number;
    minutes: number;
    onUnlocked: () => void;
}> = ({ lockWallpaperValue, contentColor, hours, minutes, onUnlocked }) => {
    const [showPad, setShowPad] = useState(false);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const now = new Date();
    const dateText = `${now.getMonth() + 1}月${now.getDate()}日 星期${'日一二三四五六'[now.getDay()]}`;

    const enterPad = () => {
        // 与原滑动锁屏保持一致：只在本轮权限未定时问一次通知权限，不再纠缠已拒绝的浏览器。
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
        setError('');
        setShowPad(true);
    };

    const handleSubmit = async (pin: string): Promise<boolean> => {
        setBusy(true);
        try {
            const ok = await verifyPin(pin);
            if (ok) {
                onUnlocked();
                return true;
            }
            setError('密码错误，请重试');
            return false;
        } finally {
            setBusy(false);
        }
    };

    return (
        <div
            className="relative w-full h-full bg-cover bg-center overflow-hidden font-light select-none overscroll-none"
            style={{ backgroundImage: lockWallpaperValue, color: contentColor, animation: 'lockReveal 600ms ease-out both' }}
        >
            <style>{`@keyframes lockReveal{from{opacity:0}to{opacity:1}}`}</style>
            <div className="absolute inset-0 bg-black/5 backdrop-blur-[2px]" />

            {!showPad ? (
                <div className="absolute inset-0 cursor-pointer" onClick={enterPad}>
                    {/* 时间与日期 */}
                    <div className="absolute top-24 w-full text-center drop-shadow-[0_2px_4px_rgba(0,0,0,0.3)]">
                        <div className="text-8xl tracking-tighter opacity-95 font-bold">
                            {hours.toString().padStart(2, '0')}<span className="animate-pulse">:</span>{minutes.toString().padStart(2, '0')}
                        </div>
                        <div className="text-base tracking-widest opacity-90 mt-3 text-xs font-bold">{dateText}</div>
                    </div>

                    {/* 锁形图标 + 提示 */}
                    <div className="absolute bottom-16 w-full flex flex-col items-center gap-3 animate-pulse opacity-90 drop-shadow-md">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-7 h-7 opacity-80">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                        </svg>
                        <span className="text-xs tracking-widest font-semibold">输入密码以进入 Lemuria</span>
                        <div className="w-1 h-8 rounded-full bg-gradient-to-b from-transparent to-current" />
                    </div>
                </div>
            ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center px-8 animate-[pinLockFadeIn_0.25s_ease]">
                    <style>{`@keyframes pinLockFadeIn{from{opacity:0}to{opacity:1}}`}</style>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-9 h-9 opacity-80 mb-5 drop-shadow">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                    </svg>
                    <div className="text-sm opacity-90 mb-6 font-medium">输入密码以进入 Lemuria</div>
                    <PinPad variant="dark" onSubmit={handleSubmit} busy={busy} />
                    <div className="h-5 mt-4 text-xs font-medium text-red-300 drop-shadow">
                        {error ? '密码错误，请重试' : ''}
                    </div>
                </div>
            )}
        </div>
    );
};

export default PinLockScreen;
