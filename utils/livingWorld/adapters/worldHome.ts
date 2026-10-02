import type { WorldProfile } from '../../../types';
import { DB } from '../../db';

export interface LivingWorldHomeSnapshot {
    worldId: string;
    memberIds: string[];
    npcs: WorldProfile['npcs'];
    houses: WorldProfile['houses'];
    relationships: WorldProfile['relationships'];
    storyClock: number;
    realClock?: WorldProfile['realClock'];
}

export function mapWorldHomeSnapshot(world: WorldProfile): LivingWorldHomeSnapshot {
    return {
        worldId: world.id,
        memberIds: [...world.memberIds],
        npcs: [...world.npcs],
        houses: [...world.houses],
        relationships: [...world.relationships],
        storyClock: world.storyClock,
        realClock: world.realClock ? { ...world.realClock } : undefined,
    };
}

export async function readWorldHomeSnapshot(worldId: string): Promise<LivingWorldHomeSnapshot | null> {
    if (!worldId || !worldId.trim()) throw new Error('WorldHome snapshot requires worldId');
    const world = await DB.getWorld(worldId);
    return world ? mapWorldHomeSnapshot(world) : null;
}
