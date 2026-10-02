import React from 'react';
import type { PixelAsset, PixelHomeState, PixelHomeMapRoom } from './types';
import { displayPixelRoomName } from './roomTemplates';

interface Props {
  homeState: PixelHomeState;
  assets: PixelAsset[];
  userName: string;
  onEnterRoom: (roomId: string) => void;
}

const roomSurface = (room: PixelHomeMapRoom) => {
  if (room.kind === 'outdoor') return 'linear-gradient(150deg, #b7d8bd 0%, #6d987d 100%)';
  if (room.kind === 'terrace') return 'linear-gradient(150deg, #e8f6f6 0%, #79aebb 100%)';
  if (room.kind === 'utility') return 'linear-gradient(150deg, #ddd2c2 0%, #9a8874 100%)';
  return 'linear-gradient(150deg, #fffdf5 0%, #cfdae3 56%, #9babc0 100%)';
};

const previewPosition = (index: number, total: number) => {
  const spread = total <= 1 ? 50 : 18 + (index * 64) / (total - 1);
  const height = index % 2 === 0 ? 63 : 72;
  return { left: `${spread}%`, top: `${height}%` };
};

/**
 * 数据驱动的 pixel dollhouse。房间内容始终来自现有 layout / assets，
 * 这里只负责空间关系与入口，不产生第二份房间数据。
 */
const PixelHomeDollhouse: React.FC<Props> = ({ homeState, assets, userName, onEnterRoom }) => {
  const mapLayout = homeState.mapLayout!;
  const metadata = new Map(homeState.roomMetadata.map(room => [room.id, room]));
  const layouts = new Map(homeState.rooms.map(room => [room.roomId, room]));
  const assetMap = new Map(assets.map(asset => [asset.id, asset]));
  const aspectRatio = `${mapLayout.width} / ${mapLayout.height}`;

  return (
    <div className="relative h-full overflow-y-auto bg-[#071521] px-3 py-4 no-scrollbar">
      <div aria-hidden="true" className={`pointer-events-none absolute opacity-90 ${
        mapLayout.seaEdge === 'top' ? 'inset-x-0 top-0 h-1/4' :
        mapLayout.seaEdge === 'left' ? 'inset-y-0 left-0 w-1/4' :
        mapLayout.seaEdge === 'right' ? 'inset-y-0 right-0 w-1/4' : 'inset-x-0 bottom-0 h-1/4'
      }`} style={{
        background: 'repeating-linear-gradient(175deg, rgba(36,107,139,.9) 0 5px, rgba(91,161,185,.8) 6px 9px, rgba(18,73,105,.9) 10px 15px)',
      }} />

      <div className="relative z-10 mx-auto max-w-3xl">
        <div className="mb-3 rounded-2xl border border-white/10 bg-slate-950/55 px-4 py-3 backdrop-blur-sm">
          <p className="text-[10px] font-black uppercase tracking-[0.26em] text-cyan-200/70">Dollhouse</p>
          <h2 className="mt-1 text-base font-black text-white">{mapLayout.title || '整屋总览'}</h2>
          {mapLayout.subtitle && <p className="mt-1 text-[11px] text-slate-300/75">{mapLayout.subtitle}</p>}
        </div>

        <div className="overflow-auto rounded-3xl border-4 border-slate-950/80 bg-slate-900/75 p-2 shadow-2xl shadow-cyan-950/60">
          <div data-dollhouse-map className="relative min-w-[330px] overflow-hidden rounded-2xl" style={{ aspectRatio }}>
            <div aria-hidden="true" className="absolute inset-0 opacity-60" style={{
              backgroundImage: 'linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px)',
              backgroundSize: '16px 16px',
            }} />

            {mapLayout.rooms.map(room => {
              const roomMeta = metadata.get(room.roomId);
              if (!roomMeta) return null;
              const roomLayout = layouts.get(room.roomId);
              const configured = (room.previewAssetIds || []).map(id => assetMap.get(id)).filter((asset): asset is PixelAsset => !!asset);
              const automatic = (roomLayout?.furniture || [])
                .map(furniture => furniture.assetId ? assetMap.get(furniture.assetId) : undefined)
                .filter((asset): asset is PixelAsset => !!asset);
              const previews = (configured.length > 0 ? configured : automatic).slice(0, 6);
              const left = (room.x / mapLayout.width) * 100;
              const top = (room.y / mapLayout.height) * 100;
              const width = (room.width / mapLayout.width) * 100;
              const height = (room.height / mapLayout.height) * 100;
              const borderRadius = room.shape === 'dome' ? '48% 48% 12px 12px' : '10px';

              return (
                <button
                  key={room.roomId}
                  type="button"
                  data-dollhouse-room={room.roomId}
                  onClick={() => onEnterRoom(room.roomId)}
                  className="group absolute overflow-hidden border-[3px] border-slate-950/80 text-left shadow-[inset_2px_2px_0_rgba(255,255,255,.42),4px_5px_0_rgba(3,12,24,.6)] transition active:scale-[0.98]"
                  style={{
                    left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%`,
                    borderRadius,
                    borderColor: room.accent || undefined,
                    background: roomSurface(room),
                  }}
                >
                  <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[32%] border-b border-slate-700/20 bg-white/20" />
                  {room.shape === 'dome' && (
                    <span aria-hidden="true" className="absolute inset-x-[10%] top-[5%] h-[38%] rounded-[50%_50%_35%_35%] border border-cyan-100/60 bg-[radial-gradient(circle_at_65%_25%,#fff_0_1px,transparent_2px),radial-gradient(circle_at_25%_55%,#b7d9ff_0_1px,transparent_2px),linear-gradient(155deg,#243155,#594f83)] bg-[length:23px_19px,31px_29px,auto]" />
                  )}
                  {previews.map((asset, index) => {
                    const position = previewPosition(index, previews.length);
                    return (
                      <img
                        key={`${room.roomId}-${asset.id}-${index}`}
                        src={asset.pixelImage}
                        alt=""
                        className="absolute z-10 max-h-[52%] max-w-[24%] -translate-x-1/2 -translate-y-1/2 object-contain drop-shadow-md"
                        style={{ ...position, imageRendering: 'pixelated' }}
                        draggable={false}
                      />
                    );
                  })}
                  <span className="absolute inset-x-1 bottom-1 z-20 rounded-md bg-slate-950/72 px-1.5 py-1 text-center text-[7px] font-black leading-tight text-white shadow-sm sm:text-[9px]">
                    {displayPixelRoomName(roomMeta, userName)}
                  </span>
                  {room.level && room.level > 1 && (
                    <span className="absolute left-1 top-1 z-20 rounded bg-indigo-950/75 px-1 py-0.5 text-[6px] font-black text-indigo-100">L{room.level}</span>
                  )}
                  <span aria-hidden="true" className="absolute inset-0 z-30 bg-white/0 transition group-hover:bg-white/10" />
                </button>
              );
            })}
          </div>
        </div>
        <p className="mt-3 text-center text-[10px] font-medium tracking-wide text-cyan-100/60">点击空间进入房间</p>
      </div>
    </div>
  );
};

export default PixelHomeDollhouse;
