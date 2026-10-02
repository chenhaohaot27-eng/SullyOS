import type { LivingWorldState } from '../../types';
import { ensureLivingWorldState, saveLivingWorldState } from './store';

export type LivingWorldTickSource = 'foreground' | 'manual' | 'cloud';

export interface LivingWorldTickContext {
    worldId: string;
}

export interface LivingWorldTickResult {
    state: LivingWorldState;
    didAdvance: false;
}

const VALID_SOURCES: LivingWorldTickSource[] = ['foreground', 'manual', 'cloud'];

export async function worldTick(
    now: Date,
    source: LivingWorldTickSource,
    context?: LivingWorldTickContext,
): Promise<LivingWorldTickResult> {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('Living World tick requires a valid Date');
    }
    if (!VALID_SOURCES.includes(source)) {
        throw new Error(`Unsupported Living World tick source: ${source}`);
    }
    if (!context?.worldId?.trim()) {
        throw new Error('Living World tick requires context.worldId');
    }

    const state = await ensureLivingWorldState(context.worldId);
    const next: LivingWorldState = {
        ...state,
        lastTickAt: now.getTime(),
        updatedAt: Date.now(),
    };
    await saveLivingWorldState(next);

    return { state: next, didAdvance: false };
}
