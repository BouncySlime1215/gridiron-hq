import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Drafts from './Drafts';
import LiveDraft from './LiveDraft';
import { PageHeader } from '../components/ui/DesignSystem';

type View = 'mock' | 'live' | 'recap';
export default function DraftHub() {
  const [params] = useSearchParams();
  const requested = params.get('view');
  const [view, setView] = useState<View>(requested === 'live' || requested === 'recap' ? requested : 'mock');
  return <div>
    <PageHeader eyebrow="Fantasy" title="Draft" description="Mock preparation, live ESPN tracking and completed draft recaps live in one workflow." />
    <div role="tablist" aria-label="Draft modes" className="mb-5 flex gap-1 border-b border-slate-200">
      {([['mock','Mock & boards'],['live','Live'],['recap','Recaps']] as const).map(([id,label]) => <button key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)} className={`border-b-2 px-3 py-2 text-sm font-semibold ${view === id ? 'border-emerald-600 text-emerald-800' : 'border-transparent text-slate-500'}`}>{label}</button>)}
    </div>
    {view === 'live' ? <LiveDraft /> : <Drafts />}
  </div>;
}
