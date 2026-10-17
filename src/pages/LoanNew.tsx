import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type Page } from '../api/client';
import { Button, Card, Checkbox, ErrorBox, PageHeader, SelectInput, TextArea, TextInput } from '../components/ui';
import { AvailablePicker, MusicianPicker, type MusicianLite, type PickedLine } from '../components/pickers';
import { addDays, fmtDate, todayIso } from '../lib/format';
import { useItemTypes, useSafeMutation, type ItemType } from '../lib/hooks';

export default function LoanNew() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const types = useItemTypes();
  const events = useQuery({ queryKey: ['events', 'open'], queryFn: () => api.get<Page<any>>('/events', { pageSize: 200 }) });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ settings: Record<string, number> }>('/settings') });
  const openEvents = (events.data?.items ?? []).filter((e) => !['encerrada', 'cancelada'].includes(e.status));
  const [eventId, setEventId] = useState(sp.get('festa') ?? '');
  const ev = openEvents.find((e) => e.id === eventId);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [musician, setMusician] = useState<MusicianLite | null>(null);
  const [nm, setNm] = useState({ fullName: '', contact: '', originBand: '' });
  const [confirmDup, setConfirmDup] = useState(false);
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<PickedLine[]>([]);
  const [typeId, setTypeId] = useState('');
  const [picker, setPicker] = useState<ItemType | null>(null);

  useEffect(() => {
    if (ev && !dueDate) setDueDate(addDays(ev.end_date ?? ev.start_date, settings.data?.settings['loans.default_due_days'] ?? 3));
  }, [ev, dueDate, settings.data]);

  const m = useSafeMutation(
    (_: void, key: string) =>
      api.post<{ id: string }>(
        '/loans',
        {
          eventId,
          musicianId: mode === 'existing' ? musician?.id : null,
          newMusician: mode === 'new' ? { ...nm, kind: 'convidado', contact: nm.contact || null, originBand: nm.originBand || null, confirmDuplicate: confirmDup || undefined } : undefined,
          dueDate: dueDate || null,
          notes: notes || null,
          lines: lines.map((l) => ({ itemTypeId: l.itemTypeId, garmentId: l.garmentId ?? null, bucketKey: l.bucketKey ?? null, quantity: l.quantity })),
        },
        { idempotencyKey: key },
      ),
    { onSuccess: (r) => nav(`/emprestimos/${r.id}`), invalidate: [['loans'], ['event'], ['events'], ['available'], ['dashboard'], ['alerts'], ['musicians']] },
  );
  const isDup = m.error instanceof ApiError && m.error.code === 'POSSIVEL_DUPLICADO';
  const ready = eventId && lines.length && (mode === 'existing' ? musician : nm.fullName.trim().length > 1) && (!isDup || confirmDup);

  return (
    <div>
      <PageHeader back={{ to: '/emprestimos', label: 'Empréstimos' }} title="Novo empréstimo" subtitle="Registe as peças entregues a um músico convidado. Cada peça fica «Emprestada» até ser devolvida." />
      <div className="space-y-4">
        <Card title="1. Festa">
          <SelectInput label="Festa ou atuação" value={eventId} onChange={(e) => { setEventId(e.target.value); setDueDate(''); }} options={openEvents.map((e) => ({ value: e.id, label: `${e.name} — ${fmtDate(e.start_date)}` }))} placeholder="Selecione…" required />
          {!openEvents.length && events.data && <p className="mt-2 text-sm text-slate-500">Não há festas abertas. Crie primeiro a festa em «Festas».</p>}
        </Card>
        <Card title="2. Músico convidado">
          <div className="mb-3 flex gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} /> Já registado</label>
            <label className="flex items-center gap-2"><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> Novo músico convidado</label>
          </div>
          {mode === 'existing' ? (
            <MusicianPicker value={musician} onChange={setMusician} />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <TextInput label="Nome completo" value={nm.fullName} onChange={(e) => setNm({ ...nm, fullName: e.target.value })} required />
              <TextInput label="Contacto" value={nm.contact} onChange={(e) => setNm({ ...nm, contact: e.target.value })} />
              <TextInput label="Banda de origem" value={nm.originBand} onChange={(e) => setNm({ ...nm, originBand: e.target.value })} />
            </div>
          )}
        </Card>
        <Card title="3. Peças a emprestar">
          <div className="flex flex-wrap items-end gap-2">
            <SelectInput className="min-w-56" label="Tipo de artigo" value={typeId} onChange={(e) => setTypeId(e.target.value)} options={types.active.filter((t) => t.stock_enabled).map((t) => ({ value: t.id, label: t.name }))} placeholder="Selecione…" />
            <Button variant="secondary" disabled={!typeId} onClick={() => setPicker(types.byId[typeId])}>
              Escolher do stock disponível
            </Button>
          </div>
          {lines.length > 0 && (
            <ul className="mt-3 divide-y text-sm">
              {lines.map((l, i) => (
                <li key={i} className="flex justify-between py-1.5">
                  <span>
                    {l.quantity} × {l.itemTypeName} — {l.label}
                  </span>
                  <button className="text-red-700 underline" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remover</button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="4. Confirmação">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextInput label="Data prevista de devolução" type="date" min={todayIso()} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            <TextArea className="sm:col-span-2" label="Observações" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="mt-3 space-y-2">
            <ErrorBox error={m.error} />
            {isDup && <Checkbox label="Confirmo que é uma pessoa diferente das indicadas" checked={confirmDup} onChange={setConfirmDup} />}
          </div>
          <div className="mt-3 flex justify-end">
            <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!ready}>
              Registar empréstimo ({lines.reduce((a, l) => a + l.quantity, 0)} peça(s))
            </Button>
          </div>
        </Card>
      </div>
      {picker && <AvailablePicker open type={picker} exclude={lines} onClose={() => setPicker(null)} onPick={(ls) => setLines([...lines, ...ls])} />}
    </div>
  );
}
