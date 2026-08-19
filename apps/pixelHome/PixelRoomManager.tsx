import React, { useMemo, useState } from 'react';
import type { PixelRoomMetadata } from './types';
import { PixelRoomDB } from './pixelHomeDb';

interface Props {
  charId: string;
  rooms: PixelRoomMetadata[];
  onChanged: () => Promise<void>;
  onEnterRoom: (roomId: string) => void;
  addToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const PixelRoomManager: React.FC<Props> = ({ charId, rooms, onChanged, onEnterRoom, addToast }) => {
  const orderedRooms = useMemo(() => [...rooms].sort((a, b) => a.order - b.order), [rooms]);
  const [newName, setNewName] = useState('');
  const [newWidth, setNewWidth] = useState(6);
  const [newHeight, setNewHeight] = useState(5);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      await onChanged();
    } catch (error: any) {
      addToast?.(error?.message || '房间操作失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const addRoom = () => run(async () => {
    await PixelRoomDB.addRoom(charId, { name: newName.trim() || '新房间', width: newWidth, height: newHeight });
    setNewName('');
    addToast?.('房间已新增', 'success');
  });

  const saveRename = (roomId: string) => run(async () => {
    const renamed = await PixelRoomDB.renameRoom(charId, roomId, editingName);
    if (!renamed) throw new Error('房间名称不能为空');
    setEditingId(null);
    addToast?.('房间已重命名', 'success');
  });

  const removeRoom = (room: PixelRoomMetadata) => {
    if (orderedRooms.length <= 1) {
      addToast?.('至少保留一个房间', 'info');
      return;
    }
    if (!window.confirm(`删除「${room.name}」？其中的家具布局也会一并删除。`)) return;
    run(async () => {
      const removed = await PixelRoomDB.deleteRoom(charId, room.id);
      if (!removed) throw new Error('房间删除失败');
      addToast?.('房间已删除', 'success');
    });
  };

  const moveRoom = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= orderedRooms.length) return;
    const next = orderedRooms.map(room => room.id);
    [next[index], next[target]] = [next[target], next[index]];
    run(async () => {
      const reordered = await PixelRoomDB.reorderRooms(charId, next);
      if (!reordered) throw new Error('房间排序失败');
    });
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-4 text-slate-200">
      <div className="mx-auto max-w-lg space-y-4 pb-8">
        <section className="rounded-2xl border border-slate-700 bg-slate-800/70 p-3 space-y-3">
          <div>
            <h2 className="text-sm font-bold">新增房间</h2>
            <p className="mt-1 text-[11px] text-slate-400">房间按当前角色单独保存，尺寸为编辑画布的格子数。</p>
          </div>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="房间名称"
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-amber-500" />
          <div className="flex items-center gap-2">
            <label className="flex-1 text-[11px] text-slate-400">宽
              <input type="number" min={2} max={20} value={newWidth} onChange={e => setNewWidth(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 py-2 text-sm text-slate-200" />
            </label>
            <label className="flex-1 text-[11px] text-slate-400">高
              <input type="number" min={2} max={20} value={newHeight} onChange={e => setNewHeight(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 py-2 text-sm text-slate-200" />
            </label>
            <button disabled={busy} onClick={addRoom}
              className="self-end rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">新增</button>
          </div>
        </section>

        <section className="space-y-2">
          {orderedRooms.map((room, index) => (
            <div key={room.id} className="rounded-xl border border-slate-700 bg-slate-800/70 p-3">
              <div className="flex items-center gap-2">
                <span className="w-6 shrink-0 text-center text-xs text-slate-500">{index + 1}</span>
                {editingId === room.id ? (
                  <input autoFocus value={editingName} onChange={e => setEditingName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveRename(room.id); }}
                    className="min-w-0 flex-1 rounded border border-amber-500 bg-slate-900 px-2 py-1 text-sm" />
                ) : (
                  <button className="min-w-0 flex-1 text-left" onClick={() => onEnterRoom(room.id)}>
                    <span className="block truncate text-sm font-bold">{room.name}</span>
                    <span className="text-[10px] text-slate-500">{room.width} × {room.height}</span>
                  </button>
                )}
                {editingId === room.id ? (
                  <>
                    <button disabled={busy} onClick={() => saveRename(room.id)} className="text-xs text-emerald-400">保存</button>
                    <button onClick={() => setEditingId(null)} className="text-xs text-slate-400">取消</button>
                  </>
                ) : (
                  <button onClick={() => { setEditingId(room.id); setEditingName(room.name); }} className="text-xs text-sky-400">改名</button>
                )}
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <button disabled={busy || index === 0} onClick={() => moveRoom(index, -1)} className="rounded bg-slate-700 px-2 py-1 text-[11px] disabled:opacity-30">上移</button>
                <button disabled={busy || index === orderedRooms.length - 1} onClick={() => moveRoom(index, 1)} className="rounded bg-slate-700 px-2 py-1 text-[11px] disabled:opacity-30">下移</button>
                <button disabled={busy || orderedRooms.length <= 1} onClick={() => removeRoom(room)} className="rounded bg-red-950/70 px-2 py-1 text-[11px] text-red-300 disabled:opacity-30">删除</button>
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
};

export default PixelRoomManager;
