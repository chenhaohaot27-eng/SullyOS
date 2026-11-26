import { publicMessageText, readReply } from './replyBoundary';
import { extractAvatarPerformanceTimeline, type AvatarPerformanceCue, type AvatarPerformanceDirection } from './avatarPerformance';

export interface ParsedCallReply {
  text: string;
  thinkingChain?: string;
  /** 第一条演出指令（立即生效）。 */
  performance?: AvatarPerformanceDirection;
  /** 完整演出时间轴：正文中穿插的所有指令，按位置比例调度。 */
  performanceCues?: AvatarPerformanceCue[];
}

export const stripCallTextFormatting = (raw: string): string => (raw || '')
  .replace(/```(?:[a-z0-9_-]+)?\s*/gi, '')
  .replace(/```/g, '')
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]*\)/g, '$1')
  .replace(/^(?:\s{0,3}#{1,6}\s+|\s{0,3}>\s?|\s*[-+*]\s+)/gm, '')
  .replace(/(\*\*|__)([\s\S]*?)\1/g, '$2')
  .replace(/([*_~`])([^\n]*?)\1/g, '$2')
  .replace(/[\t ]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export const parseCallAssistantMessage = (message: any, _keepThinking = false): ParsedCallReply => {
  const { text, cues } = extractAvatarPerformanceTimeline(readReply(publicMessageText(message)));
  return { text, ...(cues.length ? { performance: cues[0].direction, performanceCues: cues } : {}) };
};
