import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download, newIdempotencyKey } from '../api/client';
import { CONDITIONS, CONDITION_LABELS, DESTINATION_LABELS, INSPECTION_DESTINATIONS } from '../../shared/domain';
import { Badge, Button, Card, ConfirmDialog, DefList, ErrorBox, Loading, PageHeader, SelectInput, TextArea } from '../components/ui';
import { ConditionBadge, Photos, StatusBadge } from '../components/domain';
import { fmtDate, fmtDateTime } from '../lib/format';
import { useAuth } from '../lib/auth';
import { useLocations } from '../lib/hooks';

const STATUS = { pendente: 'Por inspecionar', em_curso: 'Inspeção em curso', concluida: 'Concluída' } as Record<string, string>;

export default function ReturnDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const locations = useLocations();
  const q = useQuery({ queryKey: ['return', id], queryFn: () => api.get<{ return: any; lines: any[] }>(`/returns/${id}`) });
  const [forms, setForms] = useState<Record<string, { inspectedCondition: string; inspectionResult: string; destination: string; locationId: string }>>({});
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [openPhotos, setOpenPhotos] = useState<string | null>(null);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const { return: r, lines } = q.data;
  const formOf = (l: any) =>
    forms[l.id] ?? { inspectedCondition: l.inspected_condition ?? l.observed_condition, inspectionResult: l.inspection_result ?? '', destination: l.proposed_destination ?? '', locationId: l.location_id ?? '' };
  const setForm = (l: any, patch: Partial<ReturnType<typeof formOf>>) => setForms({ ...forms, [l.id]: { ...formOf(l), ...patch } });
  const undecided = lines.filter((l) => !l.approved_destination);
  const ready = undecided.filter((l) => formOf(l).destination);

  async function propose(l: any) {
    const f = formOf(l);
    setBusy(l.id);
    setErr(null);
    try {
      await api.post(`/returns/${id}/lines/${l.id}/inspect`, { inspectedCondition: f.inspectedCondition, inspectionResult: f.inspectionResult || null, proposedDestination: f.destination });
      qc.invalidateQueries({ queryKey: ['return', id] });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  }
  async function decide(ids: string[]) {
    setBusy('decide');
    setErr(null);
    try {
      await api.post(
        `/returns/${id}/decisions`,
        {
          decisions: ids.map((lid) => {
            const l = lines.find((x) => x.id === lid);
            const f = formOf(l);
            return { lineId: lid, destination: f.destination, inspectedCondition: f.inspectedCondition, inspectionResult: f.inspectionResult || null, destinationLocationId: f.locationId || null };
          }),
        },
        { idempotencyKey: newIdempotencyKey() },
      );
      setConfirm(null);
      qc.invalidateQueries();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader
        back={{ to: '/recolhas', label: 'Recolhas' }}
        title={`Recolha de ${r.musician_name}`}
        subtitle={<Badge tone={r.inspection_status === 'concluida' ? 'green' : 'amber'}>{STATUS[r.inspection_status]}</Badge>}
        actions={
          <>
            {can('export') && <Button variant="secondary" onClick={() => download(`/reports/pdf/return/${id}`)}>Folha de recolha e inspeção (PDF)</Button>}
            {can('returns.inspect') && ready.length > 0 && <Button onClick={() => setConfirm(ready.map((l) => l.id))}>Aprovar destinos ({ready.length})</Button>}
          </>
        }
      />
      <Card>
        <DefList
          items={[
            ['Músico', <Link className="underline" to={`/musicos/${r.musician_id}`}>{r.musician_name}</Link>],
            ['Data de receção', fmtDate(r.received_at)],
            ['Recebido por', r.received_by_name],
            ['Estado inicial observado', r.initial_observations],
            ['Decisão concluída por', r.decided_by_name ? `${r.decided_by_name} em ${fmtDateTime(r.decided_at)}` : null],
            ['Observações', r.notes],
          ]}
        />
      </Card>
      <div className="mt-4">
        <ErrorBox error={err} />
      </div>
      <div className="mt-4 space-y-3">
        {lines.map((l) => {
          const f = formOf(l);
          const decided = !!l.approved_destination;
          return (
            <Card
              key={l.id}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {l.quantity} × {l.item_type_name} {l.size_label ?? l.size_text ?? ''}
                  {l.garment_code && <Link to={`/inventario/pecas/${l.garment_id}`} className="font-mono text-sm underline">{l.garment_code}</Link>}
                  {l.inscription && <span className="text-sm font-normal">«{l.inscription}»</span>}
                  {l.garment_status && <StatusBadge status={l.garment_status} />}
                </span>
              }
            >
              <p className="mb-2 text-sm">
                Estado observado na receção: <ConditionBadge condition={l.observed_condition} /> {l.location_name && <span className="text-slate-500">· guardado em {l.location_name}</span>}
              </p>
              {decided ? (
                <div className="rounded bg-emerald-50 p-3 text-sm">
                  <p>
                    <strong>Destino aprovado:</strong> {DESTINATION_LABELS[l.approved_destination as 'disponivel']} {l.destination_location_name && `(${l.destination_location_name})`}
                  </p>
                  <p>Estado inspecionado: {CONDITION_LABELS[l.inspected_condition as 'bom']}</p>
                  {l.inspection_result && <p>Resultado: {l.inspection_result}</p>}
                  <p className="text-xs text-slate-600">
                    Proposto por {l.proposed_by_name ?? '—'} · decidido por {l.decided_by_name} em {fmtDateTime(l.decided_at)}
                  </p>
                </div>
              ) : can('returns.inspect') ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                  <SelectInput label="Estado após inspeção" value={f.inspectedCondition} onChange={(e) => setForm(l, { inspectedCondition: e.target.value })} options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))} />
                  <SelectInput label="Destino" value={f.destination} onChange={(e) => setForm(l, { destination: e.target.value })} options={INSPECTION_DESTINATIONS.map((d) => ({ value: d, label: DESTINATION_LABELS[d] }))} placeholder="Selecione…" />
                  <SelectInput label="Localização de destino" value={f.locationId} onChange={(e) => setForm(l, { locationId: e.target.value })} options={locations.active.map((x) => ({ value: x.id, label: x.name }))} placeholder="Sem localização" />
                  <TextArea className="md:col-span-4" label="Resultado da inspeção" rows={2} value={f.inspectionResult} onChange={(e) => setForm(l, { inspectionResult: e.target.value })} hint="Obrigatório para abate ou rejeição." />
                  <div className="flex flex-wrap gap-2 md:col-span-4">
                    <Button variant="secondary" size="sm" disabled={!f.destination} loading={busy === l.id} onClick={() => propose(l)}>
                      Guardar proposta
                    </Button>
                    <Button size="sm" disabled={!f.destination} onClick={() => setConfirm([l.id])}>
                      Aprovar destino
                    </Button>
                    {l.proposed_destination && (
                      <span className="self-center text-xs text-slate-600">
                        Proposta: {DESTINATION_LABELS[l.proposed_destination as 'disponivel']} ({l.proposed_by_name}, {fmtDateTime(l.proposed_at)})
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-amber-800">A aguardar inspeção.</p>
              )}
              <button className="mt-3 text-sm text-marinho-700 underline" onClick={() => setOpenPhotos(openPhotos === l.id ? null : l.id)}>
                {openPhotos === l.id ? 'Ocultar fotografias' : 'Fotografias desta peça'}
              </button>
              {openPhotos === l.id && (
                <div className="mt-2">
                  <Photos entityType="return_line" entityId={l.id} />
                </div>
              )}
            </Card>
          );
        })}
      </div>
      <Card className="mt-4">
        <Photos entityType="return" entityId={id} title="Fotografias da recolha" />
      </Card>
      <ConfirmDialog
        open={!!confirm}
        title="Aprovar destino final"
        message={
          <>
            <p>Os destinos seguintes são definitivos e geram os movimentos de stock correspondentes:</p>
            <ul className="mt-2 list-inside list-disc">
              {confirm?.map((lid) => {
                const l = lines.find((x) => x.id === lid);
                return (
                  <li key={lid}>
                    {l.item_type_name} {l.garment_code ?? ''} → <strong>{DESTINATION_LABELS[formOf(l).destination as 'disponivel']}</strong>
                  </li>
                );
              })}
            </ul>
          </>
        }
        confirmLabel="Aprovar"
        loading={busy === 'decide'}
        error={err}
        onClose={() => setConfirm(null)}
        onConfirm={() => decide(confirm!)}
      />
    </div>
  );
}
