/**
 * 聊天语音条：什么时候合成、合成完要不要立刻响。
 *
 * 一句话版本：合法 AI 语音只要功能与 TTS 都可用就提前合成；
 * 「收到就自动播放」只决定合成完成后要不要立即响。
 */

/**
 * AI 消息到达后要不要顺手把语音合成出来。
 *
 * 生成和播放必须解耦：关闭自动播放时仍提前生成，让用户第一次点击语音条即可播放。
 */
export function shouldAutoGenerateVoice(opts: {
  voiceEnabled?: boolean;
  hasVoiceTag?: boolean;
  ttsReady?: boolean;
  hasVoiceData?: boolean;
  loading?: boolean;
  failed?: boolean;
}): boolean {
  return !!opts.voiceEnabled
    && !!opts.hasVoiceTag
    && !!opts.ttsReady
    && !opts.hasVoiceData
    && !opts.loading
    && !opts.failed;
}

/**
 * 语音合成完要不要立刻响。两条规则各有来由，别合并简化：
 *  - AI 自动生成的语音，是否立即播放只跟「收到就自动播放」走。
 *  - 用户主动要的语音（长按「转换语音」、点尚未生成的 fallback 语音条），无论开关怎么设都播——
 *    他点这一下的意思就是「我现在要听」，还要再点一次播放属于白跑一趟。
 */
export function shouldAutoPlayGeneratedVoice(opts: {
  /** 这次合成是 AI 消息到达后自动触发的（false = 用户主动点的） */
  autoTriggered: boolean;
  /** 角色的「收到就自动播放」开关，未设置视作关 */
  autoPlayEnabled?: boolean;
}): boolean {
  if (!opts.autoTriggered) return true;
  return !!opts.autoPlayEnabled;
}
