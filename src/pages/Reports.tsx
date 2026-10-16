import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, download, type Page } from '../api/client';
import { STATUSES, STATUS_LABELS } from '../../shared/domain';
import { Button, Card, ErrorBox, PageHeader, SelectInput, TextInput } from '../components/ui';
import { MusicianPicker, type MusicianLite } from '../components/pickers';
import { fmtDate } from '../lib/format';
import { useItemTypes, useLocations } from '../lib/hooks';

const DATASETS: { key: string; label: string; desc: string; filters: string[] }[] = [
  { key: 'inventario', label: 'Inventário geral', desc: 'Todas as peças individuais e quantidades, com estado, conservação e localização.', filters: ['itemTypeId', 'status', 'locationId'] },
  { key: 'stock-disponivel', label: 'Stock disponível', desc: 'Apenas o que pode ser entregue ou emprestado.', filters: ['itemTypeId', 'locationId'] },
  { key: 'stock-tipo-tamanho', label: 'Stock por tipo e tamanho', desc: 'Quantidades por estado para cada tipo e tamanho.', filters: ['itemTypeId', 'locationId'] },
  { key: 'musicos', label: 'Fichas de músicos', desc: 'Resumo de necessidades, entregas, devoluções e empréstimos por músico.', filters: [] },
  { key: 'necessidades', label: 'Necessidades', desc: 'Necessidades por músico, com quantidades encomendadas, recebidas e entregues.', filters: ['itemTypeId', 'musicianId', 'pendingOnly'] },
  { key: 'entregas', label: 'Entregas', desc: 'Todas as peças entregues aos músicos.', filters: ['itemTypeId', 'musicianId', 'from', 'to'] },
  { key: 'recolhas', label: 'Recolhas e inspeções', desc: 'Fardamento antigo recebido, estado e destino decidido.', filters: ['itemTypeId', 'musicianId', 'from', 'to', 'pendingOnly'] },
  { key: 'movimentos', label: 'Movimentos', desc: 'Histórico completo de movimentos de stock.', filters: ['itemTypeId', 'from', 'to'] },
  { key: 'emprestimos', label: 'Empréstimos por festa', desc: 'Peças emprestadas, devolvidas e em falta.', filters: ['eventId', 'campaignId', 'musicianId', 'pendingOnly'] },
  { key: 'pendencias', label: 'Pendências de devolução', desc: 'Empréstimos por devolver e fardamento antigo em falta.', filters: ['eventId', 'campaignId', 'musicianId'] },
];

export default function Reports() {
  const types = useItemTypes();
  const locations = useLocations();
  const events = useQuery({ queryKey: ['events', 'all'], queryFn: () => api.get<Page<any>>('/events', { pageSize: 200 }) });
  const campaigns = useQuery({ queryKey: ['campaigns'], queryFn: () => api.get<{ items: any[] }>('/campaigns') });
  const [f, setF] = useState<Record<string, string>>({});
  const [musician, setMusician] = useState<MusicianLite | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);

  async function run(key: string, path: string, query: Record<string, string | undefined>) {
    setBusy(key);
    setErr(null);
    try {
      await download(path, query);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  }
  const queryFor = (allowed: string[]) => {
    const q: Record<string, string | undefined> = {};
    for (const k of allowed) q[k] = k === 'musicianId' ? musician?.id : f[k] || undefined;
    return q;
  };

  return (
    <div>
      <PageHeader title="Relatórios e exportações" subtitle="Exportações com dados reais, respeitando as suas permissões. CSV em UTF-8 com BOM e separador «;» (abre diretamente no Excel em português)." />
      <Card title="Filtros (aplicados aos relatórios que os suportam)" className="mb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SelectInput label="Tipo de artigo" value={f.itemTypeId ?? ''} onChange={(e) => setF({ ...f, itemTypeId: e.target.value })} options={types.items.map((t) => ({ value: t.id, label: t.name }))} placeholder="Todos" />
          <SelectInput label="Estado" value={f.status ?? ''} onChange={(e) => setF({ ...f, status: e.target.value })} options={STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} placeholder="Todos" />
          <SelectInput label="Localização" value={f.locationId ?? ''} onChange={(e) => setF({ ...f, locationId: e.target.value })} options={locations.items.map((l) => ({ value: l.id, label: l.name }))} placeholder="Todas" />
          <SelectInput label="Apenas pendentes" value={f.pendingOnly ?? ''} onChange={(e) => setF({ ...f, pendingOnly: e.target.value })} options={[{ value: '1', label: 'Sim' }]} placeholder="Não" />
          <SelectInput label="Campanha" value={f.campaignId ?? ''} onChange={(e) => setF({ ...f, campaignId: e.target.value })} options={(campaigns.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="Todas" />
          <SelectInput label="Festa" value={f.eventId ?? ''} onChange={(e) => setF({ ...f, eventId: e.target.value })} options={(events.data?.items ?? []).map((e) => ({ value: e.id, label: `${e.name} (${fmtDate(e.start_date)})` }))} placeholder="Todas" />
          <TextInput label="Desde" type="date" value={f.from ?? ''} onChange={(e) => setF({ ...f, from: e.target.value })} />
          <TextInput label="Até" type="date" value={f.to ?? ''} onChange={(e) => setF({ ...f, to: e.target.value })} />
          <div className="sm:col-span-2">
            <MusicianPicker value={musician} onChange={setMusician} label="Músico (opcional)" />
          </div>
        </div>
      </Card>
      <ErrorBox error={err} />
      <div className="grid gap-3 md:grid-cols-2">
        {DATASETS.map((d) => (
          <Card key={d.key} title={d.label}>
            <p className="mb-3 text-sm text-slate-600">{d.desc}</p>
            <div className="flex flex-wrap gap-2">
              {(['csv', 'xlsx', 'pdf'] as const).map((fmt) => (
                <Button key={fmt} size="sm" variant="secondary" loading={busy === `${d.key}-${fmt}`} onClick={() => run(`${d.key}-${fmt}`, `/reports/datasets/${d.key}/${fmt}`, queryFor(d.filters))}>
                  {fmt === 'xlsx' ? 'Excel' : fmt.toUpperCase()}
                </Button>
              ))}
            </div>
          </Card>
        ))}
        <Card title="Livro Excel completo">
          <p className="mb-3 text-sm text-slate-600">Um ficheiro .xlsx com folhas separadas: inventário, stock por tamanho, músicos, necessidades, entregas, recolhas, movimentos, empréstimos e pendências.</p>
          <Button size="sm" loading={busy === 'wb'} onClick={() => run('wb', '/reports/workbook.xlsx', queryFor(['itemTypeId']))}>
            Descarregar livro completo
          </Button>
        </Card>
        <Card title="Documentos individuais">
          <p className="text-sm text-slate-600">
            A ficha individual do músico, a folha de entrega, a folha de recolha e inspeção, a ficha de empréstimo e o relatório de cada festa ou campanha estão disponíveis em PDF na página do respetivo registo.
          </p>
          {musician && (
            <Button className="mt-3" size="sm" variant="secondary" loading={busy === 'ficha'} onClick={() => run('ficha', `/reports/pdf/musician/${musician.id}`, {})}>
              Ficha de {musician.full_name} (PDF)
            </Button>
          )}
        </Card>
      </div>
    </div>
  );
}
