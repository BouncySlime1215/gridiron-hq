import { useState } from 'react';

export interface QueueablePlayer {
  player_id: number;
  name: string;
  position: string;
  team_abbr?: string | null;
}

interface Props {
  queue: number[];
  players: Map<number, QueueablePlayer>;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRemove: (playerId: number) => void;
}

/** Drag-to-reorder queue list. No DnD library — plain HTML5 drag events, which is all a single-list reorder needs. */
export default function DraftQueue({ queue, players, onReorder, onRemove }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  if (queue.length === 0) {
    return <p className="text-[11px] text-slate-400 p-2">Queue empty — add players from Best Available.</p>;
  }

  return (
    <div className="space-y-1">
      {queue.map((playerId, i) => {
        const p = players.get(playerId);
        return (
          <div
            key={playerId}
            draggable
            onDragStart={() => setDragIndex(i)}
            onDragOver={e => { e.preventDefault(); setOverIndex(i); }}
            onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
            onDrop={e => {
              e.preventDefault();
              if (dragIndex != null && dragIndex !== i) onReorder(dragIndex, i);
              setDragIndex(null); setOverIndex(null);
            }}
            className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 bg-white cursor-grab active:cursor-grabbing
              ${overIndex === i && dragIndex !== null && dragIndex !== i ? 'border-sky-400 bg-sky-50' : 'border-slate-200'}`}
          >
            <span className="text-slate-300 text-xs select-none" aria-hidden>⠿</span>
            <span className="text-[10px] text-slate-400 font-mono w-4 shrink-0">{i + 1}</span>
            {p ? (
              <>
                <span className={`text-[10px] font-black w-6 shrink-0 pos-${p.position}`}>{p.position}</span>
                <span className="text-xs font-medium truncate flex-1 min-w-0">{p.name}</span>
                <span className="text-[10px] text-slate-400 shrink-0">{p.team_abbr}</span>
              </>
            ) : (
              <span className="text-xs text-slate-400 flex-1">player #{playerId}</span>
            )}
            <button
              onClick={() => onRemove(playerId)}
              title="Remove from queue"
              className="shrink-0 text-slate-300 hover:text-rose-500 text-xs px-1">✕</button>
          </div>
        );
      })}
    </div>
  );
}
