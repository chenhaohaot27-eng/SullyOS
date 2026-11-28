export type PhotoSubjects = 'player' | 'character' | 'both' | 'other';

const pair = /(?:(?:我和你|你和我|你我)(?:的合[照影]|一起(?:入镜|自拍|站|坐|看向镜头)|并肩|同框|的照片)|我们(?:俩|两人|的合照|的合影)|咱俩|玩家(?:与|和)角色|角色(?:与|和)玩家|\b(?:you and (?:me|I)|(?:me|I) and you|the two of us|player and (?:the )?character)\b)/i;
const playerPortrait = /(?:这(?:就)?是你(?:本人|啊|呀|当时|那天|小时候|[，。！!？?\s]|$)|(?:回忆|记忆|镜头|画面|照片|相片)里(?:的|是)你|你(?:今天|那天|小时候)?的(?:日常照|生活照|自拍|照片|相片|肖像|样子)|拍(?:下|到|的)你|给你拍的(?:那张照片|这张照片|照片|肖像|日常照|自拍|[，。！!\s]|$)|玩家(?:本人|的?(?:照片|自拍|肖像))|\b(?:portrait|picture|photo|shot) of (?:you|the player)\b|\byour (?:selfie|portrait)\b)/i;
const characterPortrait = /(?:我的(?:自拍|照片|肖像)|我(?:在|的)?自拍|\b(?:my selfie|self-portrait|photo of me)\b)/i;

export function mentionsPlayerPortrait(text: string): boolean {
  return playerPortrait.test(text) || pair.test(text);
}

export function photoSubjects(intent: { prompt: string; caption?: string; includePlayer?: boolean; includeCharacter?: boolean }, playerName?: string, characterName?: string): PhotoSubjects {
  const text = [intent.caption, intent.prompt].filter(Boolean).join('\n');
  const namedInFrame = (name?: string) => {
    if (!name?.trim()) return false;
    const segments = intent.prompt.split(name);
    return segments.slice(1).some(rest => /^(?:本人|正脸|的(?:照片|肖像|自拍)|站在|坐在|看向|穿着|独自)/.test(rest))
      || segments.slice(0, -1).some(before => /(?:主角是|拍摄对象是|镜头中的|portrait of |photo of )$/i.test(before));
  };
  // A subject flag is emitted from the speaker's perspective. In older actions “you” is the recipient.
  const both = pair.test(text) || (!!intent.includeCharacter && intent.includePlayer === true);
  const playerClaim = playerPortrait.test(text) || namedInFrame(playerName)
    || /(?:玩家|the player)\s*(?:站在|坐在|望向|看向|穿着|独自|standing|sitting|wearing)/i.test(intent.prompt);
  const player = intent.includePlayer === true || both || playerClaim;
  const character = both || characterPortrait.test(text) || namedInFrame(characterName)
    || (intent.includeCharacter === true && (!player || intent.includePlayer === true));
  return player ? (character ? 'both' : 'player') : (character ? 'character' : 'other');
}

/** Direct mode has no model to return a cast list. Speaker labels are context, not visible people. */
export function narrativePhotoSubjects(text: string, characterName: string, playerName?: string): PhotoSubjects | undefined {
  const narrative = text.replace(/^[^：:\n]{1,30}[：:]\s*/gm, '');
  if (/空镜|无人入镜|没有人物|不含人物|no people|empty scene/i.test(narrative)) return 'other';
  const player = mentionsPlayerPortrait(narrative) || /(?:玩家|你|我)(?:本人|独自|一个人|站在|坐在|走在|走进|靠在|低头|抬头)|\b(?:the player|player alone)\b/i.test(narrative)
    || (!!playerName && narrative.includes(playerName));
  const character = (!!characterName && narrative.includes(characterName)) || /(?:当前角色)(?:本人|独自|站在|坐在)/.test(narrative);
  if (pair.test(narrative) || (character && player)) return 'both';
  if (player) return 'player';
  if (character) return 'character';
}
